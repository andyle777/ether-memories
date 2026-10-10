import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CondensationEngine, EtherMemoriesCore, type DurableEtherMemories, type DreamPlan, type DreamSelector } from "../src/index.js";
import type { DreamCycleResult } from "../src/types/dreamAnalysis.js";
import type { Result } from "../src/utils/result.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { bootstrap } from "./helpers/recovery.js";
import { DREAM_AS_OF, requireValue, seedDreamCore } from "./helpers/dream-analysis.js";

const roots: string[] = [], runtimes: DurableEtherMemories[] = [];
const run = (runtime: DurableEtherMemories, plan: unknown): Result<DreamCycleResult> =>
  runtime.runDreamCycle(plan as DreamPlan);
const fixture = () => seedDreamCore([
  { id: "a", content: "  Alpha source carries stable facts.  " },
  { id: "b", content: "  Beta source carries different facts.  " }
], [{ id: "ab", source: "a", target: "b", relationship: "supports" }]);
const setup = async (core = fixture()) => {
  const store = await bootstrap(JSON.parse(JSON.stringify(core.exportData()))); roots.push(store.parent);
  return store;
};
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
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("T4 Durable one-generation read-only execution", { timeout: 120000 }, () => {
  it("matches Core for every selector, empty/replay/rejection and clone isolation with zero I/O or GC", async () => {
    const store = await setup(), io = { ...store.io }, files = { ...nodeWalIO };
    const gc = vi.fn(async () => undefined);
    const runtime = requireValue(await openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId,
      directory: store.directory, openMode: "existing" }, { io, files, gcInstrumentation: { at: gc } })); runtimes.push(runtime);
    const snapshot = requireValue(runtime.exportData()), core = new EtherMemoriesCore({ userId: snapshot.identity.userId });
    requireValue(core.importData(snapshot));
    const selectors: DreamSelector[] = [{ kind: "ids", ids: ["a", "b"] }, { kind: "tags", tags: ["shared"] },
      { kind: "query", query: "source" }, { kind: "date-window", from: 10, to: 11 }, { kind: "all_active" }, { kind: "tags", tags: ["missing"] }];
    const plans = selectors.map(selector => requireValue(runtime.previewDreamCycle(selector, { asOf: DREAM_AS_OF })));
    const expected = plans.map(plan => core.runDreamCycle(plan)), beforeHashes = await hashes(store.directory), beforeTip = requireValue(runtime.tip);
    const spies = [];
    for (const owner of [io, files]) for (const key of Object.keys(owner)) if (typeof (owner as Record<string, unknown>)[key] === "function") {
      spies.push(vi.spyOn(owner as unknown as Record<string, (...args: unknown[]) => unknown>, key).mockImplementation(() => { throw Error("Dream I/O forbidden"); }));
    }
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("Dream clock forbidden"); });
    const commit = vi.spyOn(CondensationEngine.prototype, "commitAnalysis").mockImplementation(() => { throw Error("Dream commit forbidden"); });
    const condense = vi.spyOn(CondensationEngine.prototype, "condense").mockImplementation(() => { throw Error("Dream condense forbidden"); });
    for (const [index, plan] of plans.entries()) { expect(run(runtime, plan)).toEqual(expected[index]); expect(run(runtime, plan)).toEqual(expected[index]); }
    expect(run(runtime, null)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(run(runtime, { ...plans[0], algorithm: "ether.dream.v2" })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_SCHEMA" } });
    expect(run(runtime, { ...plans[0], planId: "f".repeat(64) })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const changed = requireValue(run(runtime, plans[0]));
    changed.proposals[0].content = "caller"; changed.proposals[0].sourceIds.push("caller"); changed.proposals[0].evidence.keyFacts.push("caller fact");
    changed.proposals[0].evidence.relationships[0].relationship = "caller"; changed.proposals[0].evidence.truncationReasons.push("relationship-limit"); changed.truncationReasons.push("proposal-limit");
    expect(run(runtime, plans[0])).toEqual(expected[0]);
    expect(runtime.exportData()).toEqual({ ok: true, value: snapshot }); expect(runtime.tip).toEqual({ ok: true, value: beforeTip }); expect(runtime.state).toBe("ready");
    expect(clock).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(condense).not.toHaveBeenCalled(); expect(gc).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks(); expect(await hashes(store.directory)).toEqual(beforeHashes);
  });
  it.each(["duplicate", "count-truncated", "empty"] as const)("preserves complete durable identity for %s results", async mode => {
    const sources = mode === "duplicate" ? [{ id: "a", content: "  Same representative fact.  " }, { id: "b", content: "  Same representative fact.  " }]
      : mode === "count-truncated" ? Array.from({ length: 33 }, (_, i) => ({ id: `source-${String(i).padStart(2, "0")}`, content: `  Distinct durable source fact ${i}.  ` })) : [];
    const core = seedDreamCore(sources), store = await setup(core);
    const runtime = requireValue(await openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId, directory: store.directory, openMode: "existing" }, { io: store.io })); runtimes.push(runtime);
    const plan = requireValue(runtime.previewDreamCycle({ kind: "all_active" }, { asOf: DREAM_AS_OF })), before = runtime.exportData(), tip = runtime.tip, bytes = await hashes(store.directory);
    const result = requireValue(run(runtime, plan)); expect(result).toEqual(requireValue(core.runDreamCycle(plan)));
    expect(result.proposalCount).toBe(mode === "duplicate" ? 1 : mode === "count-truncated" ? 32 : 0);
    expect(result.knownProposalCount).toBe(mode === "count-truncated" ? 33 : result.proposalCount);
    expect(result.truncationReasons).toEqual(mode === "count-truncated" ? ["proposal-limit"] : []);
    expect(run(runtime, plan)).toEqual({ ok: true, value: result }); expect(runtime.exportData()).toEqual(before); expect(runtime.tip).toEqual(tip);
    expect(runtime.state).toBe("ready"); expect(await hashes(store.directory)).toEqual(bytes);
  });
  it("uses captured bytes when another durable generation is queued during analysis", async () => {
    const store = await setup(), runtime = requireValue(await openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId,
      directory: store.directory, openMode: "existing" }, { io: store.io })); runtimes.push(runtime);
    const plan = requireValue(runtime.previewDreamCycle({ kind: "ids", ids: ["a", "b"] }, { asOf: DREAM_AS_OF }));
    let pending: Promise<Result<unknown>> | undefined, calls = 0;
    const analyze = CondensationEngine.prototype.analyze;
    vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(function (this: CondensationEngine, ...args) {
      if (++calls === 1) pending = runtime.updateMemory("b", { content: "Changed later durable generation" }, "t4-later-generation");
      return analyze.apply(this, args);
    });
    const result = requireValue(run(runtime, plan)), retained = structuredClone(result);
    expect(result.proposals.map(p => p.content)).toEqual(["Alpha source carries stable facts.", "Beta source carries different facts."]);
    expect(pending).toBeDefined(); requireValue(await pending!); vi.restoreAllMocks();
    expect(result).toEqual(retained); expect(run(runtime, plan)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
  it.each(["closed", "recovery-required"] as const)("prioritizes %s authority over hostile input with zero traps/analysis/clock", async state => {
    const store = await setup(); let armed = false;
    const files = { ...nodeWalIO, open: async (path: string, create: boolean) => {
      const handle = await nodeWalIO.open(path, create);
      return { ...handle, sync: async () => { await handle.sync(); if (armed) { armed = false; throw Error("lost sync acknowledgment"); } } };
    } };
    const runtime = requireValue(await openDurableEtherMemoriesInternal({ userId: store.snapshot.identity.userId,
      directory: store.directory, openMode: "existing" }, { io: store.io, files })); runtimes.push(runtime);
    const plan = requireValue(runtime.previewDreamCycle({ kind: "all_active" }, { asOf: DREAM_AS_OF }));
    if (state === "closed") requireValue(await runtime.close());
    else { armed = true; expect((await runtime.updateMemory("b", { content: "ambiguous changed source" }, "t4-ambiguous")).ok).toBe(false); }
    expect(runtime.state).toBe(state);
    const trap = vi.fn(() => { throw Error("hostile caller trap"); });
    const hostile = Object.defineProperty({}, "algorithm", { get: trap });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("authority clock forbidden"); });
    const analyze = vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(() => { throw Error("authority analysis forbidden"); });
    for (const input of [null, proxy, hostile, { algorithm: "ether.dream.v2" }, plan]) expect(run(runtime, input)).toMatchObject({ ok: false, error: { code: state === "closed" ? "CLOSED" : "RECOVERY_REQUIRED" } });
    expect(trap).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled(); vi.restoreAllMocks();
    if (state === "recovery-required") { requireValue(await runtime.recover()); expect(run(runtime, plan)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(run(runtime, requireValue(runtime.previewDreamCycle({ kind: "all_active" }, { asOf: DREAM_AS_OF }))).ok).toBe(true); }
  });
});
