import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DurableRuntimeState, openDurableEtherMemoriesInternal, type DurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
import { encodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
import type { DirectoryIO } from "../src/persistence/directoryIO.js";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";

const cleanup: string[] = [];
const setup = async () => {
  const store = await bootstrap();
  cleanup.push(store.parent);
  return store;
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const failure = (result: { ok: boolean; error?: { code: string; details?: unknown } }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error!;
};
const failureDetails = (result: { ok: boolean; error?: { code: string; details?: unknown } }) => failure(result).details as Record<string, unknown>;

const transactionCount = async (directory: string, userId: string, io = simulatedDirectoryIO()) => {
  const recovery = new StartupRecovery(directory, userId, io);
  return value(await recovery.recover()).transactions;
};

const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
};

/**
 * RED 3 reproducer injection: pause the holder's commit at its own pre-lock
 * directory barrier. Every authority run opens with syncDirectory(store) and
 * repeats it right after acquiring the writer lock; a mutation performs two
 * authority runs (receipt lookup, commit), so the lookup consumes barriers
 * 1-2 and the commit's PRE-LOCK barrier is the third. Blocking there pauses
 * the holder after its lookup observed the identity absent but before it
 * holds any authority, so another runtime can commit the same identity in
 * the race window.
 */
const pauseBeforeCommitIO = (base: DirectoryIO, state: { armed: boolean; blocked: boolean; barriers: number }, storeDirectory: string,
  gate: Promise<void>) => ({ ...base, syncDirectory: async (path: string) => {
  if (state.armed && !state.blocked && path === storeDirectory) {
    state.barriers++;
    if (state.barriers === 3) {
      state.blocked = true;
      await gate;
    }
  }
  await base.syncDirectory(path);
} }) as DirectoryIO;

describe("durable runtime concurrency", { timeout: 120_000 }, () => {
  it("serializes concurrent submissions; both commit exactly once and coherently", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const [a, b] = await Promise.all([
      runtime.addMemory({ content: "concurrent one" }, "c-1"),
      runtime.addMemory({ content: "concurrent two" }, "c-2")
    ]);
    expect(a.ok && b.ok).toBe(true);
    const state = value(runtime.exportData());
    expect(state.memoryNotes.some(n => n.content === "concurrent one")).toBe(true);
    expect(state.memoryNotes.some(n => n.content === "concurrent two")).toBe(true);
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    value(await runtime.close());
  });

  it("the same mutation identity submitted concurrently resolves to one transaction", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const [a, b] = await Promise.all([
      runtime.addMemory({ content: "same identity" }, "same-1"),
      runtime.addMemory({ content: "same identity" }, "same-1")
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(value(a).id).toBe(value(b).id);
    expect(value(a).content).toBe("same identity");
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(1);
    value(await runtime.close());
  });

  it("a second runtime advancing the tip yields a retryable stale base, never a silent rebase", async () => {
    const s = await setup();
    const first = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const second = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    value(await second.addMemory({ content: "committed by second runtime" }, "advance-1"));
    const stale = await first.addMemory({ content: "first runtime attempt" }, "stale-1");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected stale failure");
    expect(stale.error.code).toBe("STALE_TRANSACTION_BASE");
    expect((failureDetails(stale).mutationId as string)).toBe("stale-1");
    expect(first.state).toBe("recovery-required");
    // The old committed generation stays coherent and readable.
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "committed by second runtime")).toBe(false);
    value(await first.recover());
    expect(first.state).toBe("ready");
    const retry = value(await first.addMemory({ content: "first runtime attempt" }, "stale-1"));
    expect(retry.content).toBe("first runtime attempt");
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "committed by second runtime")).toBe(true);
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    value(await first.close());
    value(await second.close());
  });

  it("authority contention surfaces WRITER_BUSY and never weakens the writer protocol", async () => {
    const s = await setup();
    let release: (() => void) | undefined;
    // Block the holder's commit at its post-lock checkpoint read: the writer
    // lock is definitely held while the contender attempts its own commit.
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    let blocked = false;
    const blocking = { ...s.io, readBounded: async (path: string, limit: number) => {
      if (armed && !blocked && path.includes(join("checkpoints")) && path.includes(".bin")) {
        blocked = true;
        await gate;
      }
      return s.io.readBounded(path, limit);
    } };
    const held = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: blocking as typeof s.io }));
    // The contender opens before the holder takes writer authority: a fresh
    // open while a lock is held fails closed with WRITER_BUSY.
    const contender = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    armed = true;
    const inFlight = held.addMemory({ content: "authority holder" }, "hold-1");
    await waitFor(async () => (await fs.stat(join(s.directory, "writer.lock")).then(() => true, () => false)));
    const refused = await contender.addMemory({ content: "contender" }, "contend-1");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected contention failure");
    expect(["WRITER_BUSY", "READ_ONLY_LOCKED"]).toContain(refused.error.code);
    expect(contender.state).toBe("ready");
    release!();
    value(await inFlight);
    value(await contender.recover());
    const retry = value(await contender.addMemory({ content: "contender" }, "contend-1"));
    expect(retry.content).toBe("contender");
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    value(await held.close());
    value(await contender.close());
  });

  it("reads during a failed concurrent commit never expose candidate state", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const before = value(encodeSnapshotSnapshot(runtime));
    const failing = runtime.updateMemory("absent-note", { summary: "nope" }, "failed-1");
    const during = value(encodeSnapshotSnapshot(runtime));
    const failed = await failing;
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected not-found failure");
    expect(failed.error.code).toBe("NOT_FOUND");
    expect(during).toEqual(before);
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });
});

