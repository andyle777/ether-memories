import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableEtherMemories, openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
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

describe("durable runtime lifecycle", { timeout: 60_000 }, () => {
  it("bootstraps a fresh store, serves empty committed state and reopens identically", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const opened = await DurableEtherMemories.open({ userId: "user-boot", directory }, io);
    expect(opened.ok).toBe(true);
    const runtime = value(opened);
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes).toEqual([]);
    expect(value(runtime.tip).txId).toBe("9007199254740993");
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    await runtime.close();
    expect(failure(await runtime.exportData()).code).toBe("CLOSED");
    const reopened = await DurableEtherMemories.open({ userId: "user-boot", directory, openMode: "existing" }, io);
    expect(value(value(reopened).tip).txId).toBe("9007199254740993");
    expect(value(encodeSnapshotPayload(value(value(reopened).exportData())))).toEqual(before);
    await value(reopened).close();
  });

  it("openMode create/existing fail closed and a legacy snapshot file is never converted", async () => {
    const { directory } = await fresh();
    const io = simulatedDirectoryIO();
    const created = await DurableEtherMemories.open({ userId: "u", directory, openMode: "create" }, io);
    expect(created.ok).toBe(true);
    await value(created).close();
    expect(failure(await DurableEtherMemories.open({ userId: "u", directory, openMode: "create" }, io)).code).toBe("INVALID_INPUT");
    const missing = join((await fresh()).parent, "absent");
    expect(failure(await DurableEtherMemories.open({ userId: "u", directory: missing, openMode: "existing" }, io)).code).toBe("INVALID_INPUT");
    // A legacy JSON snapshot file at the directory path is recognized as such
    // and never converted, migrated or overwritten.
    const legacyPath = join((await fresh()).parent, "legacy-store.json");
    await fs.writeFile(legacyPath, JSON.stringify({ schemaVersion: "ether.memory_store.v0.3",
      identity: { userId: "u", createdAt: "2020-01-01T00:00:00.000Z", lastActive: "2020-01-01T00:00:00.000Z" },
      memoryNotes: [], diary: [], graph: { nodes: [], edges: [] } }));
    const refused = await DurableEtherMemories.open({ userId: "u", directory: legacyPath }, io);
    expect(failure(refused).code).toBe("PERSISTENCE_CORRUPTION");
    expect((await fs.readFile(legacyPath, "utf8")).includes("ether.memory_store.v0.3")).toBe(true);
  });

  it("recovery failure fails closed: no runtime escapes a corrupt store", async () => {
    const s = await setup();
    await fs.appendFile(join(s.directory, "checkpoints", "checkpoint-checkpoint-a.bin"), "corruption");
    const refused = await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io);
    // Frozen inspect semantics: checkpoint verification fails before any
    // runtime object exists; the corrupted store is never repaired here.
    expect(failure(refused).code).toBe("RECOVERY_REQUIRED");
  });

  it("mutates durably with legacy-shaped results and mirrors recovery byte-for-byte", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const note = value(await runtime.addMemory({ content: "durable runtime note", tags: ["durable"], status: "candidate" }));
    expect(note.content).toBe("durable runtime note");
    expect(note.status).toBe("candidate");
    expect(note.createdAt instanceof Date).toBe(true);
    const promoted = value(await runtime.promoteCandidate(note.id));
    expect(promoted.status).toBe("active");
    const diary = value(await runtime.addDiaryEntry({ content: "durable diary", tags: ["d"] }));
    expect(value(await runtime.updateMemory(note.id, { summary: "summarized" })).summary).toBe("summarized");
    const edge = value(await runtime.addGraphEdge("edge-1", `memory:${note.id}`, `diary:${diary.id}`, "related_to", { why: "test" }));
    expect(edge.id).toBe("edge-1");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    value(await recovery.recover());
    const read = value(recovery.read());
    expect(read.tip).toEqual(value(runtime.tip));
    expect(value(encodeSnapshotPayload(read.snapshot))).toEqual(value(encodeSnapshotPayload(value(runtime.exportData()))));
    expect(value(runtime.queryMemories("durable runtime", { asOf: 0 })).some(x => x.id === note.id)).toBe(true);
    value(await runtime.deleteMemory(note.id));
    expect(value(runtime.exportData()).memoryNotes.find(n => n.id === note.id)).toBeUndefined();
    value(await runtime.deleteDiary(diary.id));
    await runtime.close();
  });

  it("readers observe only whole committed generations around commits", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    const pending = runtime.addMemory({ content: "interleaved" });
    // Synchronous read while the durable mutation is still in flight: the old
    // committed generation, never a partial mixture.
    expect(value(encodeSnapshotPayload(value(runtime.exportData())))).toEqual(before);
    value(await pending);
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "interleaved")).toBe(true);
    await runtime.close();
  });

  it("invalid inputs fail without a lifecycle transition; Date inputs fail closed (durable plain-data domain)", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    expect(failure(await runtime.addMemory({ content: "   " })).code).toBe("INVALID_INPUT");
    expect(failure(await runtime.updateMemory("absent-id", { summary: "x" })).code).toBe("NOT_FOUND");
    expect((await runtime.addMemory({ content: "x", expiresAt: new Date() })).ok).toBe(false);
    expect(runtime.state).toBe("ready");
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    expect(value(encodeSnapshotPayload(value(runtime.exportData())))).toEqual(before);
    await runtime.close();
  });
});

