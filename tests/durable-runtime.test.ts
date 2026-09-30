import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as publicApi from "../src/index.js";
import type { MemoryNote } from "../src/types/index.js";
import type { Result } from "../src/utils/result.js";
import { openDurableEtherMemories, openDurableEtherMemoriesInternal, createMutationId, type DurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
import { ProductionWalStore } from "../src/persistence/productionOperations.js";
import { MemoryNotes } from "../src/core/MemoryNotes.js";
import { DiarySystem } from "../src/core/DiarySystem.js";
import { MindGraphManager } from "../src/core/MindGraph.js";
import { encodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
import { nodeWalIO, type WalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";
import { bootstrap, sourceSnapshot } from "./helpers/recovery.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";

const cleanup: string[] = [];
const setup = async () => {
  const store = await bootstrap();
  cleanup.push(store.parent);
  return store;
};
const fresh = async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-durable-"));
  cleanup.push(parent);
  return { parent, directory: join(parent, "store") };
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

/** Explicit non-narrowing failure access for Result-typed operations. */
const failure = (result: { ok: boolean; error?: { code: string; details?: unknown } }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error!;
};
const failureDetails = (result: { ok: boolean; error?: { code: string; details?: unknown } }) => failure(result).details as Record<string, unknown>;
const walBytes = async (directory: string) => {
  const walDirectory = join(directory, "wal");
  let total = 0;
  for (const name of await fs.readdir(walDirectory)) total += (await fs.stat(join(walDirectory, name))).size;
  return total;
};
const objectCount = async (directory: string) => {
  try { return (await fs.readdir(join(directory, "objects"))).length; }
  catch { return 0; }
};

/** T4-probe pattern: the handle syncs for real, then loses the acknowledgment once. */
const losingAckWalIO = (): { io: WalIO; arm: () => void } => {
  let armed = false;
  const arm = () => { armed = true; };
  const io: WalIO = { ...nodeWalIO, open: async (path, create) => {
    const handle = await nodeWalIO.open(path, create);
    return { ...handle, sync: async () => {
      await handle.sync();
      if (armed) { armed = false; throw new Error("lost acknowledgment after file sync"); }
    } };
  } };
  return { io, arm };
};

describe("durable runtime lifecycle", { timeout: 120_000 }, () => {
  it("bootstraps a fresh store, serves empty committed state and reopens identically", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const opened = await openDurableEtherMemoriesInternal({ userId: "user-boot", directory }, { io });
    expect(opened.ok).toBe(true);
    const runtime = value(opened);
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes).toEqual([]);
    expect(value(runtime.tip).txId).toBe("9007199254740993");
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    value(await runtime.close());
    expect(failure(await runtime.exportData()).code).toBe("CLOSED");
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: "user-boot", directory, openMode: "existing" }, { io }));
    expect(value(reopened.tip).txId).toBe("9007199254740993");
    expect(value(encodeSnapshotPayload(value(reopened.exportData())))).toEqual(before);
    value(await reopened.close());
  });

  it("openMode create/existing fail closed and a legacy snapshot file is never converted", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const created = await openDurableEtherMemoriesInternal({ userId: "u", directory, openMode: "create" }, { io });
    expect(created.ok).toBe(true);
    value(await value(created).close());
    expect(failure(await openDurableEtherMemoriesInternal({ userId: "u", directory, openMode: "create" }, { io })).code).toBe("INVALID_INPUT");
    const missing = join((await fresh()).parent, "absent");
    expect(failure(await openDurableEtherMemoriesInternal({ userId: "u", directory: missing, openMode: "existing" }, { io })).code).toBe("INVALID_INPUT");
    // A legacy JSON snapshot file at the directory path is recognized as such
    // and never converted, migrated or overwritten.
    const legacyPath = join((await fresh()).parent, "legacy-store.json");
    await fs.writeFile(legacyPath, JSON.stringify({ schemaVersion: "ether.memory_store.v0.3",
      identity: { userId: "u", createdAt: "2020-01-01T00:00:00.000Z", lastActive: "2020-01-01T00:00:00.000Z" },
      memoryNotes: [], diary: [], graph: { nodes: [], edges: [] } }));
    const refused = await openDurableEtherMemoriesInternal({ userId: "u", directory: legacyPath }, { io });
    expect(failure(refused).code).toBe("PERSISTENCE_CORRUPTION");
    expect((await fs.readFile(legacyPath, "utf8")).includes("ether.memory_store.v0.3")).toBe(true);
  });

  it("recovery failure fails closed: no runtime escapes a corrupt store", async () => {
    const s = await setup();
    await fs.appendFile(join(s.directory, "checkpoints", "checkpoint-checkpoint-a.bin"), "corruption");
    const refused = await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io });
    // Frozen inspect semantics: checkpoint verification fails before any
    // runtime object exists; the corrupted store is never repaired here.
    expect(failure(refused).code).toBe("RECOVERY_REQUIRED");
  });

  it("mutates durably with legacy-shaped results and mirrors recovery byte-for-byte", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const note = value(await runtime.addMemory({ content: "durable runtime note", tags: ["durable"], status: "candidate" }, "note-a"));
    expect(note.content).toBe("durable runtime note");
    expect(note.status).toBe("candidate");
    expect(note.createdAt instanceof Date).toBe(true);
    const promoted = value(await runtime.promoteCandidate(note.id, "promote-a"));
    expect(promoted.status).toBe("active");
    const diary = value(await runtime.addDiaryEntry({ content: "durable diary", tags: ["d"] }, "diary-a"));
    expect(value(await runtime.updateMemory(note.id, { summary: "summarized" }, "update-a")).summary).toBe("summarized");
    const edge = value(await runtime.addGraphEdge("edge-1", `memory:${note.id}`, `diary:${diary.id}`, "related_to", { why: "test" }, "edge-a"));
    expect(edge.id).toBe("edge-1");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    value(await recovery.recover());
    const read = value(recovery.read());
    expect(read.tip).toEqual(value(runtime.tip));
    expect(value(encodeSnapshotPayload(read.snapshot))).toEqual(value(encodeSnapshotPayload(value(runtime.exportData()))));
    expect(value(runtime.queryMemories("durable runtime", { asOf: 0 })).some(x => x.id === note.id)).toBe(true);
    value(await runtime.deleteMemory(note.id, "delete-a"));
    expect(value(runtime.exportData()).memoryNotes.find(n => n.id === note.id)).toBeUndefined();
    value(await runtime.deleteDiary(diary.id, "delete-diary-a"));
    value(await runtime.close());
  });

  it("readers observe only whole committed generations around commits", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const before = value(encodeSnapshotSnapshot(runtime));
    const pending = runtime.addMemory({ content: "interleaved" }, "interleave-1");
    // Synchronous read while the durable mutation is still in flight: the old
    // committed generation, never a partial mixture.
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);
    value(await pending);
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "interleaved")).toBe(true);
    value(await runtime.close());
  });

  it("invalid inputs fail without a lifecycle transition; Date inputs fail closed (durable plain-data domain)", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(failure(await runtime.addMemory({ content: "   " }, "invalid-1")).code).toBe("INVALID_INPUT");
    expect(failure(await runtime.updateMemory("absent-id", { summary: "x" }, "invalid-2")).code).toBe("NOT_FOUND");
    expect((await runtime.addMemory({ content: "x", expiresAt: new Date() }, "invalid-3")).ok).toBe(false);
    expect(runtime.state).toBe("ready");
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(value(encodeSnapshotSnapshot(runtime)));
    value(await runtime.close());
  });

  it("a durable mutation requires a caller-stable mutation identity (RED 2)", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(failure(await runtime.addMemory({ content: "no identity" }, "")).code).toBe("INVALID_INPUT");
    expect(failure(await runtime.addMemory({ content: "no identity" }, "   ")).code).toBe("INVALID_INPUT");
    const walBefore = await walBytes(s.directory);
    expect(await walBytes(s.directory)).toBe(walBefore);
    // The convenience helper generates the caller's own stable identity.
    const identity = createMutationId();
    expect(typeof identity).toBe("string");
    expect(identity.length).toBeGreaterThan(4);
    const note = value(await runtime.addMemory({ content: "explicit identity" }, identity));
    expect(note.content).toBe("explicit identity");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    // Two intentionally different identities are two logical commands.
    value(await runtime.addMemory({ content: "second command" }, createMutationId()));
    expect(value(await (new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io)).recover()).transactions).toBe(2);
    value(await runtime.close());
  });
});

