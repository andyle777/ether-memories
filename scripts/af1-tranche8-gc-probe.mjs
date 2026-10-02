import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
// Compiled production modules only; never tests/ or src/ development imports.
import { openDurableEtherMemoriesInternal } from "../dist/core/DurableEtherMemories.js";
import { collectDurableGarbage } from "../dist/persistence/objectReclamation.js";
import { encodeSnapshotPayload } from "../dist/persistence/snapshotPayload.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";
import { DirectoryIoError } from "../dist/persistence/directoryIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const failureCode = r => { assert.equal(r.ok, false, JSON.stringify(r)); return r.error.code; };
const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
const io = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;
const files = nodeWalIO;

const snapshotOf = runtime => value(encodeSnapshotPayload(value(runtime.exportData())));
const objectNames = async directory => (await fs.readdir(join(directory, "objects")).catch(() => [])).sort();
const injectOrphan = async (directory, content) => {
  const digest = createHash("sha256").update(content).digest("hex");
  await fs.mkdir(join(directory, "objects"), { recursive: true });
  await fs.writeFile(join(directory, "objects", `${digest}.bin`), content);
  return `${digest}.bin`;
};
let checks = 0;
const check = (label, condition) => { assert.equal(condition, true, label); checks++; console.log(`PASS ${label}`); };

