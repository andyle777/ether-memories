import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { StartupRecovery } from "../src/persistence/StartupRecovery.js";
import { encodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
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

const transactionCount = async (directory: string, userId: string, io = simulatedDirectoryIO()) => {
  const recovery = new StartupRecovery(directory, userId, io);
  return value(await recovery.recover()).transactions;
};

describe("durable runtime concurrency", { timeout: 60_000 }, () => {
  it("serializes concurrent submissions; both commit exactly once and coherently", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const [a, b] = await Promise.all([
      runtime.addMemory({ content: "concurrent one" }, "c-1"),
      runtime.addMemory({ content: "concurrent two" }, "c-2")
    ]);
    expect(a.ok && b.ok).toBe(true);
    const state = value(runtime.exportData());
    expect(state.memoryNotes.some(n => n.content === "concurrent one")).toBe(true);
    expect(state.memoryNotes.some(n => n.content === "concurrent two")).toBe(true);
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    await runtime.close();
  });

  it("the same mutation identity submitted concurrently resolves to one transaction", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const [a, b] = await Promise.all([
      runtime.addMemory({ content: "same identity" }, "same-1"),
      runtime.addMemory({ content: "same identity" }, "same-1")
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(value(a).id).toBe(value(b).id);
    expect(value(a).content).toBe("same identity");
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(1);
    await runtime.close();
  });

  it("a second runtime advancing the tip yields a retryable stale base, never a silent rebase", async () => {
    const s = await setup();
    const first = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const second = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    value(await second.addMemory({ content: "committed by second runtime" }));
    const stale = await first.addMemory({ content: "first runtime attempt" }, "stale-1");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected stale failure");
    expect(stale.error.code).toBe("STALE_TRANSACTION_BASE");
    expect((stale.error.details as { mutationId: string }).mutationId).toBe("stale-1");
    expect(first.state).toBe("recovery-required");
    // The old committed generation stays coherent and readable.
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "committed by second runtime")).toBe(false);
    value(await first.recover());
    expect(first.state).toBe("ready");
    const retry = value(await first.addMemory({ content: "first runtime attempt" }, "stale-1"));
    expect(retry.content).toBe("first runtime attempt");
    expect(value(first.exportData()).memoryNotes.some(n => n.content === "committed by second runtime")).toBe(true);
    expect(await transactionCount(s.directory, s.snapshot.identity.userId, s.io)).toBe(2);
    await first.close();
    await second.close();
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
    const held = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, blocking as typeof s.io));
    // The contender opens before the holder takes writer authority: a fresh
    // open while a lock is held fails closed with WRITER_BUSY.
    const contender = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
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
    await held.close();
    await contender.close();
  });

  it("reads during a failed concurrent commit never expose candidate state", async () => {
    const s = await setup();
    const runtime = value(await DurableEtherMemories.open({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, s.io));
    const before = value(encodeSnapshotSnapshot(runtime));
    const failing = runtime.updateMemory("absent-note", { summary: "nope" });
    const during = value(encodeSnapshotSnapshot(runtime));
    const failed = await failing;
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected not-found failure");
    expect(failed.error.code).toBe("NOT_FOUND");
    expect(during).toEqual(before);
    expect(value(encodeSnapshotSnapshot(runtime))).toEqual(before);
    expect(runtime.state).toBe("ready");
    await runtime.close();
  });
});

const encodeSnapshotSnapshot = (runtime: DurableEtherMemories) => {
  const exported = runtime.exportData();
  return exported.ok ? encodeSnapshotPayload(exported.value) : exported;
};

const waitFor = async (predicate: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
};