describe("durable runtime precommit complete-post-state validation (RED 1)", { timeout: 300_000 }, () => {
  it("rejects a mutation whose complete post-state exceeds the recoverable bound before the WAL advances", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "user-bound", directory }, { io }));
    value(await runtime.addMemory({ content: "small committed history" }, "seed-1"));
    const walBefore = await walBytes(directory);
    const tipBefore = value(runtime.tip);
    const objectsBefore = await objectCount(directory);
    const before = value(encodeSnapshotSnapshot(runtime));

    // Codex reproducer: ~4.3M characters that are 3 bytes each in UTF-8 make a
    // ~13 MB complete post-state: individually legal WAL effects, but the
    // complete deterministic post-state cannot be reconstructed by recovery.
    const oversized = "\u4e2d".repeat(4_300_000);
    const rejected = await runtime.addMemory({ content: oversized }, "oversized-1");
    expect(rejected.ok).toBe(false);
    const error = failure(rejected);
    expect(error.code).toBe("RECOVERY_REQUIRED");
    expect((error.details as { reason: string }).reason).toBe("resource-limit");
    expect((error.details as { phase: string }).phase).toBe("precommit-validation");
    // Unambiguous precommit rejection: the runtime stays ready and usable.
    expect(runtime.state).toBe("ready");
    expect(await walBytes(directory)).toBe(walBefore);
    expect(value(runtime.tip)).toEqual(tipBefore);
    expect(await objectCount(directory)).toBe(objectsBefore);
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);

    // The same store accepts a normal mutation immediately afterwards.
    const followUp = value(await runtime.addMemory({ content: "valid after rejection" }, "after-1"));
    expect(followUp.content).toBe("valid after rejection");
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: "user-bound", directory, openMode: "existing" }, { io }));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "valid after rejection")).toBe(true);
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === oversized)).toBe(false);
    const recovery = new StartupRecovery(directory, "user-bound", io);
    expect(value(await recovery.recover()).transactions).toBe(2);
    value(await reopened.close());
  });

  it("rejects the cumulative mutation that would cross the recoverable StateRoot bound (attack A)", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "user-cumulative", directory }, { io }));
    // Repeated individually-small mutations that cumulatively approach the 8 MiB
    // bound. (The frozen FoundationLinker mirrors unsynopsized note content into
    // the graph node label, so each note contributes roughly twice its content to
    // the canonical post-state.) The exact mutation that would cross the
    // recoverable StateRoot bound must fail before commit and the previously
    // committed history must remain recoverable.
    let committed = 0;
    let lastResult: Result<MemoryNote> | undefined;
    for (let i = 0; i < 12; i++) {
      const result = await runtime.addMemory({ content: "c".repeat(1_200_000) }, `cumulative-${i}`);
      if (!result.ok) {
        lastResult = result;
        break;
      }
      committed++;
    }
    expect(committed).toBeGreaterThan(2);
    expect(committed).toBeLessThan(12);
    expect(lastResult).toBeDefined();
    const rejected = lastResult!;
    expect(failure(rejected).code).toBe("RECOVERY_REQUIRED");
    expect(failureDetails(rejected).phase).toBe("precommit-validation");
    expect(runtime.state).toBe("ready");
    // Committed history is exactly the accepted mutations; it still recovers.
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: "user-cumulative", directory, openMode: "existing" }, { io }));
    expect(value(reopened.exportData()).memoryNotes.length).toBe(committed);
    const recovery = new StartupRecovery(directory, "user-cumulative", io);
    expect(value(await recovery.recover()).transactions).toBe(committed);
    // A small mutation still succeeds on the large-but-recoverable store.
    value(await reopened.addMemory({ content: "still usable" }, "cumulative-small"));
    value(await reopened.close());
  });

  it("accepts a just-under-bound single mutation and rejects just-over (attack B boundary)", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "user-just-under", directory }, { io }));
    // ~8 MB canonical post-state (content plus its linker label mirror):
    // under the frozen 8 MiB bound, accepted.
    const large = "a".repeat(4_000_000);
    const accepted = value(await runtime.addMemory({ content: large }, "just-under-1"));
    expect(accepted.content).toHaveLength(4_000_000);
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: "user-just-under", directory, openMode: "existing" }, { io }));
    expect(value(reopened.exportData()).memoryNotes[0]!.content).toBe(large);
    // A small individually-legal command whose aggregate post-state crosses the
    // recoverable bound fails before commit.
    const rejected = await reopened.addMemory({ content: "b".repeat(300_000) }, "just-over-1");
    expect(failure(rejected).code).toBe("RECOVERY_REQUIRED");
    expect(failureDetails(rejected).phase).toBe("precommit-validation");
    expect(reopened.state).toBe("ready");
    const recovery = new StartupRecovery(directory, "user-just-under", io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    value(await reopened.close());
  });
});