let parent;
try {
  parent = await fs.mkdtemp(join(tmpdir(), "ether-t8-probe-"));
  const directory = join(parent, "store");
  const userId = "t8-probe-user";
  const largeContent = "t8 probe large object payload ".repeat(3000);

  // Bootstrap with committed object-backed mutations (active-WAL roots).
  const runtime = value(await openDurableEtherMemoriesInternal({ userId, directory }, { io, files }));
  const noteA = value(await runtime.addMemory({ content: largeContent, tags: ["t8"], status: "active" }, "probe-note-a"));
  const largeOriginal = value(await runtime.addMemory({ content: largeContent + " original", tags: ["t8"], status: "active" }, "probe-note-large-1"));

  // Rotation 1: the large mutation's roots now exist ONLY in receipt history.
  const rotationOne = value(await runtime.rotate());
  check("rotation 1 retired the WAL segment", rotationOne.receiptCount >= 2);

  // Later application updates/deletions of the same entities.
  value(await runtime.updateMemory(noteA.id, { content: "updated small note" }, "probe-note-a-update"));
  value(await runtime.deleteMemory(largeOriginal.id, "probe-note-large-2"));

  // Deliberate orphans: injected debris.
  const orphanOne = await injectOrphan(directory, "t8 injected orphan one");
  const orphanTwo = await injectOrphan(directory, "t8 injected orphan two");

  const snapshotBefore = snapshotOf(runtime);
  const tipBefore = value(runtime.tip);
  const objectsBefore = await objectNames(directory);

  const summary = value(await runtime.collectGarbage());
  check("only the injected orphans were reclaimed", summary.reclaimedObjects === 2);
  check("authoritative objects all survived", (await objectNames(directory)).length === objectsBefore.length - 2);
  check("marked references match surviving authoritative objects", summary.markedReferences === objectsBefore.length - 2);
  check("state is unchanged by garbage collection", Buffer.from(snapshotOf(runtime)).equals(Buffer.from(snapshotBefore)));
  check("tip is unchanged by garbage collection", JSON.stringify(value(runtime.tip)) === JSON.stringify(tipBefore));
  check("runtime stays ready after collection", runtime.state === "ready");

  // Cold restart/recovery and exact original-result reconstruction.
  value(await runtime.close());
  const restarted = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files }));
  check("cold restart recovers the identical committed tip", JSON.stringify(value(restarted.tip)) === JSON.stringify(tipBefore));
  const retriedLarge = value(await restarted.addMemory({ content: largeContent + " original", tags: ["t8"], status: "active" }, "probe-note-large-1"));
  check("rotation-1 object-backed retry reconstructs the exact original result",
    retriedLarge.id === largeOriginal.id && retriedLarge.createdAt.getTime() === largeOriginal.createdAt.getTime());

  // Second GC is idempotent.
  const second = value(await restarted.collectGarbage());
  check("second collection reclaims nothing", second.reclaimedObjects === 0);

  // Additional rotations, then GC, then retry the rotation-1 result again.
  value(await restarted.addMemory({ content: "post-rotation note", status: "active" }, "probe-note-b"));
  value(await restarted.rotate());
  value(await restarted.rotate());
  const third = value(await restarted.collectGarbage());
  check("GC after multiple rotations still reclaims nothing authoritative", third.reclaimedObjects === 0);
  const retriedAgain = value(await restarted.addMemory({ content: largeContent + " original", tags: ["t8"], status: "active" }, "probe-note-large-1"));
  check("the rotation-1 result still reconstructs after three further rotations",
    retriedAgain.id === largeOriginal.id && retriedAgain.createdAt.getTime() === largeOriginal.createdAt.getTime());
  check("the runtime remains ready throughout", restarted.state === "ready");

  // Fault injection through the internal protocol API: unlink, barrier and
  // scratch failures are observable maintenance failures, never authority loss.
  await injectOrphan(directory, "t8 fault orphan unlink");
  const denyIo = { ...io, removeOwnedFile: async path => {
    if (path.includes(join(directory, "objects"))) throw Object.assign(new Error("denied"), { code: "EACCES" });
    await io.removeOwnedFile(path);
  } };
  const unlinkFailure = await collectDurableGarbage({ directory, io: denyIo, files });
  check("an injected unlink failure fails with READ_ONLY_LOCKED and exact partial accounting",
    failureCode(unlinkFailure) === "READ_ONLY_LOCKED"
      && unlinkFailure.error.details.reclaimedObjects === 0 && unlinkFailure.error.details.gcPhase === "G6-reclaim");
  const unlinkCleanup = value(await restarted.collectGarbage());
  check("a clean pass reclaims the unlink-denied orphan", unlinkCleanup.reclaimedObjects === 1);

  await injectOrphan(directory, "t8 fault orphan barrier");
  const barrierIo = { ...io, syncDirectory: async path => {
    if (path === join(directory, "objects")) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected barrier failure");
    await io.syncDirectory(path);
  } };
  const barrierFailure = await collectDurableGarbage({ directory, io: barrierIo, files });
  check("an injected barrier failure fails with DURABILITY_UNAVAILABLE and exact accounting",
    failureCode(barrierFailure) === "DURABILITY_UNAVAILABLE"
      && barrierFailure.error.details.reclaimedObjects === 1 && barrierFailure.error.details.gcPhase === "G6-reclaim");

  await injectOrphan(directory, "t8 fault orphan scratch");
  const scratchIo = { ...io, syncDirectory: async path => {
    if (path === join(directory, ".private")) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected scratch barrier failure");
    await io.syncDirectory(path);
  } };
  const scratchFailure = await collectDurableGarbage({ directory, io: scratchIo, files });
  check("an injected scratch-cleanup failure is an observable maintenance failure",
    failureCode(scratchFailure) === "DURABILITY_UNAVAILABLE"
      && scratchFailure.error.details.gcPhase === "G1-scratch-sweep");

  // Every remaining injected-failure orphan is reclaimed by a clean pass.
  const finalSummary = value(await restarted.collectGarbage());
  check("a clean final pass reclaims every remaining injected-failure orphan", finalSummary.reclaimedObjects === 1);
  const finalSecond = value(await restarted.collectGarbage());
  check("the final pass is idempotent", finalSecond.reclaimedObjects === 0);
  value(await restarted.close());

  // The store still cold-restarts after all fault injection.
  const finalRuntime = value(await openDurableEtherMemoriesInternal({ userId, directory, openMode: "existing" }, { io, files }));
  check("the store recovers cleanly after reclamation and fault injection", finalRuntime.state === "ready");
  value(await finalRuntime.close());

  console.log(`\nAF1 TRANCHE 8 GC PROBE: ${checks}/${checks} checks passed`);
} finally {
  if (parent) await fs.rm(parent, { recursive: true, force: true });
}
