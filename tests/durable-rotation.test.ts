import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { value } from "./helpers/persistence.js";
import { bootstrap, semanticFrame, semanticNote, identityPut } from "./helpers/recovery.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import { openDurableEtherMemoriesInternal, type DurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { rotateDurableStore, SORTER_ENTRY_CAPACITY, type RotationPhase } from "../src/persistence/checkpointRotation.js";
import {
  MAX_ACTIVE_WAL_BYTES, MIN_LEGAL_WAL_FRAME_BYTES, MAX_RECEIPT_ENTRY_BYTES, RECEIPTS_DIRECTORY,
  openAuthoritativeReceiptLedger, ReceiptLedgerReader, isRotatedCheckpointId, receiptLedgerPath
} from "../src/persistence/receiptLedger.js";
import { DEFAULT_MAX_INDEX_BYTES } from "../src/persistence/recoveryMutationIndex.js";
import { WAL_LIMITS } from "../src/persistence/wal.js";
import { encodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
import { decodeStoreHead } from "../src/persistence/codecs.js";
import { nodeWalIO, type WalIO } from "../src/persistence/walIO.js";
import type { DirectoryIO } from "../src/persistence/directoryIO.js";
import type { CommittedTip } from "../src/types/persistence.js";
import type { EtherSnapshot } from "../src/types/index.js";

const cleanup: string[] = [];
const setup = async () => {
  const store = await bootstrap();
  cleanup.push(store.parent);
  return store;
};
const fresh = async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-rotation-"));
  cleanup.push(parent);
  return { parent, directory: join(parent, "store") };
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const failure = (result: { ok: boolean; error?: { code: string; details?: unknown } }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error!;
};
const failureDetails = (result: { ok: boolean; error?: { code: string; details?: unknown } }) =>
  (failure(result).details ?? {}) as Record<string, unknown>;
const open = async (store: Awaited<ReturnType<typeof bootstrap>>,
  deps: { maxActiveWalBytes?: number; io?: DirectoryIO; files?: WalIO } = {}) =>
  openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId, directory: store.directory, openMode: "existing" },
    { io: deps.io ?? store.io, files: deps.files ?? nodeWalIO, maxActiveWalBytes: deps.maxActiveWalBytes });
const walBytes = async (directory: string) => {
  let total = 0;
  try { for (const name of await fs.readdir(join(directory, "wal"))) total += (await fs.stat(join(directory, "wal", name))).size; }
  catch { /* no wal content */ }
  return total;
};
const walNames = async (directory: string) => {
  try { return (await fs.readdir(join(directory, "wal"))).sort(); } catch { return []; }
};
const receiptNames = async (directory: string) => {
  try { return (await fs.readdir(join(directory, RECEIPTS_DIRECTORY))).sort(); } catch { return []; }
};
const objectNames = async (directory: string) => {
  try { return (await fs.readdir(join(directory, "objects"))).sort(); } catch { return []; }
};
const headOf = async (directory: string) => value(decodeStoreHead(Buffer.from(await fs.readFile(join(directory, "HEAD")))));
const snapshotBytes = (runtime: DurableEtherMemories) => value(encodeSnapshotPayload(value(runtime.exportData())));
const tipOf = (runtime: DurableEtherMemories) => value(runtime.tip);
const note = (runtime: DurableEtherMemories, content: string, mutationId: string) =>
  runtime.addMemory({ content, tags: ["rotation"], status: "active" }, mutationId);

