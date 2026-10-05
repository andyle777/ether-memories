import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
import { FsDurableStore } from "../src/persistence/FsDurableStore.js";
import { encodeCheckpoint, PERSISTENCE_LIMITS, type PersistedStoreHead } from "../src/persistence/codecs.js";
import { parseTransactionSequenceId } from "../src/utils/durablePersistence.js";
import { encodeSnapshotPayload, decodeSnapshotPayload, decodeCheckpointSnapshotPayload,
  SNAPSHOT_PAYLOAD_PROFILE, hydrateSnapshot } from "../src/persistence/snapshotPayload.js";
import { encodeEtherData, decodeEtherData, ETHER_DATA_PROFILE } from "../src/persistence/etherData.js";
import { referenceFor, validateReference, OBJECT_REFERENCE, digestBytes } from "../src/persistence/payloadObjects.js";
import { productionRegistry } from "../src/persistence/productionOperations.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import { sourceSnapshot } from "./helpers/recovery.js";
import { value } from "./helpers/persistence.js";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

/** Bootstrap a real store around arbitrary checkpoint payload bytes. */
async function bootstrapCheckpoint(payload: Uint8Array) {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-profile-"));
  cleanup.push(parent);
  const directory = join(parent, "store");
  const io = simulatedDirectoryIO();
  const tip = { epochId: "epoch-a", txId: value(parseTransactionSequenceId("9007199254740993")), digest: "0".repeat(64) };
  const checkpoint = value(encodeCheckpoint({ storeId: "store-a", checkpointId: "checkpoint-a", tip }, payload));
  const head: PersistedStoreHead = { format: "ether.store_head", version: "1", storeId: "store-a", epochId: tip.epochId,
    schemaVersion: "ether.memory_store.v0.3", digestAlgorithm: "sha256", checkpoint: checkpoint.identity,
    walFormat: { format: "ether.wal", version: "1" } };
  value(await new FsDurableStore({ directory }, io).initialize({ head, checkpointBytes: checkpoint.bytes }));
  return { parent, directory, io, head, tip };
}

