import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import { openDurableEtherMemoriesInternal, classifyRotationFailure, gcFailureRequiresRecovery,
  type DurableEtherMemories, type DurableMaintenanceReceipt } from "../src/core/DurableEtherMemories.js";
import { WAL_LIMITS } from "../src/persistence/wal.js";
import { MAX_ACTIVE_WAL_BYTES } from "../src/persistence/receiptLedger.js";
import { encodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
import { nodeWalIO, type WalIO } from "../src/persistence/walIO.js";
import type { DirectoryIO } from "../src/persistence/directoryIO.js";
import type { GcPhase } from "../src/persistence/objectReclamation.js";
import * as publicApi from "../src/index.js";

const cleanup: string[] = [];
const setup = async () => {
  const store = await bootstrap();
  cleanup.push(store.parent);
  return store;
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const failure = (result: { ok: boolean; error?: { code: string; message?: string; details?: unknown } }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error!;
};
const failureDetails = (result: { ok: boolean; error?: { code: string; message?: string; details?: unknown } }) =>
  (failure(result).details ?? {}) as Record<string, unknown>;
const openRuntime = async (store: Awaited<ReturnType<typeof bootstrap>>,
  deps: { maxActiveWalBytes?: number; io?: DirectoryIO; files?: WalIO; gcPhases?: string[] } = {}) =>
  value(await openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId, directory: store.directory, openMode: "existing" },
    { io: deps.io ?? store.io, files: deps.files ?? nodeWalIO, maxActiveWalBytes: deps.maxActiveWalBytes,
      gcInstrumentation: deps.gcPhases
        ? { at: async (phase: GcPhase) => { deps.gcPhases!.push(phase); } }
        : undefined }));
const note = (runtime: DurableEtherMemories, content: string, mutationId: string) =>
  runtime.addMemory({ content, tags: ["maintenance"], status: "active" }, mutationId);
const snapshotBytes = (runtime: DurableEtherMemories) => value(encodeSnapshotPayload(value(runtime.exportData())));
const tipOf = (runtime: DurableEtherMemories) => value(runtime.tip);
const walBytes = async (directory: string) => {
  let total = 0;
  try {
    for (const name of await fs.readdir(join(directory, "wal"))) total += (await fs.stat(join(directory, "wal", name))).size;
  } catch { /* no wal content */ }
  return total;
};
const committedWalBytes = async (store: Awaited<ReturnType<typeof bootstrap>>, content: string) => {
  const runtime = await openRuntime(store);
  value(await note(runtime, content, "size-probe-1"));
  value(await runtime.close());
  return walBytes(store.directory);
};