describe("Tranche 7 active-WAL envelope", { timeout: 300_000 }, () => {
  it("the F_MIN floor, sorter entry capacity and every derivation margin hold for MAX_ACTIVE_WAL_BYTES", () => {
    const base = { epochId: "epoch-a", txId: "9007199254740993" as CommittedTip["txId"], digest: "0".repeat(64) };
    // Minimal legal production frames through the frozen encoder: the two
    // smallest operation shapes (a removal and an identity put).
    const minimalRemove = semanticFrame(base, [{ type: "ether.note.remove", version: "1", payload: { id: "n" } }], "mutation-0123456789abcdef");
    const minimalIdentity = semanticFrame(base, [identityPut()], "mutation-0123456789abcdef");
    const measured = Math.min(minimalRemove.bytes.byteLength, minimalIdentity.bytes.byteLength);
    // The derivation's floor assumption: every legal frame is at least
    // MIN_LEGAL_WAL_FRAME_BYTES, so E(B) <= B / MIN_LEGAL_WAL_FRAME_BYTES.
    expect(measured).toBeGreaterThanOrEqual(MIN_LEGAL_WAL_FRAME_BYTES);
    // BINDING BOUND (Copilot AMBER Finding 1): every committed transaction
    // becomes exactly one receipt entry, so the worst-case admissible
    // segment must fit the rotation sorter's fixed entry capacity.
    expect(SORTER_ENTRY_CAPACITY).toBe(128 * 512);
    expect(Math.floor(MAX_ACTIVE_WAL_BYTES / MIN_LEGAL_WAL_FRAME_BYTES)).toBeLessThanOrEqual(SORTER_ENTRY_CAPACITY);
    // Byte-scratch margins: restart scratch (T5 index runs + merge output),
    // and rotation TRANSIENT sort scratch only (never cumulative durable
    // history, which is filesystem-capacity-bound - Copilot AMBER Finding 2).
    const R_IDX = 512; // frozen recoveryMutationIndex MAX_RECORD_BYTES
    expect(2 * Math.ceil(MAX_ACTIVE_WAL_BYTES / MIN_LEGAL_WAL_FRAME_BYTES) * R_IDX).toBeLessThanOrEqual(DEFAULT_MAX_INDEX_BYTES);
    expect(Math.ceil(1.25 * MAX_ACTIVE_WAL_BYTES)).toBeLessThanOrEqual(DEFAULT_MAX_INDEX_BYTES);
    // The envelope always admits at least one maximal legal frame.
    expect(WAL_LIMITS.frameBytes).toBeLessThanOrEqual(MAX_ACTIVE_WAL_BYTES);
    // Receipt-entry expansion bound used by the ledger derivation.
    expect(MAX_RECEIPT_ENTRY_BYTES).toBeLessThanOrEqual(WAL_LIMITS.aggregatePayloadBytes + 8192);
  });

  it("a mutation crossing the envelope fails precommit and the store stays exactly unchanged", async () => {
    const s = await setup();
    // 40_000-char notes stay inline: each frame is ~45 KiB, so a 1 MiB-floor
    // envelope is crossed after ~23 deterministic commits.
    const bound = 1024 * 1024 + 1000;
    const runtime = value(await open(s, { maxActiveWalBytes: bound }));
    let rejected: Awaited<ReturnType<typeof note>> | undefined;
    let committed = 0;
    for (let index = 0; index < 80; index++) {
      const outcome = await note(runtime, `crossing note ${index} ${"x".repeat(40_000)}`, `cross-${index}`);
      if (!outcome.ok) { rejected = outcome; break; }
      committed++;
    }
    expect(rejected).toBeDefined();
    expect(committed).toBeGreaterThan(10);
    expect(failure(rejected!).code).toBe("RECOVERY_REQUIRED");
    expect(failureDetails(rejected!)).toMatchObject({ phase: "precommit-validation", reason: "resource-limit" });
    // Unambiguous precommit rejection: nothing durable moved.
    const before = await walBytes(s.directory);
    const snapshotBefore = snapshotBytes(runtime);
    const tipBefore = tipOf(runtime);
    const objectsBefore = await objectNames(s.directory);
    const rejectedId = `cross-${committed}`;
    const retry = await note(runtime, `crossing note ${committed} ${"x".repeat(40_000)}`, rejectedId);
    expect(failure(retry).code).toBe("RECOVERY_REQUIRED");
    expect(runtime.state).toBe("ready");
    expect(await walBytes(s.directory)).toBe(before);
    expect(tipOf(runtime)).toEqual(tipBefore);
    expect(snapshotBytes(runtime)).toEqual(snapshotBefore);
    expect(await objectNames(s.directory)).toEqual(objectsBefore);
    // The rejected mutationId never committed: an explicit rotate() unblocks it.
    value(await runtime.rotate());
    const unblocked = value(await note(runtime, `crossing note ${committed} ${"x".repeat(40_000)}`, rejectedId));
    expect(unblocked.content).toContain("crossing note");
    value(await runtime.close());
  });

  it("the exact envelope boundary is accepted and one frame over is rejected; both stores rotate and restart", async () => {
    const content = `boundary note ${"y".repeat(40_000)}`;
    const seed = await setup();
    {
      const runtime = value(await open(seed));
      for (let index = 0; index < 3; index++) value(await note(runtime, content, `bound-${index}`));
      value(await runtime.close());
    }
    const w3 = await walBytes(seed.directory);
    expect(w3 % 3).toBe(0);
    const frame = w3 / 3;
    // Exact bound: the fourth identical frame fits exactly.
    {
      const runtime = value(await open(seed, { maxActiveWalBytes: w3 + frame }));
      value(await note(runtime, content, "bound-3"));
      const over = await note(runtime, content, "bound-4");
      expect(failure(over).code).toBe("RECOVERY_REQUIRED");
      expect(failureDetails(over)).toMatchObject({ phase: "precommit-validation", reason: "resource-limit" });
      value(await runtime.rotate());
      const snapshot = snapshotBytes(runtime);
      value(await runtime.close());
      const reopened = value(await open(seed));
      expect(snapshotBytes(reopened)).toEqual(snapshot);
      value(await reopened.close());
    }
    // One frame over: the fourth commit is rejected before any durability.
    {
      const s = await setup();
      const runtime = value(await open(s));
      for (let index = 0; index < 3; index++) value(await note(runtime, content, `bound-${index}`));
      value(await runtime.close());
      const w = await walBytes(s.directory);
      expect(w).toBe(w3);
      const runtime2 = value(await open(s, { maxActiveWalBytes: w + frame - 1 }));
      const rejected = await note(runtime2, content, "bound-3");
      expect(failure(rejected).code).toBe("RECOVERY_REQUIRED");
      expect(failureDetails(rejected)).toMatchObject({ phase: "precommit-validation", reason: "resource-limit" });
      expect(await walBytes(s.directory)).toBe(w);
      expect(runtime2.state).toBe("ready");
      value(await runtime2.rotate());
      value(await note(runtime2, content, "bound-3"));
      value(await runtime2.close());
    }
  });

  it("object-backed mutations are measured by their exact frame; a crossing object commit is rejected before object durability", async () => {
    const content = `object frame note ${"z".repeat(40_000)}`;
    const s = await setup();
    const runtime = value(await open(s));
    for (let index = 0; index < 3; index++) value(await note(runtime, content, `obj-${index}`));
    value(await runtime.close());
    const w = await walBytes(s.directory);
    // Bound leaves room for the small object-references frame but not the
    // inline frame: the envelope measures exact frame bytes, not object bytes.
    const runtime2 = value(await open(s, { maxActiveWalBytes: w + 2000 }));
    const large = value(await runtime2.addMemory({ content: "o".repeat(400_000), tags: ["object"], status: "active" }, "obj-large"));
    expect(large.content.length).toBe(400_000);
    expect((await objectNames(s.directory)).length).toBeGreaterThan(0);
    const after = await walBytes(s.directory);
    // A further inline commit crosses; the object commit did not.
    const rejected = await note(runtime2, content, "obj-3");
    expect(failure(rejected).code).toBe("RECOVERY_REQUIRED");
    expect(failureDetails(rejected)).toMatchObject({ phase: "precommit-validation", reason: "resource-limit" });
    expect(await walBytes(s.directory)).toBe(after);
    value(await runtime2.close());
    // Object-backed frame crossing: no object may become durable for the
    // rejected mutation.
    const s2 = await setup();
    const runtime3 = value(await open(s2));
    for (let index = 0; index < 3; index++) value(await note(runtime3, content, `obj-${index}`));
    value(await runtime3.close());
    const w2 = await walBytes(s2.directory);
    const runtime4 = value(await open(s2, { maxActiveWalBytes: w2 + 300 }));
    const objectsBefore = await objectNames(s2.directory);
    const crossing = await runtime4.addMemory({ content: "o".repeat(400_000), tags: ["object"], status: "active" }, "obj-cross");
    expect(failure(crossing).code).toBe("RECOVERY_REQUIRED");
    expect(failureDetails(crossing)).toMatchObject({ phase: "precommit-validation", reason: "resource-limit" });
    expect(await objectNames(s2.directory)).toEqual(objectsBefore);
    expect(await walBytes(s2.directory)).toBe(w2);
    expect(runtime4.state).toBe("ready");
    value(await runtime4.close());
  });
});

