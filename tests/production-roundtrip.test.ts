import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { encodeSnapshotPayload, hydrateSnapshot, snapshotData } from "../src/persistence/snapshotPayload.js";
import { reduceProduction, validateCandidate, ProductionWalStore } from "../src/persistence/productionOperations.js";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
import { prepareCoreMutation, intentDigest, validatedCommand, type ProductionMutationCommand } from "../src/persistence/mutationPreparation.js";
import type { JsonObject } from "../src/persistence/walJson.js";
import { value } from "./helpers/persistence.js";
import { bootstrap, mutationId, sourceSnapshot } from "./helpers/recovery.js";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/store-v0.3.json", import.meta.url), "utf8"));
const userId = "fixture-user";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

/**
 * Full semantic roundtrip for one Core mutation:
 * A. detached Core execution (mutation preparation) result;
 * B. preparation -> WAL semantic effects -> deterministic replay.
 * Compares the ENTIRE persisted AFTER snapshots byte-for-byte.
 */
function roundtrip(command: ProductionMutationCommand, rawOverride?: Record<string, unknown>) {
  const raw = rawOverride ?? fixture();
  const base = value(hydrateSnapshot(raw, userId));
  const prepared = value(prepareCoreMutation(base, command));
  let candidate = value(snapshotData(base)) as JsonObject;
  for (const operation of prepared.operations) {
    candidate = value(reduceProduction(candidate, operation.type, operation.payload));
  }
  const replayed = value(validateCandidate(candidate, userId));
  return {
    liveBytes: value(encodeSnapshotPayload(prepared.after)),
    replayBytes: value(encodeSnapshotPayload(replayed)),
    after: prepared.after,
    operations: prepared.operations
  };
}

const graphOf = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8")).data.graph;
const storeFileState = async (directory: string) => {
  const entries: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of await fs.readdir(dir)) {
      const path = join(dir, name);
      const stat = await fs.stat(path);
      if (stat.isDirectory()) await walk(path);
      else entries[path] = createHash("sha256").update(await fs.readFile(path)).digest("hex");
    }
  };
  await walk(directory);
  return entries;
};