describe("durable runtime lost-ACK reconciliation", { timeout: 60_000 }, () => {
  it("ambiguous commit blocks mutations until explicit recovery; retry with the same identity reconstructs the original result", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io, files));
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    arm();
    const failed = await runtime.addMemory({ content: "lost ack note" }, "lost-1");
    expect(failure(failed).code).toBe("RECOVERY_REQUIRED");
    expect((failure(failed).details as { mutationId: string }).mutationId).toBe("lost-1");
    expect(runtime.state).toBe("recovery-required");
    // Committed reads remain available; the published generation is unchanged.
    expect(value(encodeSnapshotPayload(value(runtime.exportData())))).toEqual(before);
    // Mutations stay blocked until explicit recovery.
    expect(failure(await runtime.addMemory({ content: "blocked" })).code).toBe("RECOVERY_REQUIRED");
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(1);
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes.some(n => n.content === "lost ack note")).toBe(true);
    // Same stable identity: the retry resolves the original committed transaction.
    const retry = value(await runtime.addMemory({ content: "lost ack note" }, "lost-1"));
    expect(retry.content).toBe("lost ack note");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    value(await recovery.recover());
    expect(value(recovery.read()).tip).toEqual(value(runtime.tip));
    expect(value(await (new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io)).recover()).transactions).toBe(1);
    await runtime.close();
  });

  it("complete process restart reconstructs the original result from committed effects, not current state", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const first = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io, files));
    arm();
    expect((await first.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1")).ok).toBe(false);
    expect(first.state).toBe("recovery-required");
    // "Process restart": a brand-new runtime opens the store through recovery.
    const second = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    expect(value(second.exportData()).memoryNotes.some(n => n.content === "restart original content")).toBe(true);
    const retry = value(await second.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1"));
    expect(retry.content).toBe("restart original content");
    expect(retry.tags).toEqual(["orig"]);
    // A later transaction modifies the note; the already-committed retry still
    // returns the exact object the original call produced at its commit.
    value(await second.updateMemory(retry.id, { content: "modified later" }));
    const retriedAgain = value(await second.addMemory({ content: "restart original content", tags: ["orig"] }, "restart-1"));
    expect(retriedAgain.content).toBe("restart original content");
    expect(value(second.exportData()).memoryNotes.find(n => n.id === retry.id)!.content).toBe("modified later");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(2);
    await first.close();
    await second.close();
  });

  it("the same mutation identity with a conflicting intent fails closed and changes nothing", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const note = value(await runtime.addMemory({ content: "intent one" }, "intent-1"));
    const conflict = await runtime.addMemory({ content: "intent two" }, "intent-1");
    expect(failure(conflict).code).toBe("PERSISTENCE_CORRUPTION");
    expect(runtime.state).toBe("ready");
    expect(value(runtime.exportData()).memoryNotes.find(n => n.id === note.id)!.content).toBe("intent one");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    await runtime.close();
  });

  it("a pre-acknowledgment write failure leaves the generation unchanged and recovers cleanly", async () => {
    const s = await setup();
    let failOpen = false;
    const files: WalIO = { ...nodeWalIO, open: async (path, create) => {
      if (failOpen && path.includes(join("wal")) && path.endsWith(".bin")) { failOpen = false; throw new Error("injected open failure"); }
      return nodeWalIO.open(path, create);
    } };
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io, files));
    const before = value(encodeSnapshotPayload(value(runtime.exportData())));
    failOpen = true;
    const failed = await runtime.addMemory({ content: "never appended" }, "pre-1");
    expect(failed.ok).toBe(false);
    expect(value(encodeSnapshotPayload(value(runtime.exportData())))).toEqual(before);
    expect(runtime.state).toBe("recovery-required");
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(0);
    const retry = value(await runtime.addMemory({ content: "never appended" }, "pre-1"));
    expect(retry.content).toBe("never appended");
    const recovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await recovery.recover()).transactions).toBe(1);
    await runtime.close();
  });

  it("a large payload-backed mutation survives restart through its external object", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const large = "O".repeat(80000);
    const note = value(await runtime.addMemory({ content: large }, "large-1"));
    expect(note.content).toHaveLength(80000);
    const objects = await fs.readdir(join(s.directory, "objects"));
    // One referenced object per large effect body (note, linker node, identity).
    expect(objects.length).toBeGreaterThan(0);
    await runtime.close();
    const reopened = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    expect(value(reopened.exportData()).memoryNotes.find(n => n.id === note.id)!.content).toBe(large);
    await reopened.close();
  });
});

