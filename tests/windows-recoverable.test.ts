import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDurableEtherMemories } from "../src/index.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import * as directory from "../src/persistence/directoryIO.js";
import { FsDurableStore } from "../src/persistence/FsDurableStore.js";
import { FsWalStore } from "../src/persistence/FsWalStore.js";
import { ProductionWalStore } from "../src/persistence/productionOperations.js";
import type { MutationId } from "../src/types/persistence.js";
import { fixture, value } from "./helpers/persistence.js";
import { registry, request } from "./helpers/wal.js";

const parents: string[] = [];
afterEach(async () => { for (const p of parents.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
async function storePath(name = "store") {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-t5-"));
  parents.push(parent);
  return join(parent, name);
}
const recoverableOptions = (path: string) => ({ userId: "t5", directory: path, durabilityGuarantee: "recoverable" as const });

// Every historical case stays active. Windows uses the public native backend;
// POSIX controls are supplemental and never claim Windows certification.
describe("Windows recoverable capability and cross-platform controls", { timeout: 30000 }, () => {
  it("opens, retries after rotation, and reopens using the production backend", async () => {
    const path = await storePath("Café 測試 space");
    const options = recoverableOptions(path);
    const runtime = value(await openDurableEtherMemories(options));
    // Mutating caller configuration cannot upgrade the already selected capability.
    Object.assign(options, { durabilityGuarantee: "strict" });
    const note = value(await runtime.addMemory({ content: "T5 retained" }, "stable-t5"));
    value(await runtime.rotate());
    const historical = value(await new ProductionWalStore(path, directory.windowsRecoverableDirectoryIO)
      .commitMutationDetailed(value(runtime.tip), value(runtime.exportData()), "stable-t5" as MutationId,
        { kind: "note.put", input: { content: "T5 retained" } }));
    expect(historical.receipt).toMatchObject({ status: "already-committed", acknowledgment: "process-recoverable" });
    expect(historical.receipt).not.toHaveProperty("durability");
    expect(value(await runtime.addMemory({ content: "T5 retained" }, "stable-t5"))).toEqual(note);
    value(await runtime.collectGarbage());
    value(await runtime.runMaintenance());
    value(await runtime.close());
    const reopened = value(await openDurableEtherMemories(recoverableOptions(path)));
    expect(value(reopened.exportData()).memoryNotes).toEqual([note]);
    value(await reopened.close());
  }, 30000);

  it("keeps the native strict default without a recoverable fallback", async () => {
    const path = await storePath();
    const opened = await openDurableEtherMemories({ userId: "t5", directory: path });
    if (process.platform === "win32") {
      expect(opened).toMatchObject({ ok: false, error: { code: "DURABILITY_UNAVAILABLE" } });
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      const runtime = value(opened);
      value(await runtime.addMemory({ content: "native strict control" }, "strict-control"));
      value(await runtime.close());
    }
  });

  it("never labels weak HEAD or WAL results as strict confirmation", async () => {
    const path = await storePath();
    const io = directory.windowsRecoverableDirectoryIO;
    const head = value(await new FsDurableStore({ directory: path }, io).initialize(fixture()));
    expect(head).toMatchObject({ activation: "process-recoverable", acknowledgment: "process-recoverable" });
    expect(head).not.toHaveProperty("durability");
    const wal = new FsWalStore({ directory: path, registry }, io);
    const input = request();
    const receipt = value(await wal.commit(input));
    expect(receipt).toMatchObject({ status: "committed", acknowledgment: "process-recoverable" });
    expect(receipt).not.toHaveProperty("durability");
    const retry = value(await wal.commit(input));
    const lookup = value(await wal.readCommittedMutation(input.mutation.mutationId));
    for (const result of [retry, lookup]) {
      expect(result).toMatchObject({ status: "already-committed", acknowledgment: "process-recoverable", identity: receipt.identity });
      expect(result).not.toHaveProperty("durability");
    }
  });

  it("retains the selected capability when an injected backend property changes", async () => {
    const path = await storePath();
    const io: directory.DirectoryIO = { ...directory.windowsRecoverableDirectoryIO };
    const runtime = value(await openDurableEtherMemoriesInternal(recoverableOptions(path), { io }));
    Object.assign(io, { guarantee: "strict" });
    value(await runtime.addMemory({ content: "selected once" }, "selected-once"));
    value(await runtime.rotate());
    value(await runtime.recover());
    value(await runtime.close());
  }, 30000);

  it("retains WAL file-sync failures and recovery-required disposition in weak mode", async () => {
    const path = await storePath();
    const io = directory.windowsRecoverableDirectoryIO;
    value(await new FsDurableStore({ directory: path }, io).initialize(fixture()));
    const { nodeWalIO } = await import("../src/persistence/walIO.js");
    const wal = new FsWalStore({ directory: path, registry }, io, { ...nodeWalIO,
      open: async (p, create) => {
        const h = await nodeWalIO.open(p, create);
        return { ...h, sync: async () => { throw new Error("injected file sync failure"); } };
      }
    });
    const result = await wal.commit(request());
    expect(result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED", details: { durability: "unconfirmed", visibility: "complete" } } });
    expect(value(await new FsWalStore({ directory: path, registry }, io).commit(request()))).toMatchObject({ status: "already-committed", acknowledgment: "process-recoverable" });
  });

  it("refuses junction ancestors and hardlinked authority files", async () => {
    const path = await storePath();
    const target = join(parents[parents.length - 1], "target");
    await fs.mkdir(target);
    await fs.symlink(target, path, "junction");
    expect(await openDurableEtherMemories(recoverableOptions(join(path, "store")))).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    const realPath = join(target, "store");
    const runtime = value(await openDurableEtherMemories(recoverableOptions(realPath)));
    value(await runtime.close());
    await fs.link(join(realPath, "HEAD"), join(target, "head-hardlink"));
    expect(await openDurableEtherMemories(recoverableOptions(realPath))).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
  }, 30000);

  it.each(["store.", "store ", "store:ads", "NUL", "u-" + String.fromCodePoint(0x10ffff)])("refuses unsafe path %s before native IO", async name => {
    const path = await storePath(name);
    if (process.platform === "win32") {
      expect(await openDurableEtherMemories(recoverableOptions(path))).toMatchObject({ ok: false, error: { code: "DURABILITY_UNAVAILABLE" } });
    } else {
      expect(() => directory.assertWindowsRecoverablePath(path)).toThrow(directory.DirectoryIoError);
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

it("rejects invalid capability options as results", async () => {
  expect(await openDurableEtherMemories({ userId: "t5", directory: "unused", durabilityGuarantee: "bogus" } as unknown as Parameters<typeof openDurableEtherMemories>[0])).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(await openDurableEtherMemories(null as unknown as Parameters<typeof openDurableEtherMemories>[0])).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