describe("Tranche 7 checkpoint rotation and reclamation", { timeout: 300_000 }, () => {
  it("rotation preserves the exact generation, activates the hex lineage and reclaims the retired WAL", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "rotation note one", "rot-1"));
    value(await runtime.addDiaryEntry({ content: "rotation diary", tags: ["d"] }, "rot-2"));
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    const retired = await walBytes(s.directory);
    const summary = value(await runtime.rotate());
    // New checkpoint identity is the ledger content digest (64-hex).
    expect(summary.newCheckpointId).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.newCheckpointId).toBe(summary.ledgerDigest);
    expect(summary.retiredWalBytes).toBe(retired);
    expect(summary.receiptCount).toBe(2);
    // The published generation is IDENTICAL across rotation.
    expect(runtime.state).toBe("ready");
    expect(tipOf(runtime)).toEqual(tip);
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    // HEAD now selects the rotated checkpoint lineage.
    const head = await headOf(s.directory);
    expect(head.checkpoint.checkpointId).toBe(summary.newCheckpointId);
    expect(head.checkpoint.digest).toBe(summary.newCheckpointDigest);
    expect(isRotatedCheckpointId(head.checkpoint.checkpointId)).toBe(true);
    // Old WAL and old checkpoint are reclaimed; the ledger is authoritative.
    expect(await walNames(s.directory)).toEqual([]);
    expect(await fs.stat(join(s.directory, "checkpoints", "checkpoint-checkpoint-a.bin")).then(() => true, () => false)).toBe(false);
    expect(await receiptNames(s.directory)).toEqual([`receipts-${summary.ledgerDigest}.bin`]);
    const reader = value(await ReceiptLedgerReader.open(s.directory, summary.ledgerDigest));
    expect(reader.header.entryCount).toBe(2);
    value(await reader.verify());
    // New commits anchor to the new lineage's WAL.
    value(await note(runtime, "post-rotation note", "rot-3"));
    expect(await walNames(s.directory)).toEqual([`wal-${summary.newCheckpointDigest}.bin`]);
    const after = snapshotBytes(runtime);
    const tipAfter = tipOf(runtime);
    value(await runtime.close());
    // Reopen from the rotated lineage: exact equivalence.
    const reopened = value(await open(s));
    expect(snapshotBytes(reopened)).toEqual(after);
    expect(tipOf(reopened)).toEqual(tipAfter);
    value(await reopened.close());
  });

  it("every durable mutation kind reconciles from historical receipts after reclamation, despite later updates and deletions", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    const r1 = value(await note(runtime, "history note", "kind-note-add"));
    const r2 = value(await runtime.updateMemory(r1.id, { summary: "first summary" }, "kind-note-update"));
    const r3 = value(await runtime.promoteCandidate(r1.id, "kind-note-promote"));
    const r4 = value(await runtime.addDiaryEntry({ content: "history diary", tags: ["h"] }, "kind-diary-add"));
    const r5 = value(await runtime.updateDiary(r4.id, { tags: ["h2"] }, "kind-diary-update"));
    const r6 = value(await runtime.addGraphEdge("kind-edge", `memory:${r1.id}`, `diary:${r4.id}`, "related_to", { why: "history" }, "kind-edge-add"));
    expect((await runtime.deleteDiary(r4.id, "kind-diary-delete")).ok).toBe(true);
    // Later history diverges from every original result.
    value(await runtime.updateMemory(r1.id, { summary: "second summary" }, "kind-note-update-2"));
    value(await runtime.deleteMemory(r1.id, "kind-note-delete"));
    value(await runtime.rotate());
    // Retries with the original identities and inputs return the ORIGINAL
    // committed results, reconstructed from reclaimed receipt history.
    const t1 = value(await note(runtime, "history note", "kind-note-add"));
    expect(t1.id).toBe(r1.id);
    expect(t1.createdAt).toEqual(r1.createdAt);
    const t2 = value(await runtime.updateMemory(r1.id, { summary: "first summary" }, "kind-note-update"));
    expect(t2).toEqual(r2);
    const t3 = value(await runtime.promoteCandidate(r1.id, "kind-note-promote"));
    expect(t3).toEqual(r3);
    const t4 = value(await runtime.addDiaryEntry({ content: "history diary", tags: ["h"] }, "kind-diary-add"));
    expect(t4).toEqual(r4);
    const t5 = value(await runtime.updateDiary(r4.id, { tags: ["h2"] }, "kind-diary-update"));
    expect(t5).toEqual(r5);
    const t6 = value(await runtime.addGraphEdge("kind-edge", `memory:${r1.id}`, `diary:${r4.id}`, "related_to", { why: "history" }, "kind-edge-add"));
    expect(t6).toEqual(r6);
    expect((await runtime.deleteDiary(r4.id, "kind-diary-delete")).ok).toBe(true);
    // Conflicting intent under a historical identity is corruption.
    expect(failure(await note(runtime, "different content", "kind-note-add")).code).toBe("PERSISTENCE_CORRUPTION");
    // An absent identity still commits fresh.
    value(await note(runtime, "fresh after history", "kind-fresh"));
    value(await runtime.close());
  });

  it("receipt-referenced payload objects are permanent roots: missing or corrupt objects fail closed", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    const large = value(await runtime.addMemory({ content: "o".repeat(400_000), tags: ["root"], status: "active" }, "root-large"));
    expect(large.content.length).toBe(400_000);
    const objects = await objectNames(s.directory);
    expect(objects.length).toBeGreaterThan(0);
    const objectDirectory = join(s.directory, "objects");
    const originals = new Map(await Promise.all(objects.map(async name =>
      [name, Buffer.from(await fs.readFile(join(objectDirectory, name)))] as const)));
    value(await runtime.rotate());
    // Reconciliation after reclamation resolves the historical OBJECT_REFERENCE.
    const retry = value(await runtime.addMemory({ content: "o".repeat(400_000), tags: ["root"], status: "active" }, "root-large"));
    expect(retry.id).toBe(large.id);
    expect(retry.content).toEqual(large.content);
    value(await runtime.close());
    // Missing referenced objects: recovery fails closed.
    for (const name of objects) await fs.unlink(join(objectDirectory, name));
    expect((await open(s)).ok).toBe(false);
    // A corrupt referenced object: integrity failure fails closed.
    await fs.writeFile(join(objectDirectory, objects[0]!), originals.get(objects[0]!)!.subarray(0, 8));
    expect((await open(s)).ok).toBe(false);
    // Restored objects: recovery succeeds again with identical state.
    for (const [name, bytes] of originals) await fs.writeFile(join(objectDirectory, name), bytes);
    const reopened = value(await open(s));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.id === large.id)).toBe(true);
    value(await reopened.close());
  });

  it("a deleted authoritative receipt ledger fails closed as corruption", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "ledger note", "ledger-1"));
    const summary = value(await runtime.rotate());
    value(await runtime.close());
    await fs.unlink(receiptLedgerPath(s.directory, summary.ledgerDigest));
    const refused = await open(s);
    // The rotated lineage REQUIRES its receipt history: a missing ledger is
    // permanent reconciliation-authority loss, never silently tolerated.
    expect(failure(refused).code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("two rotations produce one cumulative ledger and reconcile mutation identities from both retired segments", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    const a1 = value(await note(runtime, "segment one note", "seg1-a"));
    const d1 = value(await runtime.addDiaryEntry({ content: "segment one diary", tags: ["s1"] }, "seg1-b"));
    const first = value(await runtime.rotate());
    const a2 = value(await note(runtime, "segment two note", "seg2-a"));
    const e2 = value(await runtime.addGraphEdge("seg2-edge", `memory:${a2.id}`, `diary:${d1.id}`, "related_to", {}, "seg2-b"));
    const second = value(await runtime.rotate());
    value(await note(runtime, "active segment note", "seg3-a"));
    // Exactly one cumulative ledger remains: the predecessor was reclaimed.
    expect(await receiptNames(s.directory)).toEqual([`receipts-${second.ledgerDigest}.bin`]);
    expect(first.ledgerDigest).not.toBe(second.ledgerDigest);
    const reader = value(await ReceiptLedgerReader.open(s.directory, second.ledgerDigest));
    expect(reader.header.entryCount).toBe(4);
    expect(reader.header.predecessorLedgerDigest).toBe(first.ledgerDigest);
    value(await reader.verify());
    // Retries from retired segment one, retired segment two and the active WAL.
    const t1 = value(await note(runtime, "segment one note", "seg1-a"));
    expect(t1.id).toBe(a1.id);
    const t2 = value(await runtime.addDiaryEntry({ content: "segment one diary", tags: ["s1"] }, "seg1-b"));
    expect(t2).toEqual(d1);
    const t3 = value(await note(runtime, "segment two note", "seg2-a"));
    expect(t3.id).toBe(a2.id);
    const t4 = value(await runtime.addGraphEdge("seg2-edge", `memory:${a2.id}`, `diary:${d1.id}`, "related_to", {}, "seg2-b"));
    expect(t4).toEqual(e2);
    const t5 = value(await note(runtime, "active segment note", "seg3-a"));
    expect(t5.content).toBe("active segment note");
    // Conflicting reuse of a segment-one identity is still corruption.
    expect(failure(await note(runtime, "other content", "seg1-a")).code).toBe("PERSISTENCE_CORRUPTION");
    value(await runtime.close());
    // Restart reconciles across both retired segments plus the active WAL.
    const reopened = value(await open(s));
    expect(value(await reopened.addDiaryEntry({ content: "segment one diary", tags: ["s1"] }, "seg1-b"))).toEqual(d1);
    value(await reopened.close());
  });

  it("the same mutationId in receipt history and the active WAL is corruption", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "boundary note", "dup-1"));
    value(await runtime.rotate());
    value(await note(runtime, "post-rotation note", "dup-2"));
    const tip = tipOf(runtime);
    value(await runtime.close());
    // Craft a valid, anchored frame carrying the RETIRED mutation identity.
    const forged = semanticFrame(tip, [{ type: "ether.note.put", version: "1", payload: semanticNote("forged") }], "dup-1");
    const head = await headOf(s.directory);
    await fs.appendFile(join(s.directory, "wal", `wal-${head.checkpoint.digest}.bin`), forged.bytes);
    const refused = await open(s);
    expect(failure(refused).code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("bootstrap reserves the hex namespace: non-rotated checkpoints require no receipt history", async () => {
    const s = await setup();
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    const runtime = value(await open(s));
    const head = await headOf(s.directory);
    expect(value(await openAuthoritativeReceiptLedger(s.directory, head.storeId, head.epochId, head.checkpoint.checkpointId))).toBeUndefined();
    expect(isRotatedCheckpointId(head.checkpoint.checkpointId)).toBe(false);
    const summary = value(await runtime.rotate());
    expect(isRotatedCheckpointId(summary.newCheckpointId)).toBe(true);
    value(await runtime.close());
    // The public factory bootstrap uses checkpoint-initial, also non-hex.
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const bootstrapped = value(await openDurableEtherMemoriesInternal({ userId: "namespace-user", directory }, { io }));
    const bootHead = await headOf(directory);
    expect(bootHead.checkpoint.checkpointId).toBe("checkpoint-initial");
    expect(isRotatedCheckpointId(bootHead.checkpoint.checkpointId)).toBe(false);
    const bootSummary = value(await bootstrapped.rotate());
    expect(isRotatedCheckpointId(bootSummary.newCheckpointId)).toBe(true);
    value(await bootstrapped.close());
  });
});