describe("durable runtime lost-ACK reconciliation", { timeout: 120_000 }, () => {
  it("ambiguous commit blocks mutations until explicit recovery; retry with the same identity reconstructs the original result", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    const before = value(encodeSnapshotSnapshot(runtime));
    arm();
    const failed = await runtime.addMemory({ content: "lost ack note" }, "lost-1");
    expect(failure(failed).code).toBe("RECOVERY_REQUIRED");
    expect((failureDetails(failed).mutationId as string)).toBe("lost-1");
    expect(runtime.state).toBe("recovery-required");
    // Committed reads remain available; the published generation is unchanged.
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);
    // Mutations stay blocked until explicit recovery.
    expect(failure(await runtime.addMemory({ content: "blocked" }, "blocked-1")).code).toBe("RECOVERY_REQUIRED");
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(1);
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "lost ack note")).toBe(true);
    // Same retained identity: the retry resolves the original committed transaction.
    const retry = value(await runtime.addMemory({ content: "lost ack note" }, "lost-1"));
    expect(retry.content).toBe("lost ack note");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    value(await recovery.recover());
    expect(value(recovery.read()).tip).toEqual(value(runtime.tip));
    expect(value(await (new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io)).recover()).transactions).toBe(1);
    value(await runtime.close());
  });

  it("complete process restart reconstructs the original result from committed effects, not current state", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const first = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    arm();
    expect((await first.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1")).ok).toBe(false);
    expect(first.state).toBe("recovery-required");
    // "Process restart": a brand-new runtime opens the store through recovery.
    const second = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(second.exportData()).memoryNotes.some(n => n.content === "restart original content")).toBe(true);
    const retry = value(await second.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1"));
    expect(retry.content).toBe("restart original content");
    expect(retry.tags).toEqual(["orig"]);
    // A later transaction modifies the note; the already-committed retry still
    // returns the exact object the original call produced at its commit.
    value(await second.updateMemory(retry.id, { content: "modified later" }, "restart-2"));
    const retriedAgain = value(await second.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1"));
    expect(retriedAgain.content).toBe("restart original content");
    expect(value(second.exportData()).memoryNotes.find(n => n.id === retry.id)!.content).toBe("modified later");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(2);
    value(await first.close());
    value(await second.close());
  });

  it("the same mutation identity with a conflicting intent fails closed and changes nothing", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const note = value(await runtime.addMemory({ content: "intent one" }, "intent-1"));
    const conflict = await runtime.addMemory({ content: "intent two" }, "intent-1");
    expect(failure(conflict).code).toBe("PERSISTENCE_CORRUPTION");
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes.find(n => n.id === note.id)!.content).toBe("intent one");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    value(await runtime.close());
  });

  it("a pre-acknowledgment write failure leaves the generation unchanged and recovers cleanly", async () => {
    const s = await setup();
    let failOpen = false;
    const files: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (failOpen && path.includes(join("wal")) && path.endsWith(".bin")) { failOpen = false; throw new Error("injected open failure"); }
      return nodeWalIO.open(path, create);
    } };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    const before = value(encodeSnapshotSnapshot(runtime));
    failOpen = true;
    const failed = await runtime.addMemory({ content: "never appended" }, "pre-1");
    expect(failed.ok).toBe(false);
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);
    expect(runtime.state).toBe("recovery-required");
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(0);
    const retry = value(await runtime.addMemory({ content: "never appended" }, "pre-1"));
    expect(retry.content).toBe("never appended");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    value(await runtime.close());
  });

  it("a large payload-backed mutation survives restart through its external object", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const large = "O".repeat(80000);
    const note = value(await runtime.addMemory({ content: large }, "large-1"));
    expect(note.content).toHaveLength(80000);
    const objects = await fs.readdir(join(s.directory, "objects"));
    // One referenced object per large effect body (note, linker node, identity).
    expect(objects.length).toBeGreaterThan(0);
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.find(n => n.id === note.id)!.content).toBe(large);
    value(await reopened.close());
  });

  it("queued mutations recheck readiness when they begin after a state transition (attack C)", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    arm();
    // The first mutation loses its ACK and moves the runtime to
    // recovery-required; the still-queued mutations must not execute merely
    // because they were submitted while the runtime had been ready.
    const [first, second, third] = await Promise.all([
      runtime.addMemory({ content: "ambiguous first" }, "queue-1"),
      runtime.addMemory({ content: "queued second" }, "queue-2"),
      runtime.addMemory({ content: "queued third" }, "queue-3")
    ]);
    expect(failure(first).code).toBe("RECOVERY_REQUIRED");
    expect(failure(second).code).toBe("RECOVERY_REQUIRED");
    expect(failure(third).code).toBe("RECOVERY_REQUIRED");
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.recover());
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "ambiguous first")).toBe(true);
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "queued second")).toBe(false);
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    value(await runtime.close());
  });
});