describe("snapshot payload profile versioning", () => {
  it("current production payloads are self-describing on the wire", () => {
    const raw = sourceSnapshot();
    const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
    const payload = value(encodeSnapshotPayload(snapshot));
    const envelope = value(decodeEtherData(payload, false)) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["data", "profile"]);
    expect(envelope.profile).toBe(SNAPSHOT_PAYLOAD_PROFILE);
    // The profile envelope is part of the exact payload size.
    const decoded = value(decodeSnapshotPayload(payload, raw.identity.userId));
    expect(value(encodeSnapshotPayload(decoded))).toEqual(payload);
  });
  it("recovers a legacy plain v0.3 payload through the explicit legacy path", async () => {
    const raw = sourceSnapshot();
    const store = await bootstrapCheckpoint(Buffer.from(JSON.stringify(raw)));
    const runtime = new StartupRecovery(store.directory, raw.identity.userId, store.io);
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(0);
    expect(value(runtime.read()).snapshot.identity.userId).toBe(raw.identity.userId);
    // The published projection is the self-describing production form.
    const projected = value(encodeSnapshotPayload(value(runtime.read()).snapshot));
    expect(decodeSnapshotPayload(projected, raw.identity.userId).ok).toBe(true);
  });
  it("fails closed for an unknown future profile without legacy fallback", () => {
    const raw = sourceSnapshot();
    const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
    const production = value(decodeEtherData(value(encodeSnapshotPayload(snapshot)), false)) as Record<string, unknown>;
    const future = value(encodeEtherData({ profile: "ether.snapshot.payload.v2", data: production.data }));
    expect(decodeSnapshotPayload(future, raw.identity.userId).ok).toBe(false);
    const dispatched = decodeCheckpointSnapshotPayload(future, raw.identity.userId);
    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) expect(dispatched.error.code).toBe("UNSUPPORTED_PERSISTENCE_FORMAT");
  });
  it("fails closed for an unknown future profile during recovery without publication", async () => {
    const raw = sourceSnapshot();
    const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
    const production = value(decodeEtherData(value(encodeSnapshotPayload(snapshot)), false)) as Record<string, unknown>;
    const future = value(encodeEtherData({ profile: "ether.snapshot.payload.v2", data: production.data }));
    const store = await bootstrapCheckpoint(future);
    const runtime = new StartupRecovery(store.directory, raw.identity.userId, store.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
  });
  it.each([
    ["data is not an object", (data: unknown) => ({ profile: SNAPSHOT_PAYLOAD_PROFILE, data: 42 })],
    ["missing data", (data: unknown) => ({ profile: SNAPSHOT_PAYLOAD_PROFILE })],
    ["extra envelope field", (data: unknown) => ({ profile: SNAPSHOT_PAYLOAD_PROFILE, data, extra: 1 })],
    ["missing profile", (data: unknown) => ({ data })]
  ])("fails closed for a malformed profile envelope (%s)", (_name, build) => {
    const raw = sourceSnapshot();
    const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
    const production = value(decodeEtherData(value(encodeSnapshotPayload(snapshot)), false)) as Record<string, unknown>;
    const malformed = value(encodeEtherData(build(production.data)));
    expect(decodeSnapshotPayload(malformed, raw.identity.userId).ok).toBe(false);
    expect(decodeCheckpointSnapshotPayload(malformed, raw.identity.userId).ok).toBe(false);
  });
  it("preserves an explicit empty displayName through recovery; omitted stays omitted", async () => {
    const raw = sourceSnapshot();
    raw.identity.displayName = "";
    const store = await bootstrapCheckpoint(Buffer.from(JSON.stringify(raw)));
    const runtime = new StartupRecovery(store.directory, raw.identity.userId, store.io);
    value(await runtime.recover());
    const read = value(runtime.read());
    // Explicit "" is historical data and must survive recovery as "".
    expect(read.snapshot.identity.displayName).toBe("");
    // Omitted displayName remains absent per frozen semantics.
    const omitted = sourceSnapshot();
    delete omitted.identity.displayName;
    const store2 = await bootstrapCheckpoint(Buffer.from(JSON.stringify(omitted)));
    const runtime2 = new StartupRecovery(store2.directory, omitted.identity.userId, store2.io);
    value(await runtime2.recover());
    expect(value(runtime2.read()).snapshot.identity.displayName).toBeUndefined();
  });
  it("recovers the exact 8,388,608-byte historical v0.3 checkpoint within the production bound", async () => {
    const raw = sourceSnapshot();
    // A fully explicit v0.3 note, exactly as exportData persisted it.
    raw.memoryNotes[0] = { ...raw.memoryNotes[0], content: "", tags: [], metadata: {},
      importance: 0.5, confidence: 0.75, pinned: false, status: "active" };
    const base = Buffer.byteLength(JSON.stringify(raw));
    raw.memoryNotes[0].content = "x".repeat(PERSISTENCE_LIMITS.checkpointPayloadBytes - base);
    const payload = Buffer.from(JSON.stringify(raw));
    expect(payload.byteLength).toBe(8_388_608);
    const store = await bootstrapCheckpoint(payload);
    const runtime = new StartupRecovery(store.directory, raw.identity.userId, store.io);
    value(await runtime.recover());
    const projected = value(encodeSnapshotPayload(value(runtime.read()).snapshot));
    expect(projected.byteLength).toBeLessThanOrEqual(PERSISTENCE_LIMITS.checkpointPayloadBytes);
    expect(decodeSnapshotPayload(projected, raw.identity.userId).ok).toBe(true);
    // Deterministic across fresh recoveries.
    const second = new StartupRecovery(store.directory, raw.identity.userId, store.io);
    value(await second.recover());
    expect(value(encodeSnapshotPayload(value(second.read()).snapshot))).toEqual(projected);
  }, 180_000);
});

describe("payload-object profile versioning", () => {
  it("references unambiguously identify profile, length and digest", () => {
    const bytes = value(encodeEtherData({ content: "object profile" }));
    const reference = referenceFor(bytes);
    expect(Object.keys(reference).sort()).toEqual(["byteLength", "digest", "encoding", "profile"]);
    expect(reference.encoding).toBe(OBJECT_REFERENCE);
    expect(reference.profile).toBe(ETHER_DATA_PROFILE);
    expect(reference.byteLength).toBe(bytes.byteLength);
    expect(reference.digest).toBe(digestBytes(bytes));
    value(validateReference(reference));
  });
  it("fails closed for an unknown object profile before reducer execution", () => {
    const bytes = value(encodeEtherData({ id: "note-x", content: "future profile" }));
    const reference = { ...referenceFor(bytes), profile: "ether.data-json.v2" };
    expect(validateReference(reference).ok).toBe(false);
    // The production registry rejects the operation before any reducer runs.
    const validation = productionRegistry.validate({ type: "ether.note.put", version: "1",
      payload: reference as unknown as Record<string, unknown> });
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.error.code).toBe("UNSUPPORTED_PERSISTENCE_FORMAT");
    expect(productionRegistry.reduce({ memoryNotes: [], diary: [], graph: { nodes: [], edges: [] } } as never,
      { type: "ether.note.put", version: "1", payload: reference as unknown as Record<string, unknown> }).ok).toBe(false);
  });
  it("fails closed for an unknown inline encoding profile before reducer execution", () => {
    const bytes = value(encodeEtherData({ id: "note-inline", content: "inline" }));
    const inline = { encoding: "ether.data-json.v2", data: Buffer.from(bytes).toString("utf8") };
    const validation = productionRegistry.validate({ type: "ether.note.put", version: "1",
      payload: inline as unknown as Record<string, unknown> });
    expect(validation.ok).toBe(false);
  });
});
