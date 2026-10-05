import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
// Compiled production modules only; never tests/ or src/ development imports.
import { openDurableEtherMemoriesInternal } from "../dist/core/DurableEtherMemories.js";
import { encodeSnapshotPayload } from "../dist/persistence/snapshotPayload.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const failureOf = r => { assert.equal(r.ok, false, JSON.stringify(r)); return r.error; };
const simulate = process.argv.includes("--simulate-directory-barriers");
const tailOnly = process.argv.includes("--tail-only");
if (process.platform === "win32" && !simulate) {
  throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
}
const io = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;
// Active-resource counts do not include idle fs.FileHandles. Track the actual
// WAL/scratch handles instead, releasing ownership only after successful close.
const handles = new Set();
let openedHandles = 0;
let closedHandles = 0;
let peakHandles = 0;
const files = { ...nodeWalIO, open: async (path, create) => {
  const handle = await nodeWalIO.open(path, create);
  const token = { path };
  handles.add(token);
  openedHandles++;
  peakHandles = Math.max(peakHandles, handles.size);
  return { ...handle, close: async () => {
    await handle.close();
    if (handles.delete(token)) closedHandles++;
  } };
} };
const assertHandlesClosed = () => assert.equal(handles.size, 0,
  `unclosed WAL/scratch handles: ${JSON.stringify([...handles])}`);

const snapshotOf = runtime => value(encodeSnapshotPayload(value(runtime.exportData())));
// Compare persisted JSON values: undefined optional properties are not bytes
// in the snapshot, while timestamps/IDs and all defined fields remain exact.
const persistedView = object => JSON.parse(JSON.stringify(object));
let checks = 0;
const check = (label, condition) => { assert.equal(condition, true, label); checks++; console.log(`PASS ${label}`); };
const diagnostic = (label, measure) => console.log(`DIAG ${label} ${typeof measure === "number" ? Math.round(measure) : measure}`);

const MUTATIONS = 10_000;
const ENVELOPE = 256 * 1024; // configured instance envelope: maintenance fires repeatedly