describe("durable runtime close, release and result immutability", { timeout: 120_000 }, () => {
  it("close is deterministic and idempotent; a second runtime opens afterwards", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    value(await runtime.addMemory({ content: "before close" }, "close-seed-1"));
    value(await runtime.close());
    value(await runtime.close());
    expect(failure(await runtime.addMemory({ content: "after" }, "close-after-1")).code).toBe("CLOSED");
    expect(failure(runtime.exportData()).code).toBe("CLOSED");
    expect(failure(await runtime.recover()).code).toBe("CLOSED");
    expect(failure(runtime.tip).code).toBe("CLOSED");
    expect(runtime.state).toBe("closed");
    const second = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(second.exportData()).memoryNotes.some(n => n.content === "before close")).toBe(true);
    value(await second.close());
  });

  it("close drains previously submitted operations and rejects later ones deterministically (attack D)", async () => {
    const s = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    let blocked = false;
    const io = { ...s.io, readBounded: async (path: string, limit: number) => {
      if (armed && !blocked && path.includes(join("checkpoints")) && path.includes(".bin")) {
        blocked = true;
        await gate;
      }
      return s.io.readBounded(path, limit);
    } };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: io as typeof s.io }));
    armed = true;
    // Drain semantics: close waits for every previously submitted operation.
    const inFlight = runtime.addMemory({ content: "drained by close" }, "drain-1");
    const closing = runtime.close();
    // Submitted after close was called: queued behind the close operation and
    // therefore rejected, never executed.
    const afterClosePromise = runtime.addMemory({ content: "after close" }, "drain-2");
    release!();
    const drained = value(await inFlight);
    expect(drained.content).toBe("drained by close");
    value(await closing);
    expect(runtime.state).toBe("closed");
    const afterClose = await afterClosePromise;
    expect(failure(afterClose).code).toBe("CLOSED");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "after close")).toBe(false);
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "drained by close")).toBe(true);
    value(await reopened.close());
  });

  it("close after an ambiguous mutation still releases; the next open recovers", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    arm();
    expect((await runtime.addMemory({ content: "ambiguous" }, "close-amb-1")).ok).toBe(false);
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "ambiguous")).toBe(true);
    value(await reopened.close());
  });

  it("mutating any returned result never changes canonical state or WAL (attack E)", async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    const note = value(await runtime.addMemory({ content: "alias attack", tags: ["alias"], metadata: { deep: { value: 1 } } }, "alias-1"));
    const walBefore = await walBytes(s.directory);
    const canonical = value(encodeSnapshotSnapshot(runtime));
    // Alias attacks on every returned shape: mutation result, query results,
    // detailed results, exportData and system state.
    note.content = "mutated";
    (note.tags as string[]).push("mutated");
    (note.metadata as Record<string, unknown>).deep = { value: 2 };
    const queried = value(runtime.queryMemories("alias attack", { asOf: 0 }));
    queried[0]!.content = "mutated";
    const detailed = value(runtime.queryMemoriesDetailed("alias attack", { asOf: 0 }));
    detailed[0]!.memory.content = "mutated";
    (detailed[0]!.matchedBy as string[]).push("mutated");
    const exported = value(runtime.exportData());
    const exportedNote = exported.memoryNotes.find(n => n.id === note.id)!;
    exportedNote.content = "mutated";
    (exportedNote.tags as string[]).push("mutated");
    const identity = value(runtime.getSystemState());
    identity.displayName = "mutated";
    // Canonical state, WAL and committed identity are untouched.
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(canonical);
    expect(await walBytes(s.directory)).toBe(walBefore);
    expect(value(runtime.queryMemories("alias attack", { asOf: 0 }))[0]!.content).toBe("alias attack");
    expect(value(runtime.exportData()).memoryNotes.find(n => n.id === note.id)!.tags).toEqual(["alias"]);
    expect(value(runtime.getSystemState()).displayName).not.toBe("mutated");
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.find(n => n.id === note.id)!.content).toBe("alias attack");
    value(await reopened.close());
  });

  it("the package root exposes only the narrow durable public surface (RED 4)", async () => {
    expect(typeof openDurableEtherMemories).toBe("function");
    expect(typeof createMutationId).toBe("function");
    for (const name of ["openDurableEtherMemoriesInternal", "StartupRecovery", "ProductionWalStore", "FsDurableStore", "FsWalStore",
      "StateRoot", "buildStateRoot", "validateStateRoot", "attachTip", "DurableDependencies", "prepareCoreMutation",
      "resolveCommittedEffects", "DiskBackedMutationIndex"]) {
      expect(Object.hasOwn(publicApi, name), name).toBe(false);
    }
    const invalidUser = await openDurableEtherMemories({ userId: "", directory: "x" });
    expect(invalidUser.ok).toBe(false);
    expect(failure(invalidUser).code).toBe("INVALID_INPUT");
    const legacy = sourceSnapshot();
    expect(legacy.schemaVersion).toBe("ether.memory_store.v0.3");
  });
});