describe("durable runtime close and release", { timeout: 60_000 }, () => {
  it("close is deterministic and idempotent; a second runtime opens afterwards", async () => {
    const s = await setup();
    const first = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    value(await first.addMemory({ content: "before close" }));
    value(await first.close());
    value(await first.close());
    expect(failure(await first.addMemory({ content: "after" })).code).toBe("CLOSED");
    expect(failure(first.exportData()).code).toBe("CLOSED");
    expect(failure(await first.recover()).code).toBe("CLOSED");
    expect(failure(first.tip).code).toBe("CLOSED");
    expect(first.state).toBe("closed");
    const second = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    expect(value(second.exportData()).memoryNotes.some(n => n.content === "before close")).toBe(true);
    await second.close();
  });

  it("close after an ambiguous mutation still releases; the next open recovers", async () => {
    const s = await setup();
    const { io: files, arm } = losingAckWalIO();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io, files));
    arm();
    expect((await runtime.addMemory({ content: "ambiguous" }, "close-1")).ok).toBe(false);
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.close());
    const reopened = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    expect(value(reopened.exportData()).memoryNotes.some(n => n.content === "ambiguous")).toBe(true);
    await reopened.close();
  });

  it("the public factory open is exported from the package root and rejects invalid options", async () => {
    expect(typeof openDurableEtherMemories).toBe("function");
    expect(failure(await openDurableEtherMemories({ userId: "", directory: "x" })).code).toBe("INVALID_INPUT");
    expect(failure(await openDurableEtherMemories({ userId: "u", directory: "" })).code).toBe("INVALID_INPUT");
    const legacy = sourceSnapshot();
    expect(legacy.schemaVersion).toBe("ether.memory_store.v0.3");
  });
});