let parent;
try {
  parent = await fs.mkdtemp(join(tmpdir(), "ether-t10-probe-"));
  const idlePath = join(parent, "idle-handle-control");
  const idle = await files.open(idlePath, true);
  assert.throws(assertHandlesClosed, /unclosed WAL\/scratch handles/);
  await idle.close();
  await fs.unlink(idlePath);
  assertHandlesClosed();
  check("descriptor guard detects a real idle file handle and clears only after close", true);
  const directory = join(parent, "store");
  const userId = "t10-probe-user";
  const open = () => openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files, maxActiveWalBytes: ENVELOPE });

  // Bootstrap: create the store, then one committed frame so the active WAL
  // is non-empty for the first maintenance decision.
  let runtime = value(await openDurableEtherMemoriesInternal({ userId, directory }, { io, files, maxActiveWalBytes: ENVELOPE }));
  value(await runtime.addMemory({ content: "t10 probe seed note", tags: ["t10"], status: "active" }, "t10-seed-1"));
  const seedNotes = persistedView(value(runtime.exportData()).memoryNotes);
  const seedTip = value(runtime.tip);
  if (tailOnly) value(await runtime.runMaintenance());
  let lastLiveSnapshot = snapshotOf(runtime);
  let lastLiveTip = value(runtime.tip);
  value(await runtime.close());
  assertHandlesClosed();

  // Soak: 10,000+ durable mutations (interleaved add/delete pairs, so the live
  // store stays bounded under the frozen per-mutation precommit cost) with
  // maintenance after every batch, cold restarts, and repeated
  // threshold->rotation->GC cycles.
  let rotations = 0;
  let collections = 0;
  let noOps = 0;
  let coldRestarts = 0;
  let committed = 0;
  let peakRss = 0;
  let peakHeap = 0;
  for (let batch = 0; !tailOnly && batch < MUTATIONS; batch += 250) {
    runtime = value(await open());
    for (let i = 0; i < 250 && batch + i < MUTATIONS; i += 2) {
      const n = batch + i;
      const beforePair = BigInt(value(runtime.tip).txId);
      // The exact precommit envelope gate may reject a crossing frame mid-batch;
      // the operational answer is explicit maintenance + same-identity retry.
      let added;
      for (;;) {
        const result = await runtime.addMemory({ content: `t10 soak note ${n}`, tags: ["t10"], status: "active" }, `t10-note-${n}`);
        if (result.ok) { added = result.value; break; }
        assert.equal(result.error.code, "RECOVERY_REQUIRED", JSON.stringify(result.error));
        assert.equal(result.error.details?.reason, "resource-limit");
        const recovery = value(await runtime.runMaintenance());
        assert.deepEqual(recovery.performed, ["rotation", "garbage"]);
        rotations++;
        collections++;
      }
      for (;;) {
        const result = await runtime.deleteMemory(added.id, `t10-note-del-${n}`);
        if (result.ok) break;
        assert.equal(result.error.code, "RECOVERY_REQUIRED", JSON.stringify(result.error));
        assert.equal(result.error.details?.reason, "resource-limit");
        const recovery = value(await runtime.runMaintenance());
        assert.deepEqual(recovery.performed, ["rotation", "garbage"]);
        rotations++;
        collections++;
      }
      const afterPair = BigInt(value(runtime.tip).txId);
      if (afterPair !== beforePair + 2n) throw new Error(`tip did not advance exactly two transactions at mutation ${n}`);
      committed += 2;
    }
    const maintenance = value(await runtime.runMaintenance());
    if (maintenance.performed.length === 0) {
      noOps++;
      assert.equal(maintenance.plan.rotationRecommended, false);
    } else {
      assert.deepEqual(maintenance.performed, ["rotation", "garbage"]);
      rotations++;
      collections++;
      assert.equal(maintenance.plan.envelopeBytes, ENVELOPE);
    }
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    assert.deepEqual(persistedView(value(runtime.exportData()).memoryNotes), seedNotes);
    lastLiveSnapshot = snapshotOf(runtime);
    lastLiveTip = value(runtime.tip);
    value(await runtime.close());
    assertHandlesClosed();
    coldRestarts++;
    diagnostic("committed soak mutations", committed);
  }
  if (!tailOnly) {
  check(`soak committed ${committed} durable mutations across ${MUTATIONS} attempts`, committed === MUTATIONS);
  check(`maintenance performed ${rotations} rotation+GC cycles and ${noOps} explicit no-ops`, rotations > 5 && noOps >= 0);
  check("cold restart after every batch (recovery reopen) stayed green", coldRestarts === MUTATIONS / 250);
  check("each pair advanced the committed tip by exactly two transactions (no duplicate effect)", committed === MUTATIONS);
  diagnostic("peak rss bytes", peakRss);
  diagnostic("peak heap bytes", peakHeap);
  check("no WAL/scratch handles survive any completed soak batch", handles.size === 0 && openedHandles === closedHandles);
  diagnostic("active resources (not a descriptor count)", process.getActiveResourcesInfo().length);
  assert.equal(lastLiveTip.epochId, seedTip.epochId);
  assert.equal(BigInt(lastLiveTip.txId), BigInt(seedTip.txId) + BigInt(MUTATIONS));
  }

  // Deterministic final state: reopen via authoritative recovery and compare
  // the canonical snapshot payload byte-for-byte with the live generation.
  runtime = value(await open());
  const finalSnapshot = snapshotOf(runtime);
  const finalTip = value(runtime.tip);
  check("first cold recovery matches the last live generation byte-for-byte", finalSnapshot.equals(lastLiveSnapshot));
  assert.deepEqual(finalTip, lastLiveTip);
  const finalNoOp = value(await runtime.runMaintenance());
  check("final maintenance after the soak is a no-op (empty active WAL)", finalNoOp.performed.length === 0 && finalNoOp.plan.activeWalBytes === 0);
  value(await runtime.close());
  const reopened = value(await open());
  check("cold-recovered final snapshot is byte-identical", snapshotOf(reopened).equals(finalSnapshot));
  check("cold-recovered full tip is identical", JSON.stringify(value(reopened.tip)) === JSON.stringify(finalTip));
  const exported = value(reopened.exportData());
  assert.deepEqual(persistedView(exported.memoryNotes), seedNotes);
  check("no committed-state loss: the acknowledged seed is the exact final note collection", true);
  value(await reopened.close());

  // Writer contention: a foreign writer artifact forces WRITER_BUSY through
  // the existing frozen protocol; never an automatic lock break. A committed
  // frame first: a no-op maintenance (empty WAL) acquires no authority at all.
  runtime = value(await open());
  value(await runtime.addMemory({ content: "t10 contention note", tags: ["t10"], status: "active" }, "t10-contention-1"));
  await fs.writeFile(join(directory, "writer.lock"), "foreign authority");
  const busy = failureOf(await runtime.runMaintenance());
  assert.equal(busy.code, "WRITER_BUSY");
  assert.equal(busy.details?.maintenanceStage, "rotation");
  check("foreign writer lock surfaces WRITER_BUSY and the runtime stays ready", runtime.state === "ready");
  check("the foreign writer lock is never broken automatically", (await fs.readFile(join(directory, "writer.lock"), "utf8")) === "foreign authority");
  await fs.unlink(join(directory, "writer.lock"));
  value(await runtime.runMaintenance());
  value(await runtime.close());

  // Crash before P6: an armed rotation-scratch write failure leaves the old
  // lineage fully authoritative; a retry after the transient fault succeeds.
  let armed = true;
  let preP6Hits = 0;
  let faultingRuntime = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" },
    { io, files: { ...files, open: async (path, create) => {
      if (armed && path.includes("rotation-candidate")) { preP6Hits++; throw new Error("simulated crash before P6"); }
      return files.open(path, create);
    } }, maxActiveWalBytes: ENVELOPE }));
  value(await faultingRuntime.addMemory({ content: "t10 pre-p6 note", tags: ["t10"], status: "active" }, "t10-pre-p6-1"));
  const preP6 = failureOf(await faultingRuntime.runMaintenance());
  assert.equal(preP6Hits, 1);
  assert.equal(preP6.details?.maintenanceStage, "rotation");
  check("crash/fault before P6 stops maintenance before any destructive step", preP6.details?.maintenanceStage === "rotation");
  // The frozen rotate() routing for this fault class requires explicit
  // recovery before the retry (identical lifecycle for both entry points).
  assert.equal(faultingRuntime.state, "recovery-required");
  armed = false;
  value(await faultingRuntime.recover());
  value(await faultingRuntime.runMaintenance());
  check("maintenance retry after the pre-P6 interruption succeeds", true);
  value(await faultingRuntime.close());

  // Crash after P6 (post-activation cleanup failure): rotation committed; the
  // completed commit is reported, never rolled back, and GC never starts.
  armed = true;
  let postP6Hits = 0;
  faultingRuntime = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" },
    { io: { ...io, removeOwnedFile: async path => {
      if (armed && path.includes("wal-")) { postP6Hits++; armed = false; throw new Error("simulated post-P6 crash"); }
      return io.removeOwnedFile(path);
    } }, files, maxActiveWalBytes: ENVELOPE }));
  value(await faultingRuntime.addMemory({ content: "t10 post-p6 note", tags: ["t10"], status: "active" }, "t10-post-p6-1"));
  const postP6 = failureOf(await faultingRuntime.runMaintenance());
  assert.equal(postP6Hits, 1);
  assert.equal(postP6.details?.rotationCommitted, true);
  assert.equal(postP6.details?.maintenanceStage, "rotation");
  check("post-P6 failure reports the committed rotation and stops before GC", postP6.details?.rotationCommitted === true);
  check("the runtime remains ready after committed-pending-cleanup", faultingRuntime.state === "ready");
  value(await faultingRuntime.close());
  // The committed lineage is authoritative across a cold restart.
  const afterCommit = value(await open());
  value(await afterCommit.addMemory({ content: "t10 post-commit note", tags: ["t10"], status: "active" }, "t10-post-commit-1"));
  value(await afterCommit.runMaintenance());
  value(await afterCommit.close());

  // Crash between successful rotation and GC: the GC fault exposes the
  // completed rotation; a retry completes the deferred collection.
  let failMark = false;
  let markHits = 0;
  faultingRuntime = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" },
    { io, files: { ...files, open: async (path, create) => {
      if (failMark && create && path.includes("gc-mark")) { markHits++; throw new Error("simulated GC crash"); }
      return files.open(path, create);
    } }, maxActiveWalBytes: ENVELOPE }));
  value(await faultingRuntime.addMemory({ content: "t10 between object note ".repeat(4000), tags: ["t10"], status: "active" }, "t10-between-1"));
  failMark = true;
  const between = failureOf(await faultingRuntime.runMaintenance());
  assert.equal(markHits, 1);
  assert.equal(between.details?.maintenanceStage, "garbage");
  assert.equal(between.details?.gcDisposition, "maintenance");
  check("a GC-phase fault after successful rotation exposes completedRotation", between.details?.completedRotation !== undefined);
  check("a GC maintenance fault leaves the runtime ready", faultingRuntime.state === "ready");
  failMark = false;
  // The rotation already committed, so a maintenance retry is a correct no-op;
  // the deferred follow-on completes through the independently callable GC.
  const betweenRetry = value(await faultingRuntime.runMaintenance());
  assert.equal(betweenRetry.performed.length, 0);
  const deferredGc = value(await faultingRuntime.collectGarbage());
  check("maintenance retry after the GC interruption is a no-op and collectGarbage() completes the deferred follow-on",
    deferredGc.scannedObjects >= 0);
  value(await faultingRuntime.close());

  // Kill at a deterministic boundary: the original mutation's WAL bytes have
  // synced and the WAL directory barrier completed, but its ACK cannot return.
  // A timeout is execution allowance only, never the trigger for the kill.
  runtime = value(await open());
  const beforeKillSnapshot = value(runtime.exportData());
  const beforeKillTip = value(runtime.tip);
  value(await runtime.close());
  assertHandlesClosed();
  const distRoot = fileURLToPath(new URL("../dist/", import.meta.url));
  const childScript = join(parent, "kill-target.mjs");
  await fs.writeFile(childScript, `
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { nodeDirectoryIO } from ${JSON.stringify(pathToFileURL(join(distRoot, "persistence/directoryIO.js")).href)};
import { nodeWalIO } from ${JSON.stringify(pathToFileURL(join(distRoot, "persistence/walIO.js")).href)};
import { openDurableEtherMemoriesInternal } from ${JSON.stringify(pathToFileURL(join(distRoot, "core/DurableEtherMemories.js")).href)};
const directory = ${JSON.stringify(directory)};
const baseIO = ${simulate} ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;
let armed = false;
let walSynced = false;
const files = { ...nodeWalIO, open: async (path, create) => {
  const handle = await nodeWalIO.open(path, create);
  let wrote = false;
  return { ...handle, write: async (bytes, position) => {
    const count = await handle.write(bytes, position);
    if (armed && count > 0) wrote = true;
    return count;
  }, sync: async () => {
    await handle.sync();
    if (armed && wrote) walSynced = true;
  } };
} };
const io = { ...baseIO, syncDirectory: async path => {
  await baseIO.syncDirectory(path);
  if (armed && walSynced && path === join(directory, "wal")) {
    armed = false;
    process.channel.ref();
    process.send({ phase: "committed-before-ack", mutationId: "t10-kill-final" });
    await new Promise(() => {});
  }
} };
const opened = await openDurableEtherMemoriesInternal({ userId: ${JSON.stringify(userId)}, directory, openMode: "existing" }, { io, files });
if (!opened.ok) throw new Error(JSON.stringify(opened.error));
const runtime = opened.value;
armed = true;
const result = await runtime.addMemory({ content: "t10 kill final note", tags: ["t10"], status: "active" }, "t10-kill-final");
throw new Error("ACK escaped the armed barrier: " + JSON.stringify(result));
`);
  const child = spawn(process.execPath, [childScript], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let timer;
  let exited = false;
  const childExit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
    child.once("error", reject);
  });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.once("message", message => {
          try {
            assert.deepEqual(message, { phase: "committed-before-ack", mutationId: "t10-kill-final" });
            resolve();
          } catch (error) { reject(error); }
        });
        timer = setTimeout(() => reject(new Error("child did not reach the WAL-sync/before-ACK boundary")), 120_000);
      }),
      childExit.then(exit => { throw new Error(`child exited before kill boundary: ${JSON.stringify(exit)}`); }),
    ]);
    check("child reached the original mutation's synced-WAL/before-ACK boundary", true);
    assert.equal(child.kill("SIGKILL"), true);
    await childExit;
    check("hard kill terminated the child before its acknowledgment", true);
  } finally {
    clearTimeout(timer);
    if (!exited) { child.kill("SIGKILL"); await childExit; }
  }
  // The dead writer's authority remains fail-closed until explicit operator
  // handling. The runtime must not silently break it on recovery.
  const staleLock = join(directory, "writer.lock");
  await fs.stat(staleLock);
  const lockBytes = await fs.readFile(staleLock);
  assert.equal(failureOf(await open()).code, "WRITER_BUSY");
  assert.deepEqual(await fs.readFile(staleLock), lockBytes);
  check("hard kill leaves writer authority intact; recovery does not auto-break it", true);
  await fs.unlink(staleLock);
  const recovered = value(await open());
  assert.equal(value(recovered.exportData()).memoryNotes.filter(n => n.content === "t10 kill final note").length, 1,
    "the original child mutation must exist before a same-identity retry");
  const killSnapshot = snapshotOf(recovered);
  const killTip = value(recovered.tip);
  assert.equal(killTip.epochId, beforeKillTip.epochId);
  assert.equal(BigInt(killTip.txId), BigInt(beforeKillTip.txId) + 1n);
  assert.deepEqual(persistedView(value(recovered.exportData()).memoryNotes.filter(n => n.content !== "t10 kill final note")), persistedView(beforeKillSnapshot.memoryNotes));
  const originalNote = value(recovered.queryMemories("t10 kill final note")).find(n => n.content === "t10 kill final note");
  assert.ok(originalNote);
  for (let retry = 0; retry < 2; retry++) {
    const result = value(await recovered.addMemory({ content: "t10 kill final note", tags: ["t10"], status: "active" }, "t10-kill-final"));
    assert.deepEqual(persistedView(result), persistedView(originalNote));
    assert.deepEqual(value(recovered.tip), killTip);
    assert.deepEqual(snapshotOf(recovered), killSnapshot);
  }
  check("original-ID retries reconstruct the original generated note without a new transaction or state loss", true);
  value(await recovered.close());
  const killReopened = value(await open());
  check("hard-killed store recovers cleanly and the retry survives another cold restart",
    snapshotOf(killReopened).equals(killSnapshot));
  assert.deepEqual(value(killReopened.tip), killTip);
  value(await killReopened.close());

  // Facade: exactly 20 members; runMaintenance is a zero-argument operation.
  const facadeRuntime = value(await open());
  const members = Object.getOwnPropertyNames(facadeRuntime).sort();
  check("the durable facade exposes exactly 20 members", members.length === 20);
  check("runMaintenance is a zero-argument facade operation", facadeRuntime.runMaintenance.length === 0);
  check("maintenanceStatus is not part of the facade", !("maintenanceStatus" in facadeRuntime));
  value(await facadeRuntime.close());
  assertHandlesClosed();
  check("all settled fault/recovery paths release tracked WAL/scratch handles", openedHandles === closedHandles);
  diagnostic("tracked handles opened/closed/peak", `${openedHandles}/${closedHandles}/${peakHandles}`);

  console.log(`\nAF1 TRANCHE 10 ${tailOnly ? "TAIL ONLY (NO SOAK)" : "MAINTENANCE PROBE"}: ${checks}/${checks} checks passed`);
} finally {
  if (parent) await fs.rm(parent, { recursive: true, force: true });
}

