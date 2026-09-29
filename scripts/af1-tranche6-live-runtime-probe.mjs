import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
// Compiled production modules only; never tests/ or src/ development imports.
import * as publicApi from "../dist/index.js";
import { DurableEtherMemories } from "../dist/core/DurableEtherMemories.js";
import { StartupRecovery } from "../dist/persistence/StartupRecovery.js";
import { encodeSnapshotPayload } from "../dist/persistence/snapshotPayload.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const failureCode = r => { assert.equal(r.ok, false, JSON.stringify(r)); return r.error.code; };
const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
const io = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;

// Package public-surface gate: the durable runtime is public; the frozen
// persistence machinery beneath it stays unreachable from the root.
for (const name of ["StartupRecovery", "ProductionWalStore", "FsDurableStore", "FsWalStore", "DiskBackedMutationIndex",
  "prepareCoreMutation", "reduceProduction", "buildStateRoot", "resolveCommittedEffects"]) {
  assert.equal(name in publicApi, false, `package root must not export ${name}`);
}
assert.equal(typeof publicApi.openDurableEtherMemories, "function");
assert.equal(typeof publicApi.DurableEtherMemories, "function");

const userId = "probe-user";
const parent = await fs.mkdtemp(join(tmpdir(), "ether-t6-probe-"));
let expectedTransactions = 0;
let lostAckArmed = false;
const files = { ...nodeWalIO, open: async (path, create) => {
  const handle = await nodeWalIO.open(path, create);
  return { ...handle, sync: async () => {
    await handle.sync();
    if (lostAckArmed) { lostAckArmed = false; throw new Error("lost acknowledgment after file sync"); }
  } };
} };
try {
  const directory = join(parent, "store");
  const opened = await DurableEtherMemories.open({ userId, directory }, io, files);
  const runtime = value(opened);
  assert.equal(runtime.state, "ready");
  assert.equal(value(runtime.exportData()).memoryNotes.length, 0);
  assert.equal(value(runtime.tip).txId, "9007199254740993");

  // Live public mutations across every durable command kind, with interleaved
  // committed-only reads.
  const noteA = value(await runtime.addMemory({ content: "probe note A", tags: ["probe"] }, "probe-note-a"));
  expectedTransactions++;
  const diaryA = value(await runtime.addDiaryEntry({ content: "probe diary A", tags: ["d"] }));
  expectedTransactions++;
  value(await runtime.addGraphEdge("probe-edge-1", `memory:${noteA.id}`, `diary:${diaryA.id}`, "related_to", { why: "probe" }));
  expectedTransactions++;
  value(await runtime.updateMemory(noteA.id, { summary: "probe summary" }));
  expectedTransactions++;
  const candidate = value(await runtime.addMemory({ content: "probe candidate", status: "candidate" }));
  expectedTransactions++;
  value(await runtime.promoteCandidate(candidate.id));
  expectedTransactions++;
  const doomed = value(await runtime.addMemory({ content: "probe doomed" }));
  expectedTransactions++;
  value(await runtime.deleteMemory(doomed.id));
  expectedTransactions++;
  assert.equal(value(runtime.exportData()).memoryNotes.find(n => n.id === doomed.id), undefined);

  for (let i = 0; i < 280; i++) {
    value(await runtime.addMemory({ content: `probe bulk ${i} ` + "x".repeat(40) }));
    expectedTransactions++;
    if (i % 10 === 0) {
      // Interleaved reads observe only committed generations.
      const snapshot = value(runtime.exportData());
      assert.ok(snapshot.memoryNotes.every(n => typeof n.content === "string"));
    }
  }

  // One large object-backed mutation through the external payload-object path.
  const large = "O".repeat(80000);
  value(await runtime.addMemory({ content: large }, "probe-large"));
  expectedTransactions++;
  const objects = await fs.readdir(join(directory, "objects"));
  assert.ok(objects.length > 0, "large mutation must install external payload objects");

  // Concurrent submissions serialize inside the runtime; both commit.
  const concurrent = await Promise.all([
    runtime.addMemory({ content: "probe concurrent one" }, "probe-c-1"),
    runtime.addMemory({ content: "probe concurrent two" }, "probe-c-2")
  ]);
  assert.equal(value(concurrent[0]).content, "probe concurrent one");
  assert.equal(value(concurrent[1]).content, "probe concurrent two");
  expectedTransactions += 2;

  // A failed mutation never becomes visible and never commits.
  assert.equal(failureCode(await runtime.updateMemory("absent-note", { summary: "no" })), "NOT_FOUND");
  assert.equal(value(runtime.exportData()).memoryNotes.find(n => n.id === "absent-note"), undefined);

  // Lost ACK: ambiguous outcome blocks mutations until explicit recovery; the
  // retry with the same stable identity resolves the original transaction.
  const beforeLost = value(encodeSnapshotPayload(value(runtime.exportData())));
  lostAckArmed = true;
  const lost = await runtime.addMemory({ content: "probe lost ack" }, "probe-lost");
  assert.equal(failureCode(lost), "RECOVERY_REQUIRED");
  assert.equal(runtime.state, "recovery-required");
  assert.deepEqual(value(encodeSnapshotPayload(value(runtime.exportData()))), beforeLost);
  assert.equal(failureCode(await runtime.addMemory({ content: "blocked" })), "RECOVERY_REQUIRED");
  value(await runtime.recover());
  assert.equal(runtime.state, "ready");
  expectedTransactions++;
  const retried = value(await runtime.addMemory({ content: "probe lost ack" }, "probe-lost"));
  assert.equal(retried.content, "probe lost ack");

  // Cross-runtime stale base: a second runtime advances the tip; the first
  // gets a retryable stale failure, never a silent rebase.
  const second = value(await DurableEtherMemories.open({ userId, directory, openMode: "existing" }, io, files));
  value(await second.addMemory({ content: "probe by second runtime" }, "probe-second"));
  expectedTransactions++;
  assert.equal(failureCode(await runtime.addMemory({ content: "probe stale attempt" }, "probe-stale")), "STALE_TRANSACTION_BASE");
  assert.equal(runtime.state, "recovery-required");
  value(await runtime.recover());
  const staleRetry = value(await runtime.addMemory({ content: "probe stale attempt" }, "probe-stale"));
  assert.equal(staleRetry.content, "probe stale attempt");
  expectedTransactions++;
  assert.ok(value(second.exportData()).memoryNotes.some(n => n.content === "probe stale attempt") === false);

  const preCloseSnapshot = value(encodeSnapshotPayload(value(runtime.exportData())));
  const preCloseTip = value(runtime.tip);
  value(await runtime.close());
  value(await second.close());
  assert.equal(failureCode(await runtime.addMemory({ content: "after close" })), "CLOSED");

  // Reopen through authoritative recovery: exact persisted/live equivalence.
  const reopened = value(await DurableEtherMemories.open({ userId, directory, openMode: "existing" }, io, files));
  assert.equal(value(reopened.tip).txId, preCloseTip.txId);
  assert.deepEqual(value(encodeSnapshotPayload(value(reopened.exportData()))), preCloseSnapshot);
  assert.ok(value(reopened.exportData()).memoryNotes.some(n => n.content === large));
  assert.equal(value(reopened.exportData()).memoryNotes.find(n => n.id === doomed.id), undefined);

  // Recovery independently confirms the exact committed transaction count and
  // byte-identical state: live publication and recovery cannot drift.
  const verification = new StartupRecovery(directory, userId, io, files);
  const receipt = value(await verification.recover());
  assert.equal(receipt.transactions, expectedTransactions);
  assert.deepEqual(value(encodeSnapshotPayload(value(verification.read()).snapshot)), preCloseSnapshot);
  assert.deepEqual(value(verification.read()).tip, preCloseTip);
  value(await reopened.close());

  const walFiles = await fs.readdir(join(directory, "wal"));
  const walBytes = (await fs.stat(join(directory, "wal", walFiles[0]))).size;
  assert.ok(walBytes > 0);
  const snapshotSha256 = createHash("sha256").update(preCloseSnapshot).digest("hex");
  console.log(JSON.stringify({
    transactions: expectedTransactions,
    walBytes,
    objectCount: objects.length,
    snapshotBytes: preCloseSnapshot.length,
    snapshotSha256,
    finalTip: preCloseTip.txId,
    simulatedDirectoryBarriers: simulate,
    nativePowerLossClaim: false
  }, null, 2));
  console.log("TRANCHE6 LIVE DURABLE RUNTIME PROBE: PASS");
} finally {
  const { basename, dirname, resolve } = await import("node:path");
  if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-t6-probe-")) throw new Error("Unsafe cleanup path");
  await fs.rm(parent, { recursive: true, force: true });
}