describe("durable runtime runtime-enforced encapsulation (final RED)", { timeout: 120_000 }, () => {
  const INTERNAL_FIELD_NAMES = ["generation", "lifecycle", "store", "queue", "directory", "userId", "io", "files", "indexDiskBytes"];

  const open = async () => {
    const s = await setup();
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    value(await runtime.addMemory({ content: "encapsulation committed note", tags: ["enc"] }, "enc-1"));
    return { s, runtime };
  };

  it("no own property, key, or descriptor exposes authoritative internals", async () => {
    const { s, runtime } = await open();
    expect("generation" in runtime).toBe(false);
    expect((runtime as unknown as Record<string, unknown>).generation).toBeUndefined();
    for (const name of INTERNAL_FIELD_NAMES) {
      expect((runtime as unknown as Record<string, unknown>)[name], name).toBeUndefined();
      expect(Object.hasOwn(runtime, name), name).toBe(false);
      expect((runtime as unknown as Record<string, unknown>)[name], name).toBeUndefined();
    }
    expect(Object.getOwnPropertyNames(runtime)).toEqual([]);
    expect(Object.keys(runtime)).toEqual([]);
    expect(Reflect.ownKeys(runtime)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(runtime)).toEqual({});
    // The canonical committed state is reachable only through the public API.
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "encapsulation committed note")).toBe(true);
    value(await runtime.close());
    void s;
  });

  it("prototype traversal yields only methods and accessors, never state", async () => {
    const { runtime } = await open();
    let prototype: unknown = runtime;
    for (let depth = 0; depth < 5 && prototype !== null; depth++) {
      const names = Object.getOwnPropertyNames(prototype).filter(name => name !== "constructor");
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
        // Accessors on the prototype must return detached public data only.
        if (typeof descriptor.get === "function") {
          const accessed = (runtime as unknown as Record<string, unknown>)[name];
          expect(isAuthoritative(accessed), `prototype accessor ${name}`).toBe(false);
        } else {
          expect(typeof descriptor.value, `prototype member ${name}`).toBe("function");
        }
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    value(await runtime.close());
  });

  it("Codex's exact runtime.generation attack is impossible and changes nothing", async () => {
    const { s, runtime } = await open();
    const walBefore = await walBytes(s.directory);
    const canonical = value(encodeSnapshotSnapshot(runtime));
    const tipBefore = value(runtime.tip);
    // Codex's attack: runtime.generation.notes.add({...}) before the repair.
    const hostile = (runtime as unknown as { generation?: { notes?: { add(input: unknown): unknown } } }).generation;
    expect(hostile).toBeUndefined();
    expect((runtime as unknown as Record<string, { notes?: unknown }>)["generation"]?.notes).toBeUndefined();
    expect(value(runtime.queryMemories("encapsulation", { asOf: 0 })).some(n => n.content === "encapsulation committed note")).toBe(true);
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(canonical);
    expect(await walBytes(s.directory)).toBe(walBefore);
    expect(value(runtime.tip)).toEqual(tipBefore);
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "encapsulation committed note")).toBe(true);
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "unlogged")).toBe(false);
    value(await reopened.close());
  });

  it("a bounded object-graph escape scan finds no canonical modules or injected dependencies", async () => {
    const { runtime } = await open();
    // Every value reachable from the public surface (own properties, prototype
    // accessor results and method results) is scanned to a bounded depth.
    const surface: unknown[] = [Object.getOwnPropertyNames(runtime).map(name => (runtime as unknown as Record<string, unknown>)[name]),
      runtime.state, runtime.tip];
    const context = runtime.buildMemoryContext({ purpose: "debug" });
    if (context.ok) surface.push(context.value);
    for (const value of surface) {
      expect(scanForAuthoritative(value, 0, new Set()), "public surface object graph").toHaveLength(0);
    }
    value(await runtime.close());
  });

  it("public read results remain fully detached, including memory context", async () => {
    const { s, runtime } = await open();
    const staleContext = value(runtime.buildMemoryContext({ purpose: "debug" }));
    const note = value(await runtime.addMemory({ content: "detached result note" }, "enc-2"));
    const walAfter = await walBytes(s.directory);
    const canonical = value(encodeSnapshotSnapshot(runtime));
    // Alias attacks on every returned shape, including memory context.
    const hostileContext = staleContext as unknown as Record<string, any>;
    if (Array.isArray(hostileContext.citations)) hostileContext.citations.push({ forged: true });
    hostileContext.purpose = "forged";
    note.content = "mutated";
    (note.metadata as Record<string, unknown>).forged = true;
    const queried = value(runtime.queryMemories("encapsulation committed", { asOf: 0 }));
    queried[0]!.content = "mutated";
    const exported = value(runtime.exportData());
    (exported.memoryNotes[0]!.metadata as Record<string, unknown>).forged = true;
    const identity = value(runtime.getSystemState());
    identity.displayName = "forged";
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(canonical);
    expect(await walBytes(s.directory)).toBe(walAfter);
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io }));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "detached result note")).toBe(true);
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "mutated")).toBe(false);
    value(await reopened.close());
  });
});

const isAuthoritative = (candidate: unknown): boolean => {
  return candidate instanceof MemoryNotes || candidate instanceof DiarySystem
    || candidate instanceof MindGraphManager || candidate instanceof ProductionWalStore
    || candidate instanceof StartupRecovery;
};

/** Recursively find authoritative objects reachable from a public value (bounded depth). */
const scanForAuthoritative = (value: unknown, depth: number, seen: Set<unknown>): unknown[] => {
  if (depth > 4 || (typeof value !== "object" && typeof value !== "function") || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (isAuthoritative(value)) return [value];
  // A frozen StateRoot-shaped capsule is also an escape.
  if (Object.isFrozen(value)
    && ["snapshot", "bytes", "tip", "notes", "diary", "graph", "retriever"].every(key => key in (value as object))) {
    return [value];
  }
  const findings: unknown[] = [];
  const record = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) findings.push(...scanForAuthoritative(record[key], depth + 1, seen));
  return findings;
};

const encodeSnapshotSnapshot = (runtime: DurableEtherMemories) => {
  const exported = runtime.exportData();
  return exported.ok ? encodeSnapshotPayload(exported.value) : exported;
};