describe("durable runtime cross-runtime same-identity race (RED 3)", { timeout: 120_000 }, () => {
  const openRuntime = async (s: Awaited<ReturnType<typeof setup>>, io: DirectoryIO): Promise<DurableEtherMemories> =>
    value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io }));

  it("a pause race with the same identity and same intent reconciles the winner, never reports corruption", async () => {
    const s = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = { armed: false, blocked: false, barriers: 0 };
    const first = await openRuntime(s, pauseBeforeCommitIO(s.io, state, s.directory, gate));
    const second = await openRuntime(s, s.io);
    state.armed = true;
    // First runtime: lookup observes "race-1" ABSENT, then pauses before its
    // commit acquires authority.
    const raced = first.addMemory({ content: "race content" }, "race-1");
    await waitFor(() => state.blocked);
    // Second runtime commits the same identity with the same intent inside
    // the race window.
    value(await second.addMemory({ content: "race content" }, "race-1"));
    release!();
    const outcome = await raced;
    // Reconciliation, not corruption; the live generation is behind the
    // durable history, so the runtime requires explicit recovery.
    expect(outcome.ok).toBe(false);
    expect(failure(outcome).code).toBe("RECOVERY_REQUIRED");
    expect((failureDetails(outcome).mutationId as string)).toBe("race-1");
    expect(first.state).toBe("recovery-required");
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(1);
    value(await first.recover());
    expect(first.state).toBe("ready");
    const retry = value(await first.addMemory({ content: "race content" }, "race-1"));
    expect(retry.content).toBe("race content");
    // Exactly one WAL transaction for the identity; the loser produced none.
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(1);
    value(await first.close());
    value(await second.close());
  });

  it("a pause race with the same identity and a conflicting intent fails closed with exactly one winner", async () => {
    const s = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = { armed: false, blocked: false, barriers: 0 };
    const first = await openRuntime(s, pauseBeforeCommitIO(s.io, state, s.directory, gate));
    const second = await openRuntime(s, s.io);
    state.armed = true;
    const raced = first.addMemory({ content: "first intent" }, "conflict-1");
    await waitFor(() => state.blocked);
    value(await second.addMemory({ content: "second intent" }, "conflict-1"));
    release!();
    const outcome = await raced;
    expect(outcome.ok).toBe(false);
    expect(failure(outcome).code).toBe("PERSISTENCE_CORRUPTION");
    // No lifecycle transition: nothing of the loser's was committed.
    expect(first.state).toBe("ready");
    // Exactly one winner: the second runtime's transaction only.
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(1);
    value(await first.recover());
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "second intent")).toBe(true);
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "first intent")).toBe(false);
    value(await first.close());
    value(await second.close());
  });

  it("a pause race with different identities from the same base yields genuine stale-base semantics", async () => {
    const s = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = { armed: false, blocked: false, barriers: 0 };
    const first = await openRuntime(s, pauseBeforeCommitIO(s.io, state, s.directory, gate));
    const second = await openRuntime(s, s.io);
    state.armed = true;
    const raced = first.addMemory({ content: "different identity attempt" }, "different-1");
    await waitFor(() => state.blocked);
    value(await second.addMemory({ content: "other runtime command" }, "different-2"));
    release!();
    const outcome = await raced;
    expect(outcome.ok).toBe(false);
    expect(failure(outcome).code).toBe("STALE_TRANSACTION_BASE");
    expect((failureDetails(outcome).mutationId as string)).toBe("different-1");
    expect(first.state).toBe("recovery-required");
    value(await first.recover());
    const retry = value(await first.addMemory({ content: "different identity attempt" }, "different-1"));
    expect(retry.content).toBe("different identity attempt");
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    value(await first.close());
    value(await second.close());
  });
});

const encodeSnapshotSnapshot = (runtime: DurableEtherMemories) => {
  const exported = runtime.exportData();
  return exported.ok ? encodeSnapshotPayload(exported.value) : exported;
};