describe("detached Core↔WAL semantic roundtrip matrix", { timeout: 30_000 }, () => {
  it("ordinary Note creation", () => {
    const r = roundtrip({ kind: "note.put", input: { content: "Ordinary roundtrip note", summary: "Ordinary", metadata: { key: "value" } } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    expect(r.operations.map(op => op.type)).toContain("ether.note.put");
    // FoundationLinker node effect is captured exactly, not synthesized.
    const noteId = r.after.memoryNotes.find(n => n.content === "Ordinary roundtrip note")!.id;
    expect(r.operations.map(op => op.type)).toContain("ether.graph-node.put");
    const node = graphOf(r.replayBytes).nodes.find((n: any) => n.id === `memory:${noteId}`);
    expect(node).toEqual({ id: `memory:${noteId}`, type: "memory", label: "Ordinary", data: { status: "active" } });
  });
  it("diary-derived Note creation captures the linker's generated edge id exactly", () => {
    const r = roundtrip({ kind: "note.put", input: { content: "Derived from diary", source: "diary",
      provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    const noteId = r.after.memoryNotes.find(n => n.content === "Derived from diary")!.id;
    const edge = graphOf(r.replayBytes).edges.find((e: any) => e.source === `memory:${noteId}` && e.target === "diary:diary-one");
    // The frozen linker generates a random edge id; it is captured once and
    // replayed verbatim, never regenerated.
    expect(edge!.id.startsWith("edge_")).toBe(true);
    expect(edge).toEqual({ id: edge!.id, source: `memory:${noteId}`, target: "diary:diary-one",
      relationship: "derived_from", data: { origin: "foundation_linker",
        cause: { type: "note_created", noteId }, provenanceKind: "diary_extract" } });
    expect(r.operations.some(op => op.type === "ether.graph-edge.put")).toBe(true);
  });
  it("provenance added to an existing Note without collision", () => {
    const r = roundtrip({ kind: "note.update", id: "beta", patch: { provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    const edge = graphOf(r.replayBytes).edges.find((e: any) => e.source === "memory:beta" && e.target === "diary:diary-one");
    expect(edge!.relationship).toBe("derived_from");
    expect(edge!.id.startsWith("edge_")).toBe(true);
  });
  it("Codex reproduction: existing user edge on the same linker endpoints is retained", () => {
    const raw = fixture();
    raw.graph.edges.push({ id: "user-edge-1", source: "memory:alpha", target: "diary:diary-one",
      relationship: "related_to", data: { origin: "user" } });
    const r = roundtrip({ kind: "note.update", id: "alpha", patch: { provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } }, raw);
    expect(r.replayBytes).toEqual(r.liveBytes);
    const graph = graphOf(r.replayBytes);
    // The pre-existing user edge remains exactly as Core retained it.
    expect(graph.edges.find((e: any) => e.id === "user-edge-1"))
      .toEqual({ id: "user-edge-1", source: "memory:alpha", target: "diary:diary-one", relationship: "related_to", data: { origin: "user" } });
    // No synthetic duplicate-endpoint edge was invented.
    expect(graph.edges.some((e: any) => e.id === "derived-alpha")).toBe(false);
    expect(graph.edges.filter((e: any) => e.source === "memory:alpha" && e.target === "diary:diary-one")).toHaveLength(1);
    expect(r.operations.some(op => op.type === "ether.graph-edge.put")).toBe(false);
  });
  it("existing FoundationLinker-style edge on the same endpoints is retained unchanged", () => {
    const raw = fixture();
    raw.graph.edges.push({ id: "derived-alpha", source: "memory:alpha", target: "diary:diary-one",
      relationship: "derived_from", data: { origin: "historical" } });
    const r = roundtrip({ kind: "note.update", id: "alpha", patch: { provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } }, raw);
    expect(r.replayBytes).toEqual(r.liveBytes);
    const graph = graphOf(r.replayBytes);
    expect(graph.edges.find((e: any) => e.id === "derived-alpha"))
      .toEqual({ id: "derived-alpha", source: "memory:alpha", target: "diary:diary-one",
        relationship: "derived_from", data: { origin: "historical" } });
    expect(graph.edges.filter((e: any) => e.source === "memory:alpha" && e.target === "diary:diary-one")).toHaveLength(1);
  });
  it("Note update", () => {
    const r = roundtrip({ kind: "note.update", id: "alpha", patch: { content: "Updated alpha content" } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    const live = r.after.memoryNotes.find(n => n.id === "alpha")!;
    const replayed = value(hydrateSnapshot(JSON.parse(Buffer.from(r.replayBytes).toString("utf8")).data, userId)).memoryNotes.find(n => n.id === "alpha")!;
    expect(replayed.updatedAt).toEqual(live.updatedAt);
    expect(replayed.provenance).toEqual(live.provenance);
  });
  it("Note removal", () => {
    const r = roundtrip({ kind: "note.remove", id: "alpha" });
    expect(r.replayBytes).toEqual(r.liveBytes);
    const graph = graphOf(r.replayBytes);
    expect(graph.nodes.some((n: any) => n.id === "memory:alpha")).toBe(false);
    expect(graph.edges.some((e: any) => e.id === "edge-alpha-beta")).toBe(false);
    // The exact removal effect set (node and incident edge) is explicit.
    expect(r.operations.filter(op => op.type === "ether.graph-node.remove").map(op => (op.payload as any).id))
      .toEqual(["memory:alpha"]);
    expect(r.operations.filter(op => op.type === "ether.graph-edge.remove").map(op => (op.payload as any).id))
      .toEqual(["edge-alpha-beta"]);
  });
  it("Diary create", () => {
    const r = roundtrip({ kind: "diary.put", input: { content: "Fresh diary entry" } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    const id = r.after.diary.find(d => d.content === "Fresh diary entry")!.id;
    expect(graphOf(r.replayBytes).nodes.find((n: any) => n.id === `diary:${id}`))
      .toEqual({ id: `diary:${id}`, type: "diary", label: "Fresh diary entry", data: {} });
  });
  it("Diary update", () => {
    const r = roundtrip({ kind: "diary.update", id: "diary-one", patch: { content: "Updated diary content" } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    expect(graphOf(r.replayBytes).nodes.find((n: any) => n.id === "diary:diary-one").label).toBe("Updated diary content");
  });
  it("Diary removal cascades incident edges exactly like the live graph", () => {
    const raw = fixture();
    raw.graph.edges.push({ id: "derived-beta", source: "memory:beta", target: "diary:diary-one",
      relationship: "derived_from", data: { origin: "historical" } });
    const r = roundtrip({ kind: "diary.remove", id: "diary-one" }, raw);
    expect(r.replayBytes).toEqual(r.liveBytes);
    const graph = graphOf(r.replayBytes);
    expect(graph.nodes.some((n: any) => n.id === "diary:diary-one")).toBe(false);
    expect(graph.edges.some((e: any) => e.target === "diary:diary-one")).toBe(false);
  });
  it("graph mutation with an explicit edge id", () => {
    const r = roundtrip({ kind: "graph-edge.put", id: "edge-explicit-probe", source: "memory:beta",
      target: "memory:candidate", relationship: "supports", data: { origin: "roundtrip" } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    expect(graphOf(r.replayBytes).edges.find((e: any) => e.id === "edge-explicit-probe"))
      .toEqual({ id: "edge-explicit-probe", source: "memory:beta", target: "memory:candidate",
        relationship: "supports", data: { origin: "roundtrip" } });
  });
  it("graph mutation with an unsupported relation normalizes like the live graph", () => {
    const r = roundtrip({ kind: "graph-edge.put", id: "edge-unsupported-probe", source: "memory:beta",
      target: "memory:candidate", relationship: "causes", data: { origin: "roundtrip" } });
    expect(r.replayBytes).toEqual(r.liveBytes);
    expect(graphOf(r.replayBytes).edges.find((e: any) => e.id === "edge-unsupported-probe").relationship).toBe("related_to");
  });
  it("metadata-heavy mutation", () => {
    const metadata = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`field-${i}`, "x".repeat(64)]));
    const r = roundtrip({ kind: "note.put", input: { content: "Metadata heavy", metadata } });
    expect(r.replayBytes).toEqual(r.liveBytes);
  });
  it("special-value mutation", () => {
    const metadata = { value: 1e20, ...JSON.parse('{"constructor":"data","prototype":"data","__proto__":"data"}'),
      high: "\ud800", low: "\udc00" };
    const r = roundtrip({ kind: "note.put", input: { content: "Special values", metadata } });
    expect(r.replayBytes).toEqual(r.liveBytes);
  });
});

describe("detached preparation isolation (Codex RED 2)", { timeout: 30_000 }, () => {
  it("cannot mutate the live canonical Core; failure leaves it unchanged too", async () => {
    const live = new EtherMemoriesCore({ userId });
    value(live.importData(fixture()));
    const before = live.exportData();
    const beforeBytes = value(encodeSnapshotPayload(before));
    const s = await bootstrap();
    cleanup.push(s.parent);
    const filesBefore = await storeFileState(s.directory);
    // Preparation from the canonical data snapshot adds a Note to the
    // candidate only; the live Core is untouched and nothing persists.
    const prepared = value(prepareCoreMutation(before, { kind: "note.put", input: { content: "Isolated note" } }));
    expect(prepared.after.memoryNotes.length).toBe(before.memoryNotes.length + 1);
    expect(value(encodeSnapshotPayload(live.exportData()))).toEqual(beforeBytes);
    expect(live.exportData()).toEqual(before);
    expect(await storeFileState(s.directory)).toEqual(filesBefore);
    // No aliasing: the candidate is plain data, never live mutable structures.
    const liveNotes = (live as unknown as { notes: { valuesUnsafe(): { id: string }[] } }).notes.valuesUnsafe();
    expect(prepared.after.memoryNotes[0]).not.toBe(liveNotes[0]);
    for (const note of prepared.after.memoryNotes) {
      expect(liveNotes.some(liveNote => liveNote === note)).toBe(false);
    }
    // Preparation failure leaves the live Core unchanged.
    const failing = prepareCoreMutation(before, { kind: "note.remove", id: "does-not-exist" });
    expect(failing.ok).toBe(false);
    expect(value(encodeSnapshotPayload(live.exportData()))).toEqual(beforeBytes);
  });
});

describe("process-restart lost-ACK reconciliation (Codex RED 3)", { timeout: 30_000 }, () => {
  it("reconciles the committed mutation before preparation and rejects conflicting intent", async () => {
    const s = await bootstrap();
    cleanup.push(s.parent);
    const store = new ProductionWalStore(s.directory, s.io);
    const command: ProductionMutationCommand = { kind: "note.put", input: { content: "Restart derived note",
      source: "diary", provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } };
    const first = value(await store.commitMutation(s.tip, s.snapshot, mutationId("restart-mutation"), command));
    expect(first.status).toBe("committed");
    const walAfter = await fs.readFile(s.walPath);
    const objectsAfter = await fs.readdir(join(s.directory, "objects")).catch(() => [] as string[]);
    // Lost ACK: the entire process/runtime is destroyed; all prepared effects
    // are gone. A fresh runtime recovers the published StateRoot.
    const runtime = new StartupRecovery(s.directory, userId, s.io);
    value(await runtime.recover());
    const published = value(runtime.read());
    expect(published.tip).toEqual(first.identity);
    // Retry with the same stable mutationId and command intent: the durable
    // receipt lookup runs BEFORE any preparation; no new random edge ID is
    // generated, no new payload object, no second WAL transaction.
    const freshStore = new ProductionWalStore(s.directory, s.io);
    const retry = value(await freshStore.commitMutation(published.tip, published.snapshot, mutationId("restart-mutation"), command));
    expect(retry.status).toBe("already-committed");
    expect(retry.identity).toEqual(first.identity);
    expect(await fs.readFile(s.walPath)).toEqual(walAfter);
    expect(await fs.readdir(join(s.directory, "objects")).catch(() => [] as string[])).toEqual(objectsAfter);
    // Recovered StateRoot is unchanged by the retry.
    const after = new StartupRecovery(s.directory, userId, s.io);
    value(await after.recover());
    expect(value(encodeSnapshotPayload(value(after.read()).snapshot)))
      .toEqual(value(encodeSnapshotPayload(published.snapshot)));
    // Conflicting command intent under the same mutationId fails closed.
    const conflicting: ProductionMutationCommand = { kind: "note.put", input: { content: "Conflicting intent",
      source: "diary", provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } };
    const conflict = await new ProductionWalStore(s.directory, s.io).commitMutation(published.tip, published.snapshot, mutationId("restart-mutation"), conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("PERSISTENCE_CORRUPTION");
  });
  it("commitMutation prepares and commits when the mutation is definitely absent", async () => {
    const s = await bootstrap();
    cleanup.push(s.parent);
    const store = new ProductionWalStore(s.directory, s.io);
    const command: ProductionMutationCommand = { kind: "note.put", input: { content: "L".repeat(100_000), summary: "Large object-backed" } };
    const receipt = value(await store.commitMutation(s.tip, s.snapshot, mutationId("fresh-mutation"), command));
    expect(receipt.status).toBe("committed");
    const objects = await fs.readdir(join(s.directory, "objects"));
    expect(objects.length).toBeGreaterThanOrEqual(1);
    // Recovery publishes the prepared effect set (re-prepare would regenerate
    // timestamps, so compare against recovery determinism and content).
    const runtime = new StartupRecovery(s.directory, userId, s.io);
    expect(value(await runtime.recover()).transactions).toBe(1);
    const published = value(runtime.read());
    expect(published.snapshot.memoryNotes.find(n => n.content === "L".repeat(100_000))).toBeTruthy();
    const second = new StartupRecovery(s.directory, userId, s.io);
    value(await second.recover());
    expect(value(encodeSnapshotPayload(value(second.read()).snapshot)))
      .toEqual(value(encodeSnapshotPayload(published.snapshot)));
  }, 30_000);
  it("diary-derived Note commits and recovers identically through commitMutation", async () => {
    const s = await bootstrap();
    cleanup.push(s.parent);
    const store = new ProductionWalStore(s.directory, s.io);
    const command: ProductionMutationCommand = { kind: "note.put", input: { content: "Committed derived",
      source: "diary", provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } };
    value(await store.commitMutation(s.tip, s.snapshot, mutationId("committed-derived"), command));
    const runtime = new StartupRecovery(s.directory, userId, s.io);
    value(await runtime.recover());
    const published = value(runtime.read());
    // The linker edge the detached execution created is present with its exact
    // generated id, and the derived node/edge structure matches Core semantics.
    const derivedNoteId = published.snapshot.memoryNotes.find(n => n.content === "Committed derived")!.id;
    const edge = published.snapshot.graph.edges.find(e => e.source === `memory:${derivedNoteId}` && e.target === "diary:diary-one")!;
    expect(edge.id.startsWith("edge_")).toBe(true);
    expect(edge.relationship).toBe("derived_from");
    expect(edge.data).toEqual({ origin: "foundation_linker",
      cause: { type: "note_created", noteId: derivedNoteId }, provenanceKind: "diary_extract" });
    expect(published.snapshot.graph.nodes.find(n => n.id === `memory:${derivedNoteId}`))
      .toEqual({ id: `memory:${derivedNoteId}`, type: "memory", label: "Committed derived", data: { status: "active" } });
    const second = new StartupRecovery(s.directory, userId, s.io);
    value(await second.recover());
    expect(value(encodeSnapshotPayload(value(second.read()).snapshot)))
      .toEqual(value(encodeSnapshotPayload(published.snapshot)));
  }, 30_000);
});

describe("accessor-safe command identity (AMBER 3)", () => {
  const plainCommand = (): ProductionMutationCommand => ({ kind: "note.put",
    input: { content: "Plain command", summary: "Plain", metadata: { key: "value" } } });

  it("rejects a getter command without ever invoking the getter", () => {
    let calls = 0;
    const command = { get kind() { calls++; return "note.put"; }, input: { content: "x" } } as unknown as ProductionMutationCommand;
    expect(intentDigest(command).ok).toBe(false);
    expect(prepareCoreMutation(value(hydrateSnapshot(fixture(), userId)), command).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("rejects a setter-only descriptor without invoking it", () => {
    let calls = 0;
    const command = { kind: "note.put", input: { content: "x" },
      set audit(v: unknown) { calls++; } } as unknown as ProductionMutationCommand;
    expect(intentDigest(command).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("rejects a nested getter without invoking it", () => {
    let calls = 0;
    const command = { kind: "note.put",
      input: { get content() { calls++; return "x"; } } } as unknown as ProductionMutationCommand;
    expect(intentDigest(command).ok).toBe(false);
    expect(prepareCoreMutation(value(hydrateSnapshot(fixture(), userId)), command).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("rejects a getter under a dangerous-looking key without invoking it", () => {
    let calls = 0;
    const input: Record<string, unknown> = { content: "x" };
    Object.defineProperty(input, "__proto__", { get() { calls++; }, enumerable: true });
    const command = { kind: "note.put", input } as unknown as ProductionMutationCommand;
    expect(intentDigest(command).ok).toBe(false);
    expect(calls).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("rejects unsupported command values before hashing", () => {
    const base = value(hydrateSnapshot(fixture(), userId));
    for (const command of [
      { kind: "note.put", input: { content: "x", expires: new Date() } },
      { kind: "note.put", input: { content: "x", fn: () => 1 } },
      { kind: "note.put", input: { content: "x", sym: Symbol("s") } },
      { kind: "note.put", input: { content: "x", hole: undefined } },
      { kind: "note.put", input: { content: "x", nan: NaN } },
      { kind: "note.put", input: { content: "x", inf: Infinity } },
      { kind: "note.put", input: { content: "x", sparse: new Array(3) } },
      { kind: "note.put", input: { content: "x", nested: new Map() } }
    ] as unknown as ProductionMutationCommand[]) {
      expect(intentDigest(command).ok, JSON.stringify(command)).toBe(false);
      expect(prepareCoreMutation(base, command).ok).toBe(false);
    }
  });
  it("a valid plain command hashes identically on repeated hashing", () => {
    const command = plainCommand();
    const first = value(intentDigest(command));
    expect(value(intentDigest(command))).toBe(first);
    expect(value(intentDigest(command))).toBe(first);
  });
  it("an equivalent freshly constructed command hashes identically (restart-equivalent)", () => {
    const digestA = value(intentDigest(plainCommand()));
    const digestB = value(intentDigest(plainCommand()));
    expect(digestB).toBe(digestA);
  });
  it("preparation consumes the validated copy, not the caller's original object", async () => {
    const command = plainCommand();
    const copy = value(validatedCommand(command));
    const digestBefore = value(intentDigest(copy));
    // Mutating the caller's original after validation cannot change the
    // validated copy's identity or its preparation result.
    ((command as { input: { content: string } }).input).content = "mutated after validation";
    expect(value(intentDigest(copy))).toBe(digestBefore);
    expect(value(intentDigest(copy))).not.toBe(value(intentDigest(command)));
    const base = value(hydrateSnapshot(fixture(), userId));
    const preparedFromCopy = value(prepareCoreMutation(base, copy));
    expect(preparedFromCopy.after.memoryNotes.find(n => n.content === "Plain command")).toBeTruthy();
    // commitMutation end to end: the stored intent digest equals the digest of
    // an equivalent freshly constructed command, proven by reconciliation.
    const s = await bootstrap();
    cleanup.push(s.parent);
    const store = new ProductionWalStore(s.directory, s.io);
    const committed = value(await store.commitMutation(s.tip, s.snapshot, mutationId("validated-copy"), plainCommand()));
    expect(committed.status).toBe("committed");
    // Retry with an equivalent freshly constructed command: the durable
    // lookup matches the stored intent digest and returns the original
    // receipt without re-preparing.
    const retry = value(await store.commitMutation(committed.identity, s.snapshot, mutationId("validated-copy"), plainCommand()));
    expect(retry.status).toBe("already-committed");
    expect(retry.identity).toEqual(committed.identity);
    // A conflicting fresh command under the same mutationId fails closed.
    const conflicting: ProductionMutationCommand = { kind: "note.put",
      input: { content: "Conflicting validated copy" } };
    const conflict = await store.commitMutation(committed.identity, s.snapshot, mutationId("validated-copy"), conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("PERSISTENCE_CORRUPTION");
  });
});
