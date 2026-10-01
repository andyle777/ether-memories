import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
// Compiled production modules only; never tests/ or src/ development imports.
import { openDurableEtherMemoriesInternal } from "../dist/core/DurableEtherMemories.js";
import { rotateDurableStore } from "../dist/persistence/checkpointRotation.js";
import { ReceiptLedgerReader, receiptLedgerPath, RECEIPTS_DIRECTORY } from "../dist/persistence/receiptLedger.js";
import { encodeSnapshotPayload } from "../dist/persistence/snapshotPayload.js";
import { decodeStoreHead } from "../dist/persistence/codecs.js";
import { StartupRecovery } from "../dist/persistence/StartupRecovery.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const failureCode = r => { assert.equal(r.ok, false, JSON.stringify(r)); return r.error.code; };
const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
const io = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;
const files = nodeWalIO;
const headOf = async directory => value(decodeStoreHead(Buffer.from(await fs.readFile(join(directory, "HEAD")))));
const walNames = async directory => fs.readdir(join(directory, "wal")).catch(() => []);

let parent;
try {
  parent = await fs.mkdtemp(join(tmpdir(), "ether-t7-probe-"));
  const directory = join(parent, "store");
  const userId = "t7-probe-user";
  const snapshotOf = runtime => value(encodeSnapshotPayload(value(runtime.exportData())));

  // Bootstrap and a meaningful mutation history, including one large
  // object-backed result whose effects live outside the WAL frame.
  const runtime = value(await openDurableEtherMemoriesInternal({ userId, directory }, { io, files }));
  const noteA = value(await runtime.addMemory({ content: "probe rotation note A", tags: ["t7"], status: "active" }, "probe-note-a"));
  const diaryA = value(await runtime.addDiaryEntry({ content: "probe rotation diary", tags: ["t7"] }, "probe-diary-a"));
  const largeContent = "probe large object payload ".repeat(16_000);
  const noteLarge = value(await runtime.addMemory({ content: largeContent, tags: ["t7", "object"], status: "active" }, "probe-note-large"));
  const edgeA = value(await runtime.addGraphEdge("probe-edge-a", `memory:${noteA.id}`, `diary:${diaryA.id}`, "related_to", { probe: true }, "probe-edge-a"));
  const noteB = value(await runtime.addMemory({ content: "probe rotation note B", tags: ["t7"], status: "candidate" }, "probe-note-b"));
  const promotedB = value(await runtime.promoteCandidate(noteB.id, "probe-promote-b"));
  const committedBeforeRotation = 6;

  // Pre-rotation reconciliation sanity: retry returns the original result.
  assert.equal(value(await runtime.addMemory({ content: "probe rotation note A", tags: ["t7"], status: "active" }, "probe-note-a")).id, noteA.id);

  const snapshotBefore = snapshotOf(runtime);
  const tipBefore = value(runtime.tip);
  const retiredWalBytes = (await fs.stat(join(directory, "wal", (await walNames(directory))[0]))).size;

  // Rotation 1: new checkpoint authority, retired WAL reclamation, cumulative
  // receipts, and an IDENTICAL published generation.
  const first = value(await runtime.rotate());
  assert.match(first.newCheckpointId, /^[0-9a-f]{64}$/);
  assert.equal(first.newCheckpointId, first.ledgerDigest);
  assert.equal(first.receiptCount, committedBeforeRotation);
  assert.equal(first.retiredWalBytes, retiredWalBytes);
  assert.equal((await headOf(directory)).checkpoint.checkpointId, first.newCheckpointId);
  assert.deepEqual(await walNames(directory), []);
  const ledgerOne = value(await ReceiptLedgerReader.open(directory, first.ledgerDigest));
  assert.equal(ledgerOne.header.entryCount, committedBeforeRotation);
  value(await ledgerOne.verify());
  assert.equal(runtime.state, "ready");
  assert.deepEqual(value(runtime.tip), tipBefore);
  assert.deepEqual(snapshotOf(runtime), snapshotBefore);

  // Retries of retired mutations return their ORIGINAL results after the
  // WAL frames are gone, including the object-backed one.
  assert.equal(value(await runtime.addMemory({ content: "probe rotation note A", tags: ["t7"], status: "active" }, "probe-note-a")).createdAt.getTime(), noteA.createdAt.getTime());
  assert.equal(value(await runtime.addDiaryEntry({ content: "probe rotation diary", tags: ["t7"] }, "probe-diary-a")).id, diaryA.id);
  assert.equal(value(await runtime.addMemory({ content: largeContent, tags: ["t7", "object"], status: "active" }, "probe-note-large")).content, noteLarge.content);
  assert.equal(value(await runtime.addGraphEdge("probe-edge-a", `memory:${noteA.id}`, `diary:${diaryA.id}`, "related_to", { probe: true }, "probe-edge-a")).id, edgeA.id);
  assert.equal(value(await runtime.promoteCandidate(noteB.id, "probe-promote-b")).status, promotedB.status);
  // Conflicting reuse of a retired identity remains corruption.
  assert.equal(failureCode(await runtime.addMemory({ content: "conflicting reuse", tags: ["t7"] }, "probe-note-a")), "PERSISTENCE_CORRUPTION");

  // Post-rotation commits anchor to the new lineage's WAL segment.
  value(await runtime.addMemory({ content: "probe post-rotation note", tags: ["t7"], status: "active" }, "probe-note-c"));
  value(await runtime.addDiaryEntry({ content: "probe post-rotation diary", tags: ["t7"] }, "probe-diary-b"));
  const postRotationSnapshot = snapshotOf(runtime);
  const postRotationTip = value(runtime.tip);
  value(await runtime.close());

  // Restart/recover: exact equivalence with the live pre-close generation.
  const reopened = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files }));
  assert.deepEqual(value(reopened.tip), postRotationTip);
  assert.deepEqual(snapshotOf(reopened), postRotationSnapshot);
  const recoveryCheck = new StartupRecovery(directory, userId, io, files);
  const recoveryReceipt = value(await recoveryCheck.recover());
  assert.equal(recoveryReceipt.transactions, 2);
  assert.deepEqual(value(encodeSnapshotPayload(value(recoveryCheck.read()).snapshot)), postRotationSnapshot);

  // Rotation 2: the cumulative ledger now covers both retired segments.
  const second = value(await reopened.rotate());
  assert.notEqual(second.ledgerDigest, first.ledgerDigest);
  assert.equal(second.receiptCount, committedBeforeRotation + 2);
  const ledgerTwo = value(await ReceiptLedgerReader.open(directory, second.ledgerDigest));
  assert.equal(ledgerTwo.header.entryCount, committedBeforeRotation + 2);
  assert.equal(ledgerTwo.header.predecessorLedgerDigest, first.ledgerDigest);
  value(await ledgerTwo.verify());
  assert.equal(await fs.access(receiptLedgerPath(directory, first.ledgerDigest)).then(() => true, () => false), false);
  assert.deepEqual(await walNames(directory), []);
  // Retries resolve across BOTH retired segments.
  assert.equal(value(await reopened.addMemory({ content: "probe rotation note A", tags: ["t7"], status: "active" }, "probe-note-a")).id, noteA.id);
  assert.equal(value(await reopened.addMemory({ content: "probe post-rotation note", tags: ["t7"], status: "active" }, "probe-note-c")).content, "probe post-rotation note");
  // A fresh active segment still accepts new commits after two rotations.
  value(await reopened.addMemory({ content: "probe active segment note", tags: ["t7"], status: "active" }, "probe-note-d"));
  // Rotation 3: the third destructive round trip with retries from every
  // retired segment plus the active WAL.
  const third = value(await reopened.rotate());
  assert.equal(third.receiptCount, committedBeforeRotation + 3);
  assert.equal(value(await reopened.addMemory({ content: "probe rotation note A", tags: ["t7"], status: "active" }, "probe-note-a")).id, noteA.id);
  assert.equal(value(await reopened.addMemory({ content: "probe post-rotation note", tags: ["t7"], status: "active" }, "probe-note-c")).content, "probe post-rotation note");
  assert.equal(value(await reopened.addMemory({ content: "probe active segment note", tags: ["t7"], status: "active" }, "probe-note-d")).content, "probe active segment note");
  assert.equal((await fs.readdir(join(directory, RECEIPTS_DIRECTORY))).length, 1);
  const finalSnapshot = snapshotOf(reopened);
  const finalTip = value(reopened.tip);
  value(await reopened.close());

  // Crash-injection scenarios on an isolated store: P5 and P6 leave the old
  // lineage authoritative; a P7 failure reports post-activation.
  const crashDirectory = join(parent, "crash-store");
  const crashRuntime = value(await openDurableEtherMemoriesInternal({ userId: "t7-crash-user", directory: crashDirectory }, { io, files }));
  value(await crashRuntime.addMemory({ content: "crash history note", tags: ["t7"], status: "active" }, "crash-note-a"));
  const crashSnapshot = snapshotOf(crashRuntime);
  const crashTip = value(crashRuntime.tip);
  value(await crashRuntime.close());
  for (const phase of ["P5-checkpoint-activate", "P6-head-activate"]) {
    const outcome = await rotateDurableStore({ directory: crashDirectory, generation: { bytes: crashSnapshot, tip: crashTip }, io, files,
      instrumentation: { at: async at => { if (at === phase) throw new Error(`injected crash at ${phase}`); } } });
    assert.equal(outcome.ok, false);
    assert.equal((await headOf(crashDirectory)).checkpoint.checkpointId, "checkpoint-initial");
  }
  const afterOldLineage = value(await openDurableEtherMemoriesInternal({ userId: "t7-crash-user", directory: crashDirectory, openMode: "existing" }, { io, files }));
  assert.deepEqual(value(afterOldLineage.tip), crashTip);
  assert.deepEqual(snapshotOf(afterOldLineage), crashSnapshot);
  value(await afterOldLineage.close());
  const p7Outcome = await rotateDurableStore({ directory: crashDirectory, generation: { bytes: crashSnapshot, tip: crashTip }, io, files,
    instrumentation: { at: async at => { if (at === "P7-reclaim") throw new Error("injected reclaim failure"); } } });
  assert.equal(p7Outcome.error.details.activated, true);
  assert.equal(p7Outcome.error.details.phase, "post-activation");
  assert.match((await headOf(crashDirectory)).checkpoint.checkpointId, /^[0-9a-f]{64}$/);
  const afterNewLineage = value(await openDurableEtherMemoriesInternal({ userId: "t7-crash-user", directory: crashDirectory, openMode: "existing" }, { io, files }));
  assert.deepEqual(value(afterNewLineage.tip), crashTip);
  assert.equal(value(await afterNewLineage.addMemory({ content: "crash history note", tags: ["t7"], status: "active" }, "crash-note-a")).content, "crash history note");
  value(await afterNewLineage.close());

  // Fail-closed authority: a deleted authoritative ledger or a deleted
  // receipt-referenced object must refuse startup.
  const ledgerMissing = join(parent, "ledger-missing");
  await fs.cp(directory, ledgerMissing, { recursive: true });
  await fs.unlink(receiptLedgerPath(ledgerMissing, third.ledgerDigest));
  assert.equal(failureCode(await openDurableEtherMemoriesInternal({ userId, directory: ledgerMissing, openMode: "existing" }, { io, files })), "PERSISTENCE_CORRUPTION");
  const objects = await fs.readdir(join(directory, "objects"));
  assert.ok(objects.length > 0);
  const originals = new Map(await Promise.all(objects.map(async name => [name, await fs.readFile(join(directory, "objects", name))])));
  for (const name of objects) await fs.unlink(join(directory, "objects", name));
  assert.equal((await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files })).ok, false);
  for (const [name, bytes] of originals) await fs.writeFile(join(directory, "objects", name), bytes);
  const restored = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files }));
  assert.deepEqual(snapshotOf(restored), finalSnapshot);
  assert.deepEqual(value(restored.tip), finalTip);
  value(await restored.close());

  const snapshotSha256 = createHash("sha256").update(finalSnapshot).digest("hex");
  console.log(JSON.stringify({
    rotations: 3,
    committedBeforeRotation,
    receiptCountAfterRotation3: third.receiptCount,
    retiredWalBytes: first.retiredWalBytes,
    ledgerDigestRotation3: third.ledgerDigest,
    snapshotBytes: finalSnapshot.length,
    snapshotSha256,
    finalTip: finalTip.txId,
    preP6CrashPhasesOldLineageAuthoritative: ["P5-checkpoint-activate", "P6-head-activate"],
    p7FailureReportedPostActivation: true,
    failClosedDeletedLedger: "PERSISTENCE_CORRUPTION",
    failClosedDeletedReceiptObject: true,
    objectBackedRetryAfterReclamation: true,
    simulatedDirectoryBarriers: simulate,
    nativePowerLossClaim: false
  }, null, 2));
  console.log("TRANCHE7 ROTATION/RECEIPTS/RECLAMATION PROBE: PASS");
} finally {
  const { basename, dirname, resolve } = await import("node:path");
  if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-t7-probe-")) throw new Error("Unsafe cleanup path");
  await fs.rm(parent, { recursive: true, force: true });
}
