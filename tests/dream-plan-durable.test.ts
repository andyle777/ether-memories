import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EtherMemoriesCore, CondensationEngine, type DurableEtherMemories, type DreamSelector, type DreamCyclePreviewOptions } from "../src/index.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";

const AS_OF = 1893456000000;
const roots: string[] = [], runtimes: DurableEtherMemories[] = [];
const preview = (runtime: DurableEtherMemories, selector?: unknown, options: unknown = { asOf: AS_OF }): any =>
  runtime.previewDreamCycle(selector as DreamSelector, options as DreamCyclePreviewOptions);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const hashes = async (directory: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[path.slice(directory.length)] = createHash("sha256").update(await fs.readFile(path)).digest("hex");
    }
  };
  await visit(directory); return result;
};

describe("T3 authoritative read-only durable preview", { timeout: 120000 }, () => {
  it("matches Core across all selector modes without I/O, condensation or any state/file/tip mutation", async () => {
    const s = await bootstrap(); roots.push(s.parent); const io = { ...s.io }, files = { ...nodeWalIO };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io, files })); runtimes.push(runtime);
    const snapshot = value(runtime.exportData()), c = new EtherMemoriesCore({ userId: snapshot.identity.userId }); value(c.importData(snapshot));
    const before = await hashes(s.directory), tip = value(runtime.tip), n = snapshot.memoryNotes[0];
    const selectors = [{ kind: "ids", ids: [n.id] }, { kind: "tags", tags: n.tags.length ? n.tags : ["missing"] },
      { kind: "query", query: n.content }, { kind: "date-window", from: n.createdAt.getTime(), to: n.createdAt.getTime() + 1 }, { kind: "all_active" }];
    const spies = [];
    for (const owner of [io, files]) for (const key of Object.keys(owner)) if (typeof (owner as Record<string, unknown>)[key] === "function") {
      spies.push(vi.spyOn(owner as unknown as Record<string, (...args: unknown[]) => unknown>, key).mockImplementation(() => { throw Error("preview I/O forbidden"); }));
    }
    const analyze = vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(() => { throw Error("preview analysis forbidden"); });
    const clock = vi.spyOn(Date, "now").mockReturnValue(AS_OF);
    const implicit = Reflect.get(runtime, "previewDreamCycle").call(runtime, { kind: "all_active" }); expect(clock).toHaveBeenCalledTimes(1); clock.mockClear();
    for (const selector of selectors) expect(preview(runtime, selector)).toEqual(c.previewDreamCycle(selector as any, { asOf: AS_OF }));
    expect(implicit).toEqual(c.previewDreamCycle({ kind: "all_active" }, { asOf: AS_OF }));
    expect(clock).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled(); for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore(); clock.mockRestore(); analyze.mockRestore();
    expect(runtime.exportData()).toEqual({ ok: true, value: snapshot }); expect(value(runtime.tip)).toEqual(tip); expect(await hashes(s.directory)).toEqual(before);
  });
  it("returns CLOSED before invalid selector/options or clock observation", async () => {
    const s = await bootstrap(); roots.push(s.parent);
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io })); runtimes.push(runtime);
    value(await runtime.close()); const clock = vi.spyOn(Date, "now");
    for (const selector of [undefined, null, { kind: "ids", ids: [] }, { kind: "all_active" }]) expect(preview(runtime, selector, { asOf: NaN })).toMatchObject({ ok: false, error: { code: "CLOSED" } });
    expect(runtime.previewDreamCycle(null as unknown as DreamSelector)).toMatchObject({ ok: false, error: { code: "CLOSED" } }); expect(clock).not.toHaveBeenCalled();
  });
  it("fails recovery-required before caller validation and resumes only after explicit recovery", async () => {
    const s = await bootstrap(); roots.push(s.parent); let armed = false;
    const files = { ...nodeWalIO, open: async (path: string, create: boolean) => {
      const handle = await nodeWalIO.open(path, create);
      return { ...handle, sync: async () => { await handle.sync(); if (armed) { armed = false; throw Error("lost sync acknowledgment"); } } };
    } };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files })); runtimes.push(runtime);
    armed = true; expect((await runtime.addMemory({ content: "ambiguous" }, "t3-ambiguity")).ok).toBe(false); expect(runtime.state).toBe("recovery-required");
    const clock = vi.spyOn(Date, "now");
    expect(preview(runtime, null, { asOf: NaN })).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(runtime.previewDreamCycle(null as unknown as DreamSelector)).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } }); expect(clock).not.toHaveBeenCalled(); clock.mockRestore();
    value(await runtime.recover()); expect(preview(runtime, { kind: "all_active" }).ok).toBe(true);
  });
});