describe("Tranche 7 rotation crash matrix", { timeout: 600_000 }, () => {
  const preCommitPhases: RotationPhase[] = ["P0-authority", "P1-capture", "P2-scan", "P3-sort", "P3-merge",
    "P4-checkpoint", "P5-ledger-activate", "P5-checkpoint-activate", "P6-head-activate"];

  it("a crash at any pre-P6 boundary leaves the old lineage fully authoritative and recoverable", async () => {
    for (const phase of preCommitPhases) {
      const s = await setup();
      const runtime = value(await open(s));
      value(await note(runtime, `crash note ${phase}`, "crash-1"));
      value(await note(runtime, `crash diary ${phase}`, "crash-2"));
      const snapshot = snapshotBytes(runtime);
      const tip = tipOf(runtime);
      const retired = await walBytes(s.directory);
      value(await runtime.close());
      const outcome = await rotateDurableStore({ directory: s.directory, generation: { bytes: snapshot, tip },
        io: s.io, instrumentation: { at: async at => { if (at === phase) throw new Error(`crash at ${phase}`); } } });
      expect(outcome.ok, `phase ${phase}`).toBe(false);
      // The old lineage remains authoritative: HEAD unchanged, WAL untouched.
      const head = await headOf(s.directory);
      expect(isRotatedCheckpointId(head.checkpoint.checkpointId), `phase ${phase}`).toBe(false);
      expect(await walBytes(s.directory), `phase ${phase}`).toBe(retired);
      // Fresh recovery reproduces the exact pre-crash generation.
      const recovered = value(await open(s));
      expect(tipOf(recovered)).toEqual(tip);
      expect(snapshotBytes(recovered)).toEqual(snapshot);
      // The store remains rotatable and reconcilable after the crash.
      const summary = value(await recovered.rotate());
      expect(isRotatedCheckpointId(summary.newCheckpointId)).toBe(true);
      const retried = value(await note(recovered, `crash note ${phase}`, "crash-1"));
      expect(retried.content).toBe(`crash note ${phase}`);
      value(await recovered.close());
    }
  });

  it("a P7 reclamation failure reports post-activation and never claims the old lineage", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "reclaim note", "reclaim-1"));
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    value(await runtime.close());
    const outcome = await rotateDurableStore({ directory: s.directory, generation: { bytes: snapshot, tip },
      io: s.io, instrumentation: { at: async at => { if (at === "P7-reclaim") throw new Error("reclaim crash"); } } });
    expect(failureDetails(outcome)).toMatchObject({ activated: true, phase: "post-activation" });
    // The new lineage is authoritative even though cleanup is pending.
    const head = await headOf(s.directory);
    expect(isRotatedCheckpointId(head.checkpoint.checkpointId)).toBe(true);
    const recovered = value(await open(s));
    expect(tipOf(recovered)).toEqual(tip);
    expect(snapshotBytes(recovered)).toEqual(snapshot);
    // Historical reconciliation works through the new lineage.
    const retried = value(await note(recovered, "reclaim note", "reclaim-1"));
    expect(retried.content).toBe("reclaim note");
    value(await recovered.close());
  });

  it("runtime.rotate() reports rotationCommitted for a post-activation failure and the runtime stays correct", async () => {
    const s = await setup();
    let armed = false;
    const faulting: DirectoryIO = { ...s.io, removeOwnedFile: async path => {
      if (armed && path.includes("wal-")) { armed = false; throw new Error("reclaim failure"); }
      return s.io.removeOwnedFile(path);
    } };
    const runtime = value(await open(s, { io: faulting }));
    value(await note(runtime, "facade reclaim note", "facade-1"));
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    armed = true;
    const outcome = await runtime.rotate();
    expect(failureDetails(outcome)).toMatchObject({ rotationCommitted: true, phase: "post-activation" });
    // The published generation is unchanged and exactly correct.
    expect(runtime.state).toBe("ready");
    expect(tipOf(runtime)).toEqual(tip);
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    // Reconciliation and further use work through the new lineage.
    const retried = value(await note(runtime, "facade reclaim note", "facade-1"));
    expect(retried.content).toBe("facade reclaim note");
    value(await runtime.close());
    const reopened = value(await open(s));
    expect(snapshotBytes(reopened)).toEqual(snapshot);
    value(await reopened.close());
  });

  it("rotation serializes with queued mutations behind the single-flight queue", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "queued note", "queue-1"));
    const rotationPromise = runtime.rotate();
    const mutationPromise = note(runtime, "queued note two", "queue-2");
    const [rotationOutcome, mutationOutcome] = await Promise.all([rotationPromise, mutationPromise]);
    expect(mutationOutcome.ok).toBe(true);
    const summary = value(rotationOutcome);
    // The queued mutation committed into the rotated lineage's new segment.
    expect(await walNames(s.directory)).toEqual([`wal-${summary.newCheckpointDigest}.bin`]);
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    value(await runtime.close());
    const reopened = value(await open(s));
    expect(snapshotBytes(reopened)).toEqual(snapshot);
    expect(tipOf(reopened)).toEqual(tip);
    value(await reopened.close());
  });
});
describe("Tranche 7 Copilot AMBER repairs", { timeout: 600_000 }, () => {
  /**
   * Crafted tiny-frame histories (frozen encoder, anchored chain). Recovery
   * is not exercised here: rotateDurableStore streams and validates the WAL
   * without replaying it, so capacity-stress histories stay fast.
   */
  const craftedIdentity = { userId: "fixture-user", createdAt: new Date("2020-01-01T00:00:00.000Z"),
    lastActive: new Date("2020-01-02T00:00:00.000Z"), preferences: {} };
  const craft = async (store: Awaited<ReturnType<typeof bootstrap>>, count: number) => {
    const chunks: Buffer[] = [];
    let base = store.tip;
    for (let index = 0; index < count; index++) {
      const frame = semanticFrame(base, [identityPut()], `tiny-${index}`);
      chunks.push(Buffer.from(frame.bytes));
      base = frame.transaction.identity;
    }
    await fs.writeFile(store.walPath, Buffer.concat(chunks));
    const bytes = value(encodeSnapshotPayload({ ...store.snapshot, identity: craftedIdentity } as unknown as EtherSnapshot));
    return { tip: base, bytes, frameBytes: chunks[0]!.byteLength };
  };

  it("a worst-case admissible tiny-frame segment rotates and restarts within sorter capacity (Finding 1)", async () => {
    const s = await setup();
    // The largest count of these legal minimal frames the default envelope
    // can admit: exactly the byte envelope.
    const probe = semanticFrame(s.tip, [identityPut()], "tiny-probe");
    const count = Math.floor(MAX_ACTIVE_WAL_BYTES / probe.bytes.byteLength);
    expect(count).toBeGreaterThan(40_000);
    expect(count).toBeLessThanOrEqual(SORTER_ENTRY_CAPACITY);
    const crafted = await craft(s, count);
    expect(await walBytes(s.directory)).toBeLessThanOrEqual(MAX_ACTIVE_WAL_BYTES);
    const summary = value(await rotateDurableStore({ directory: s.directory, io: s.io,
      generation: { bytes: crafted.bytes, tip: crafted.tip } }));
    expect(summary.receiptCount).toBe(count);
    // The admitted worst case is sortable: the new lineage is authoritative.
    expect(isRotatedCheckpointId((await headOf(s.directory)).checkpoint.checkpointId)).toBe(true);
    expect(await walNames(s.directory)).toEqual([]);
    const reader = value(await ReceiptLedgerReader.open(s.directory, summary.ledgerDigest));
    expect(reader.header.entryCount).toBe(count);
    value(await reader.verify());
    // Restart from the rotated lineage: exact crafted generation.
    const reopened = value(await open(s));
    expect(value(reopened.exportData()).identity.userId).toBe("fixture-user");
    expect(snapshotBytes(reopened)).toEqual(crafted.bytes);
    expect(tipOf(reopened)).toEqual(crafted.tip);
    value(await reopened.close());
  });

  it("a 65,537-tiny-frame segment is beyond admission and can never become authoritative (Finding 1)", async () => {
    const s = await setup();
    const count = SORTER_ENTRY_CAPACITY + 1;
    const crafted = await craft(s, count);
    // Copilot's exact reproducer shape: more sortable entries than the
    // segment could ever legally reach under the corrected envelope.
    expect(count * crafted.frameBytes).toBeGreaterThan(MAX_ACTIVE_WAL_BYTES);
    const outcome = await rotateDurableStore({ directory: s.directory, io: s.io,
      generation: { bytes: crafted.bytes, tip: crafted.tip } });
    expect(outcome.ok).toBe(false);
    // Old lineage stays authoritative: the failure is pre-activation.
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    expect((await walNames(s.directory)).length).toBe(1);
  });

  it("a large cumulative ledger with a tiny retiring segment rotates without segment-proportional accounting (Finding 2)", async () => {
    const s = await setup();
    const history = 5_000;
    const crafted = await craft(s, history);
    const first = value(await rotateDurableStore({ directory: s.directory, io: s.io,
      generation: { bytes: crafted.bytes, tip: crafted.tip } }));
    const ledgerOnePath = receiptLedgerPath(s.directory, first.ledgerDigest);
    const ledgerOneBytes = (await fs.stat(ledgerOnePath)).size;
    expect(ledgerOneBytes).toBeGreaterThan(1_000_000);
    // A one-frame retiring segment against a multi-megabyte cumulative
    // history: total rotation space is dominated by the durable ledger
    // rewrite (predecessor + successor coexist), NOT by the segment.
    const one = semanticFrame(crafted.tip, [identityPut()], "tiny-after");
    const walPath = join(s.directory, "wal", `wal-${first.newCheckpointDigest}.bin`);
    await fs.writeFile(walPath, Buffer.from(one.bytes));
    const second = value(await rotateDurableStore({ directory: s.directory, io: s.io,
      generation: { bytes: crafted.bytes, tip: one.transaction.identity } }));
    expect(second.receiptCount).toBe(history + 1);
    const reader = value(await ReceiptLedgerReader.open(s.directory, second.ledgerDigest));
    expect(reader.header.entryCount).toBe(history + 1);
    expect(reader.header.predecessorLedgerDigest).toBe(first.ledgerDigest);
    value(await reader.verify());
    expect((await fs.stat(receiptLedgerPath(s.directory, second.ledgerDigest))).size)
      .toBeGreaterThanOrEqual(ledgerOneBytes);
    // Reconciliation still resolves identities from the large history.
    const found = value(await reader.lookup("tiny-0"));
    expect(found?.mutationId).toBe("tiny-0");
    expect(await fs.access(ledgerOnePath).then(() => true, () => false)).toBe(false);
  });

  it("ENOSPC during ledger construction fails pre-activation with the old lineage authoritative (Finding 2)", async () => {
    const s = await setup();
    const crafted = await craft(s, 5);
    let armed = true;
    const files: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (armed && path.includes("rotation-candidate")) throw new Error("simulated ENOSPC");
      return nodeWalIO.open(path, create);
    } };
    const failed = await rotateDurableStore({ directory: s.directory, io: s.io, files,
      generation: { bytes: crafted.bytes, tip: crafted.tip } });
    expect(failed.ok).toBe(false);
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    // Disarm: the same rotation then succeeds.
    armed = false;
    const summary = value(await rotateDurableStore({ directory: s.directory, io: s.io, files,
      generation: { bytes: crafted.bytes, tip: crafted.tip } }));
    expect(summary.receiptCount).toBe(5);
  });

  it("a concurrent rotation is never misclassified as history corruption during reconciliation (Finding 3)", async () => {
    const s = await setup();
    const runtime = value(await open(s));
    value(await note(runtime, "race historical note", "race-0"));
    value(await runtime.rotate());
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    const gatedFiles: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (armed && path.includes("receipts")) await gate;
      return nodeWalIO.open(path, create);
    } };
    // Runtime A holds writer authority for its complete historical lookup and
    // stalls inside it (after old-lineage observation). Runtime B is opened
    // BEFORE the stall: a second runtime cannot even recover while A holds
    // the writer lock.
    const runtimeA = value(await open(s, { files: gatedFiles }));
    const runtimeB = value(await open(s));
    armed = true;
    const retryA = note(runtimeA, "race historical note", "race-0");
    await new Promise(resolve => setTimeout(resolve, 150));
    // Runtime B's rotation observes normal authority contention, never a
    // PERSISTENCE_CORRUPTION misclassification of missing history.
    const contended = await runtimeB.rotate();
    expect(failure(contended).code).toBe("WRITER_BUSY");
    expect(runtimeB.state).toBe("ready");
    expect(failureDetails(contended).activated).toBeUndefined();
    release!();
    const reconciled = value(await retryA);
    expect(reconciled.content).toBe("race historical note");
    // Coherent retry semantics after the successor lineage is observed.
    value(await runtimeB.rotate());
    expect(value(await note(runtimeA, "race historical note", "race-0")).id).toBe(reconciled.id);
    expect(failure(await note(runtimeA, "conflicting intent", "race-0")).code).toBe("PERSISTENCE_CORRUPTION");
    // Exactly one transaction exists for the identity: no duplicate commit.
    const exported = value(runtimeA.exportData());
    expect(exported.memoryNotes.filter(n => n.content === "race historical note").length).toBe(1);
    value(await runtimeA.close());
    value(await runtimeB.close());
  });

  it("P6 pre-rename failures keep the old lineage; recovery restores readiness (Finding 4)", async () => {
    const s = await setup();
    let armed = true;
    const faulting: DirectoryIO = { ...s.io, writeExclusive: async (path, bytes) => {
      if (armed && path.includes("rotation-head-000000")) throw new Error("candidate write failure");
      return s.io.writeExclusive(path, bytes);
    } };
    const runtime = value(await open(s, { io: faulting }));
    value(await note(runtime, "pre-rename note", "prerename-1"));
    const snapshot = snapshotBytes(runtime);
    const failed = await runtime.rotate();
    expect(failureDetails(failed)).toMatchObject({ activationState: "pre-activation" });
    // The old lineage is definitely authoritative: the runtime conservatively
    // requires recovery, which restores readiness without any state change.
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.recover());
    expect(runtime.state).toBe("ready");
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    // A failed rename is equally pre-activation: the old HEAD is intact.
    armed = false;
    const renameFault: DirectoryIO = { ...s.io, activateFile: async (candidate, destination) => {
      if (destination.endsWith("HEAD")) throw new Error("rename failure");
      return s.io.activateFile(candidate, destination);
    } };
    const runtime2 = value(await open(s, { io: renameFault }));
    const failedRename = await runtime2.rotate();
    expect(failureDetails(failedRename)).toMatchObject({ activationState: "pre-activation" });
    expect(runtime2.state).toBe("recovery-required");
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    value(await runtime2.recover());
    expect(runtime2.state).toBe("ready");
    value(await runtime2.close());
    value(await runtime.close());
  });

  it("post-rename barrier failures report unconfirmed activation and require recovery (Finding 4)", async () => {
    for (const mode of ["private-sync", "store-sync"] as const) {
      const s = await setup();
      let renamed = false;
      let disarm = false;
      const faulting: DirectoryIO = { ...s.io,
        activateFile: async (candidate, destination) => {
          const activated = await s.io.activateFile(candidate, destination);
          if (destination.endsWith("HEAD")) renamed = true;
          return activated;
        },
        syncDirectory: async path => {
          if (!disarm && renamed && ((mode === "private-sync" && path.endsWith(".private")) || (mode === "store-sync" && path === s.directory))) {
            throw new Error("post-rename barrier failure");
          }
          return s.io.syncDirectory(path);
        } };
      const runtime = value(await open(s, { io: faulting }));
      value(await note(runtime, `barrier note ${mode}`, "barrier-1"));
      const snapshot = snapshotBytes(runtime);
      const failed = await runtime.rotate();
      // HEAD renamed but durability unconfirmed: never an ordinary
      // pre-activation failure, and the runtime must not casually remain
      // writable.
      expect(failureDetails(failed)).toMatchObject({ activationState: "head-renamed-durability-unconfirmed" });
      expect(failureDetails(failed).rotationDurabilityUncertain).toBe(true);
      expect(runtime.state).toBe("recovery-required");
      // The barrier failure was transient: explicit recovery re-establishes
      // coherent authority; the published generation is identical across the
      // uncertain switch.
      disarm = true;
      value(await runtime.recover());
      expect(runtime.state).toBe("ready");
      expect(snapshotBytes(runtime)).toEqual(snapshot);
      value(await runtime.close());
      const reopened = value(await open(s));
      expect(snapshotBytes(reopened)).toEqual(snapshot);
      value(await reopened.close());
    }
  });

  it("authority-release failures preserve the primary activation outcome (Finding 4)", async () => {
    // P6/P7 fully succeed, then authority release fails: the committed
    // rotation must still be distinguishable from "never performed".
    const s = await setup();
    let armed = false;
    const lockFault: DirectoryIO = { ...s.io, removeOwnedFile: async path => {
      if (armed && path.endsWith("writer.lock")) throw new Error("release failure");
      return s.io.removeOwnedFile(path);
    } };
    const runtime = value(await open(s, { io: lockFault }));
    value(await note(runtime, "release failure note", "release-1"));
    const snapshot = snapshotBytes(runtime);
    armed = true;
    const failed = await runtime.rotate();
    const details = failureDetails(failed);
    expect(details.activated).toBe(true);
    expect(details.rotationCommitted).toBe(true);
    expect(runtime.state).toBe("ready");
    // The new lineage is authoritative despite the release failure.
    expect(isRotatedCheckpointId((await headOf(s.directory)).checkpoint.checkpointId)).toBe(true);
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    value(await runtime.close());
    // P7 cleanup failure PLUS release failure: the post-activation result
    // and its activation metadata survive both failures.
    const s2 = await setup();
    const crafted = await craft(s2, 3);
    let p7Armed = false;
    const p7Fault: DirectoryIO = { ...s2.io, removeOwnedFile: async path => {
      if (p7Armed && path.includes("wal-")) throw new Error("wal reclaim failure");
      if (p7Armed && path.endsWith("writer.lock")) throw new Error("release failure");
      return s2.io.removeOwnedFile(path);
    } };
    const outcome = await rotateDurableStore({ directory: s2.directory, io: p7Fault,
      generation: { bytes: crafted.bytes, tip: crafted.tip },
      instrumentation: { at: async at => { if (at === "P7-reclaim") p7Armed = true; } } });
    const p7details = failureDetails(outcome);
    expect(p7details.activated).toBe(true);
    expect(p7details.phase).toBe("post-activation");
    expect(isRotatedCheckpointId((await headOf(s2.directory)).checkpoint.checkpointId)).toBe(true);
  });

  it("scratch cleanup failures are observable: pre-activation fail-closed, post-activation pending (Finding 5)", async () => {
    const s = await setup();
    const debris = join(s.directory, ".private", "rotation-candidate-000000.bin");
    await fs.writeFile(debris, "stale debris");
    let armed = true;
    const faulting: DirectoryIO = { ...s.io, removeOwnedFile: async path => {
      if (armed && path.includes("rotation-candidate")) throw new Error("scratch removal failure");
      return s.io.removeOwnedFile(path);
    } };
    const runtime = value(await open(s, { io: faulting }));
    value(await note(runtime, "scratch note", "scratch-1"));
    // Pre-P6 scratch cleanup failure fails the rotation pre-activation with
    // the old lineage authoritative; ENOENT stays idempotent elsewhere.
    const failed = await runtime.rotate();
    expect(failed.ok).toBe(false);
    expect(failureDetails(failed).activated).toBeUndefined();
    expect((await headOf(s.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    // The runtime conservatively requires recovery, which succeeds: the
    // store itself was never damaged.
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.recover());
    // Disarm: the retry completes the rotation and sweeps the debris.
    armed = false;
    const summary = value(await runtime.rotate());
    expect(isRotatedCheckpointId(summary.newCheckpointId)).toBe(true);
    expect(await fs.access(debris).then(() => true, () => false)).toBe(false);
    value(await runtime.close());
    // Post-P6 scratch cleanup failure reports pending cleanup, never old
    // authority, and the new lineage stays authoritative.
    const s2 = await setup();
    await fs.writeFile(join(s2.directory, ".private", "rotation-candidate-000000.bin"), "stale debris");
    let p7Armed = false;
    const p7Fault: DirectoryIO = { ...s2.io, removeOwnedFile: async path => {
      if (p7Armed && path.includes("rotation-candidate")) throw new Error("scratch removal failure");
      return s2.io.removeOwnedFile(path);
    } };
    const crafted = await craft(s2, 2);
    const p7outcome = await rotateDurableStore({ directory: s2.directory, io: p7Fault,
      generation: { bytes: crafted.bytes, tip: crafted.tip },
      instrumentation: { at: async at => { if (at === "P7-reclaim") p7Armed = true; } } });
    expect(failureDetails(p7outcome)).toMatchObject({ activated: true, phase: "post-activation" });
    expect(isRotatedCheckpointId((await headOf(s2.directory)).checkpoint.checkpointId)).toBe(true);
    // A .private directory barrier failure during the P0 sweep is equally
    // observable and pre-activation.
    const s3 = await setup();
    let syncArmed = false;
    const syncFault: DirectoryIO = { ...s3.io, syncDirectory: async path => {
      if (syncArmed && path.endsWith(".private")) throw new Error("scratch barrier failure");
      return s3.io.syncDirectory(path);
    } };
    const runtime3 = value(await open(s3, { io: syncFault }));
    value(await note(runtime3, "sync scratch note", "syncscratch-1"));
    syncArmed = true;
    const syncFailed = await runtime3.rotate();
    expect(syncFailed.ok).toBe(false);
    expect(failureDetails(syncFailed).activated).toBeUndefined();
    expect((await headOf(s3.directory)).checkpoint.checkpointId).toBe("checkpoint-a");
    syncArmed = false;
    value(await runtime3.recover());
    value(await runtime3.rotate());
    value(await runtime3.close());
  });
});