describe("Tranche 10 maintenance orchestration", { timeout: 300_000 }, () => {
  it("exposes exactly the 20-member facade: runMaintenance present, maintenanceStatus absent", async () => {
    const s = await setup();
    const runtime = await openRuntime(s);
    const approved = ["state", "tip", "queryMemories", "queryMemoriesDetailed", "buildMemoryContext",
      "getSystemState", "exportData", "addMemory", "updateMemory", "promoteCandidate", "deleteMemory",
      "addDiaryEntry", "updateDiary", "deleteDiary", "addGraphEdge", "rotate", "collectGarbage",
      "runMaintenance", "recover", "close"].sort();
    expect(approved.length).toBe(20);
    expect(Object.getOwnPropertyNames(runtime).sort()).toEqual(approved);
    expect("maintenanceStatus" in runtime).toBe(false);
    expect((publicApi as Record<string, unknown>).maintenanceStatus).toBeUndefined();
    expect((publicApi as Record<string, unknown>).runMaintenance).toBeUndefined();
    // The public receipt type is root-exported through the module surface.
    expect(Object.hasOwn(publicApi, "DurableMaintenanceReceipt")).toBe(false); // type-only export
    value(await runtime.close());
  });

  it("classifies every frozen rotation failure case through one shared internal table", () => {
    // Ordinary pre-activation failure: ready, no detail marks.
    const ordinary = classifyRotationFailure({ code: "WRITER_BUSY", details: { phase: "P2" } });
    expect(ordinary).toEqual({ moveToRecoveryRequired: false });
    // Committed / pending cleanup: additive rotationCommitted, stays ready.
    const committed = classifyRotationFailure({ code: "RECOVERY_REQUIRED",
      details: { activated: true, phase: "post-activation" } });
    expect(committed.moveToRecoveryRequired).toBe(false);
    expect(committed.markedDetails).toMatchObject({ rotationCommitted: true, phase: "post-activation" });
    // HEAD durability uncertainty: recovery-required plus the additive mark.
    const uncertain = classifyRotationFailure({ code: "RECOVERY_REQUIRED",
      details: { activationState: "head-renamed-durability-unconfirmed" } });
    expect(uncertain.moveToRecoveryRequired).toBe(true);
    expect(uncertain.markedDetails).toMatchObject({ rotationDurabilityUncertain: true });
    // RECOVERY_REQUIRED and STALE_TRANSACTION_BASE: recovery-required, verbatim passthrough.
    expect(classifyRotationFailure({ code: "RECOVERY_REQUIRED", details: { phase: "P4" } }))
      .toEqual({ moveToRecoveryRequired: true });
    expect(classifyRotationFailure({ code: "STALE_TRANSACTION_BASE", details: { phase: "P1" } }))
      .toEqual({ moveToRecoveryRequired: true });
    // Frozen GC precedence: authority > authoritative > maintenance > conservative code routing.
    expect(gcFailureRequiresRecovery({ code: "READ_ONLY_LOCKED", details: { authorityReleaseFailed: true } })).toBe(true);
    expect(gcFailureRequiresRecovery({ code: "PERSISTENCE_CORRUPTION", details: { gcDisposition: "authoritative" } })).toBe(true);
    expect(gcFailureRequiresRecovery({ code: "READ_ONLY_LOCKED", details: { gcDisposition: "maintenance" } })).toBe(false);
    expect(gcFailureRequiresRecovery({ code: "PERSISTENCE_CORRUPTION", details: {} })).toBe(true);
    expect(gcFailureRequiresRecovery({ code: "READ_ONLY_LOCKED", details: {} })).toBe(false);
  });

  it("no-op below threshold under the default 30 MiB envelope", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "default envelope note");
    const runtime = await openRuntime(s);
    const tip = tipOf(runtime);
    const outcome = await runtime.runMaintenance();
    const receipt = value(outcome);
    expect(receipt.performed).toEqual([]);
    expect(receipt.plan).toEqual({
      activeWalBytes: frameBytes,
      envelopeBytes: MAX_ACTIVE_WAL_BYTES,
      headroomBytes: MAX_ACTIVE_WAL_BYTES - frameBytes,
      rotationRecommended: false,
      reason: "within-headroom"
    });
    expect(receipt.rotation).toBeUndefined();
    expect(receipt.garbage).toBeUndefined();
    expect(runtime.state).toBe("ready");
    expect(tipOf(runtime)).toEqual(tip);
    value(await runtime.close());
  });

  it("exact threshold equality is admissible: no recommendation at headroom == frameBytes", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "equality note");
    const runtime = await openRuntime(s, { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes });
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual([]);
    expect(receipt.plan.rotationRecommended).toBe(false);
    expect(receipt.plan.headroomBytes).toBe(WAL_LIMITS.frameBytes);
    expect(receipt.plan.reason).toBe("within-headroom");
    value(await runtime.close());
  });

  it("the first byte beyond safe headroom recommends and performs rotation then GC", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "beyond note");
    const gcPhases: string[] = [];
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, gcPhases });
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    expect(receipt.plan.rotationRecommended).toBe(true);
    expect(receipt.plan.headroomBytes).toBe(WAL_LIMITS.frameBytes - 1);
    expect(receipt.plan.reason).toBe("rotation-headroom");
    expect(receipt.rotation).toBeDefined();
    expect(receipt.rotation!.retiredWalBytes).toBe(frameBytes);
    expect(receipt.garbage).toBeDefined();
    expect(gcPhases.length).toBeGreaterThan(0);
    // Generation-neutral: the published generation and tip are identical.
    expect(runtime.state).toBe("ready");
    expect(tipOf(runtime)).toEqual(tip);
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    // The retired WAL is gone: the next maintenance pass is a no-op on the empty segment.
    const followUp = value(await runtime.runMaintenance());
    expect(followUp.performed).toEqual([]);
    expect(followUp.plan.activeWalBytes).toBe(0);
    expect(followUp.plan.rotationRecommended).toBe(false);
    // The store still serves mutations through the new lineage.
    value(await note(runtime, "post-maintenance note", "post-maintenance-1"));
    value(await runtime.close());
  });

  it("an envelope of exactly one frame cap recommends only when a frame exists", async () => {
    const s = await setup();
    // Empty WAL under a 1 MiB envelope: exactly enough room for one maximal frame.
    const emptyRuntime = await openRuntime(s, { maxActiveWalBytes: WAL_LIMITS.frameBytes });
    const emptyReceipt = value(await emptyRuntime.runMaintenance());
    expect(emptyReceipt.performed).toEqual([]);
    expect(emptyReceipt.plan.activeWalBytes).toBe(0);
    expect(emptyReceipt.plan.rotationRecommended).toBe(false);
    value(await emptyRuntime.close());
    // With one committed frame the headroom is exhausted by the cap.
    const frameBytes = await committedWalBytes(s, "one-mib note");
    const runtime = await openRuntime(s, { maxActiveWalBytes: WAL_LIMITS.frameBytes });
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    value(await runtime.close());
    void frameBytes;
  });

  it("a sub-cap configured envelope recommends on content but never repeats empty rotations", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "small envelope note");
    const runtime = await openRuntime(s, { maxActiveWalBytes: frameBytes + 10 });
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    expect(receipt.plan.envelopeBytes).toBe(frameBytes + 10);
    expect(receipt.plan.headroomBytes).toBe(10);
    // Post-rotation the WAL is empty: an empty segment never re-recommends rotation.
    const followUp = value(await runtime.runMaintenance());
    expect(followUp.performed).toEqual([]);
    expect(followUp.plan.activeWalBytes).toBe(0);
    expect(followUp.plan.rotationRecommended).toBe(false);
    value(await runtime.close());
  });

  it("an empty WAL with a sub-cap envelope is a no-op", async () => {
    const s = await setup();
    const runtime = await openRuntime(s, { maxActiveWalBytes: 1024 });
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual([]);
    expect(receipt.plan).toEqual({
      activeWalBytes: 0,
      envelopeBytes: 1024,
      headroomBytes: 1024,
      rotationRecommended: false,
      reason: "within-headroom"
    });
    value(await runtime.close());
  });

  it("an ordinary rotation failure stops maintenance before GC and preserves the rotate() routing", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "ordinary failure note");
    let armed = true;
    const failingFiles: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (armed && path.includes("rotation-candidate")) throw new Error("simulated ENOSPC");
      return nodeWalIO.open(path, create);
    } };
    const gcPhases: string[] = [];
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, files: failingFiles, gcPhases });
    const outcome = await runtime.runMaintenance();
    expect(outcome.ok).toBe(false);
    expect(failureDetails(outcome).maintenanceStage).toBe("rotation");
    expect(gcPhases).toEqual([]);
    // The identical fault through public rotate() routes the SAME way.
    const rotateRuntime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, files: failingFiles });
    const rotateOutcome = await rotateRuntime.rotate();
    expect(failure(rotateOutcome).code).toBe(failure(outcome).code);
    expect(failure(rotateOutcome).message).toBe(failure(outcome).message);
    expect(rotateRuntime.state).toBe(runtime.state);
    value(await rotateRuntime.close());
    value(await runtime.close());
    // Disarm: the same maintenance then succeeds end to end.
    armed = false;
    const fresh = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, files: failingFiles });
    const receipt = value(await fresh.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    value(await fresh.close());
  });

  it("committed-pending-cleanup rotation stops maintenance before GC and stays ready", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "committed failure note");
    let armed = false;
    const faulting: DirectoryIO = { ...s.io, removeOwnedFile: async path => {
      if (armed && path.includes("wal-")) { armed = false; throw new Error("reclaim failure"); }
      return s.io.removeOwnedFile(path);
    } };
    const gcPhases: string[] = [];
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, io: faulting, gcPhases });
    armed = true;
    const outcome = await runtime.runMaintenance();
    expect(failureDetails(outcome)).toMatchObject({
      maintenanceStage: "rotation",
      rotationCommitted: true,
      phase: "post-activation"
    });
    expect(gcPhases).toEqual([]);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("HEAD durability uncertainty routes to recovery-required and never starts GC", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "uncertain note");
    let renamed = false;
    let disarm = false;
    const faulting: DirectoryIO = { ...s.io,
      activateFile: async (candidate, destination) => {
        const activated = await s.io.activateFile(candidate, destination);
        if (destination.endsWith("HEAD")) renamed = true;
        return activated;
      },
      syncDirectory: async path => {
        if (!disarm && renamed && path === s.directory) throw new Error("post-rename barrier failure");
        return s.io.syncDirectory(path);
      } };
    const gcPhases: string[] = [];
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, io: faulting, gcPhases });
    const outcome = await runtime.runMaintenance();
    expect(failureDetails(outcome)).toMatchObject({
      maintenanceStage: "rotation",
      rotationDurabilityUncertain: true,
      activationState: "head-renamed-durability-unconfirmed"
    });
    expect(gcPhases).toEqual([]);
    expect(runtime.state).toBe("recovery-required");
    disarm = true;
    value(await runtime.recover());
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("runMaintenance routes rotation failures identically to public rotate()", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "equivalence note");
    const envelope = frameBytes + WAL_LIMITS.frameBytes - 1;
    const build = async (fault: () => WalIO) => {
      const faulting = fault();
      const runtime = await openRuntime(s, { maxActiveWalBytes: envelope, files: faulting });
      return runtime;
    };
    // Ordinary pre-activation fault: same code/message/lifecycle from both entry points.
    let armedRotate = true;
    let armedMaintenance = true;
    const rotateOutcome = await (async () => {
      const runtime = await build(() => ({ ...nodeWalIO, open: async (path, create) => {
        if (armedRotate && path.includes("rotation-candidate")) throw new Error("simulated ENOSPC");
        return nodeWalIO.open(path, create);
      } }));
      const outcome = await runtime.rotate();
      armedRotate = false;
      value(await runtime.close());
      return outcome;
    })();
    const maintenanceOutcome = await (async () => {
      const runtime = await build(() => ({ ...nodeWalIO, open: async (path, create) => {
        if (armedMaintenance && path.includes("rotation-candidate")) throw new Error("simulated ENOSPC");
        return nodeWalIO.open(path, create);
      } }));
      const outcome = await runtime.runMaintenance();
      armedMaintenance = false;
      value(await runtime.close());
      return outcome;
    })();
    expect(failure(maintenanceOutcome).code).toBe(failure(rotateOutcome).code);
    expect(failure(maintenanceOutcome).message).toBe(failure(rotateOutcome).message);
    expect(failureDetails(maintenanceOutcome).maintenanceStage).toBe("rotation");
    // Committed/pending-cleanup equivalence: rotate()'s additive marks are preserved
    // verbatim inside runMaintenance's error (plus only the orchestration stage).
    let armedCommit = false;
    const committedFault = () => ({ ...s.io, removeOwnedFile: async (path: string) => {
      if (armedCommit && path.includes("wal-")) { armedCommit = false; throw new Error("reclaim failure"); }
      return s.io.removeOwnedFile(path);
    } });
    armedCommit = true;
    const rotateRuntime = await openRuntime(s, { maxActiveWalBytes: envelope, io: committedFault() });
    const rotateCommitted = await rotateRuntime.rotate();
    value(await rotateRuntime.close());
    // A fresh identically-prepared store for the maintenance leg: the first
    // leg's rotation already committed, so its successor would see an empty
    // active WAL and correctly no-op.
    const s2 = await setup();
    const frameBytes2 = await committedWalBytes(s2, "equivalence note");
    armedCommit = true;
    const maintenanceRuntime = await openRuntime(s2,
      { maxActiveWalBytes: frameBytes2 + WAL_LIMITS.frameBytes - 1, io: committedFault() });
    const maintenanceCommitted = await maintenanceRuntime.runMaintenance();
    value(await maintenanceRuntime.close());
    expect(failure(maintenanceCommitted).code).toBe(failure(rotateCommitted).code);
    expect(failure(maintenanceCommitted).message).toBe(failure(rotateCommitted).message);
    expect(failureDetails(maintenanceCommitted).rotationCommitted).toBe(true);
    expect(failureDetails(maintenanceCommitted).maintenanceStage).toBe("rotation");
  });

  it("a GC maintenance failure after successful rotation exposes completedRotation and stays ready", async () => {
    const s = await setup();
    // An object-backed note: GC's mark stream then has real records and its
    // cascade sorter must create mark scratch runs for the fault to hit.
    const frameBytes = await committedWalBytes(s, "y".repeat(80 * 1024));
    let failScratch = false;
    const failingFiles: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (failScratch && create && path.includes("gc-mark")) throw new Error("injected mark-run create failure");
      return nodeWalIO.open(path, create);
    } };
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, files: failingFiles });
    const snapshot = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    failScratch = true;
    const outcome = await runtime.runMaintenance();
    const details = failureDetails(outcome);
    expect(details.maintenanceStage).toBe("garbage");
    expect(details.gcDisposition).toBe("maintenance");
    expect((details.completedRotation as DurableMaintenanceReceipt["rotation"])).toBeDefined();
    expect((details.completedRotation as Record<string, unknown>).retiredWalBytes).toBe(frameBytes);
    // The rotation is committed and NOT rolled back: the retired WAL is gone and
    // the published generation is identical.
    expect(runtime.state).toBe("ready");
    expect(tipOf(runtime)).toEqual(tip);
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    expect(await walBytes(s.directory)).toBe(0);
    // Disarm: a plain collectGarbage() then completes the deferred follow-on.
    failScratch = false;
    const gc = value(await runtime.collectGarbage());
    expect(gc.scannedObjects).toBeGreaterThanOrEqual(0);
    value(await runtime.close());
  });

  it("a GC authoritative failure after successful rotation routes to recovery-required", async () => {
    const s = await setup();
    // A committed object-backed mutation whose object file then vanishes: the
    // receipt/WAL marks reference a digest that is missing from the physical
    // inventory - frozen authoritative corruption, never garbage.
    const runtime = await openRuntime(s, { maxActiveWalBytes: 512 * 1024 });
    value(await runtime.addMemory({ content: "x".repeat(80 * 1024), status: "active" }, "object-backed-1"));
    const objectsDir = join(s.directory, "objects");
    const names = await fs.readdir(objectsDir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) await fs.unlink(join(objectsDir, name));
    const snapshot = snapshotBytes(runtime);
    const outcome = await runtime.runMaintenance();
    const details = failureDetails(outcome);
    expect(details.maintenanceStage).toBe("garbage");
    expect(details.gcDisposition).toBe("authoritative");
    expect((details.completedRotation as Record<string, unknown>)).toBeDefined();
    expect(runtime.state).toBe("recovery-required");
    // The published generation is unchanged; committed reads remain available.
    expect(snapshotBytes(runtime)).toEqual(snapshot);
    value(await runtime.close());
  });

  it("a GC authority-release failure after successful rotation forces recovery-required", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "authority release note");
    // Rotation and GC each acquire and release writer authority once after
    // arming (the open's own release predates it); the fault fires on GC's
    // release - the second armed writer.lock removal.
    let failLockRelease = false;
    let armedReleases = 0;
    const faulting: DirectoryIO = { ...s.io, removeOwnedFile: async path => {
      if (path.endsWith("writer.lock") && failLockRelease) {
        armedReleases += 1;
        if (armedReleases === 2) {
          throw Object.assign(new Error("lock release denied"), { code: "EPERM" });
        }
      }
      return s.io.removeOwnedFile(path);
    } };
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1, io: faulting });
    failLockRelease = true;
    const outcome = await runtime.runMaintenance();
    const details = failureDetails(outcome);
    expect(details.maintenanceStage).toBe("garbage");
    expect(details.authorityReleaseFailed).toBe(true);
    expect((details.completedRotation as Record<string, unknown>)).toBeDefined();
    expect(runtime.state).toBe("recovery-required");
    // Frozen contract: the stale lock is never broken automatically.
    expect(await fs.stat(join(s.directory, "writer.lock"))).toBeTruthy();
    value(await runtime.close());
  });

  it("serializes with mutations behind the single-flight queue without nested enqueue", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "queue order note");
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1 });
    const tipBefore = BigInt(tipOf(runtime).txId);
    // Three queued operations: a mutation, maintenance, another mutation. All
    // must complete (a self-deadlocked runMaintenance would hang this test).
    const [mutationOne, maintenance, mutationTwo] = await Promise.all([
      note(runtime, "queued before maintenance", "queued-1"),
      runtime.runMaintenance(),
      note(runtime, "queued after maintenance", "queued-2")
    ]);
    expect(value(mutationOne).content).toBe("queued before maintenance");
    expect(value(maintenance).performed).toEqual(["rotation", "garbage"]);
    expect(value(mutationTwo).content).toBe("queued after maintenance");
    expect(runtime.state).toBe("ready");
    expect(BigInt(tipOf(runtime).txId)).toBe(tipBefore + 2n);
    value(await runtime.close());
  });

  it("surfaces WRITER_BUSY pass-through and never breaks a foreign writer lock", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "writer contention note");
    const runtime = await openRuntime(s,
      { maxActiveWalBytes: frameBytes + WAL_LIMITS.frameBytes - 1 });
    // A foreign writer artifact: the frozen contract never auto-breaks it.
    await fs.writeFile(join(s.directory, "writer.lock"), "foreign authority");
    const outcome = await runtime.runMaintenance();
    expect(failure(outcome).code).toBe("WRITER_BUSY");
    expect(failureDetails(outcome).maintenanceStage).toBe("rotation");
    expect(runtime.state).toBe("ready");
    expect(await fs.readFile(join(s.directory, "writer.lock"), "utf8")).toBe("foreign authority");
    // Explicit operator handling removes it; maintenance then proceeds.
    await fs.unlink(join(s.directory, "writer.lock"));
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    value(await runtime.close());
  });

  it("keeps the exact precommit envelope admission authoritative and unchanged", async () => {
    const s = await setup();
    const frameBytes = await committedWalBytes(s, "admission note");
    // A tiny envelope: the next frame crosses it; the EXACT precommit gate
    // (not the maintenance recommendation) rejects the mutation.
    const runtime = await openRuntime(s, { maxActiveWalBytes: frameBytes + 1 });
    const crossed = await runtime.addMemory({ content: "crossing the envelope", status: "active" }, "crossing-1");
    expect(failureDetails(crossed)).toMatchObject({
      reason: "resource-limit",
      phase: "precommit-validation"
    });
    expect(runtime.state).toBe("ready");
    // Maintenance restores admissibility without touching admission semantics.
    const receipt = value(await runtime.runMaintenance());
    expect(receipt.performed).toEqual(["rotation", "garbage"]);
    // The SAME logical mutation identity retries successfully afterwards.
    const retried = value(await runtime.addMemory({ content: "crossing the envelope", status: "active" }, "crossing-1"));
    expect(retried.content).toBe("crossing the envelope");
    value(await runtime.close());
  });

  it("cannot make a frame larger than an empty tiny envelope admissible", async () => {
    const s = await setup();
    const runtime = await openRuntime(s, { maxActiveWalBytes: 1 });
    const before = snapshotBytes(runtime);
    const tip = tipOf(runtime);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(value(await runtime.runMaintenance()).performed).toEqual([]);
      const rejected = await note(runtime, "larger than the entire envelope", "tiny-envelope-1");
      expect(failureDetails(rejected)).toMatchObject({ reason: "resource-limit", phase: "precommit-validation" });
      expect(snapshotBytes(runtime)).toEqual(before);
      expect(tipOf(runtime)).toEqual(tip);
      expect(await walBytes(s.directory)).toBe(0);
    }
    value(await runtime.close());
  });

  it("a no-op acquires no writer authority and does not break a foreign lock", async () => {
    const s = await setup();
    const runtime = await openRuntime(s);
    await fs.writeFile(join(s.directory, "writer.lock"), "foreign authority");
    expect(value(await runtime.runMaintenance()).performed).toEqual([]);
    expect(await fs.readFile(join(s.directory, "writer.lock"), "utf8")).toBe("foreign authority");
    value(await runtime.close());
  });

  it("stale live state fails rotation closed without starting GC, then recovers explicitly", async () => {
    const s = await setup();
    const gcPhases: string[] = [];
    const runtime = await openRuntime(s, { maxActiveWalBytes: 512 * 1024, gcPhases });
    const other = await openRuntime(s);
    value(await note(other, "another runtime committed this", "other-runtime-1"));
    const outcome = await runtime.runMaintenance();
    // Frozen T7 detects the mismatch while scanning the active WAL, before
    // activation; this path reports RECOVERY_REQUIRED, not mutation staleness.
    expect(failure(outcome).code).toBe("RECOVERY_REQUIRED");
    expect(failure(outcome).message).toContain("does not terminate at the captured committed tip");
    expect(failureDetails(outcome).maintenanceStage).toBe("rotation");
    expect(runtime.state).toBe("recovery-required");
    expect(gcPhases).toEqual([]);
    expect(failure(await runtime.runMaintenance()).code).toBe("RECOVERY_REQUIRED");
    expect(gcPhases).toEqual([]);
    value(await other.close());
    value(await runtime.recover());
    expect(value(await runtime.runMaintenance()).performed).toEqual(["rotation", "garbage"]);
    expect(gcPhases.length).toBeGreaterThan(0);
    value(await runtime.close());
    expect(failure(await runtime.runMaintenance()).code).toBe("CLOSED");
  });
});
