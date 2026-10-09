import { afterEach, describe, expect, it, vi } from "vitest";
import { EtherMemoriesCore, type MemoryNote, type DreamSelector, type DreamCyclePreviewOptions } from "../src/index.js";
import { value } from "./helpers/persistence.js";
import { inspectionNotes } from "../src/core/inspectionSources.js";

const AS_OF = 100;
// Calls the real public method while allowing hostile untyped caller arguments.
const preview = (c: EtherMemoriesCore, selector?: unknown, options: unknown = { asOf: AS_OF }): any =>
  c.previewDreamCycle(selector as DreamSelector, options as DreamCyclePreviewOptions);
const fixture = (specs: Array<Partial<MemoryNote> & { id: string }> = [{ id: "A" }, { id: "B" }]) => {
  const c = new EtherMemoriesCore({ userId: "dream-tests" });
  const template = value(c.notes.add({ content: "alpha beta", tags: ["shared"] }));
  c.notes.replaceAll(specs.map(spec => ({ ...template, createdAt: new Date(10), updatedAt: new Date(20), ...spec })));
  for (const spec of specs) value(c.graph.addNode({ id: `memory:${spec.id}`, type: "memory", data: {} }));
  return c;
};
const fail = (result: any, code = "INVALID_INPUT") => expect(result).toMatchObject({ ok: false, error: { code } });
afterEach(() => vi.restoreAllMocks());

describe("T3 bounded Dream selection", () => {
  it.each([
    [{ kind: "ids", ids: ["B", "A"] }, ["A", "B"]],
    [{ kind: "tags", tags: ["shared"] }, ["A", "B"]],
    [{ kind: "query", query: "BETA alpha" }, ["A", "B"]],
    [{ kind: "date-window", from: 10, to: 11 }, ["A", "B"]],
    [{ kind: "all_active" }, ["A", "B"]]
  ])("selects canonical Memory Notes with %j", (selector, ids) => {
    const plan = value(preview(fixture(), selector)) as any;
    expect(plan).toMatchObject({ algorithm: "ether.dream.v1", asOf: 100, selectedSourceIds: ids,
      selectedCount: 2, knownCount: 2, selectionTruncated: false, truncationReasons: [], graph: { relationshipCount: 0 } });
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/); expect(plan.dependencyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan)).not.toContain("alpha beta");
  });
  it("returns a deterministic empty plan for a valid unmatched selector", () => {
    const c = fixture(); const a = value(preview(c, { kind: "tags", tags: ["missing"] })) as any;
    expect(a.selectedSourceIds).toEqual([]); expect(a.knownCount).toBe(0);
    expect(preview(c, { kind: "tags", tags: ["missing"] })).toEqual({ ok: true, value: a });
  });
  it("normalizes ID order and duplicates without changing meaning", () => {
    const c = fixture(); expect(preview(c, { kind: "ids", ids: ["B", "A", "A"] })).toEqual(preview(c, { kind: "ids", ids: ["A", "B"] }));
  });
  it("normalizes duplicate tag order but preserves exact canonical tag spelling", () => {
    const c = fixture([{ id: "A", tags: ["One", "two"] }, { id: "B", tags: ["one", "two"] }]);
    expect(preview(c, { kind: "tags", tags: ["two", "One", "One"] })).toEqual(preview(c, { kind: "tags", tags: ["One", "two"] }));
    expect(value(preview(c, { kind: "tags", tags: ["One"] }))).toMatchObject({ selectedSourceIds: ["A"] });
  });
  it("uses all query tokens only from canonical content, without metadata/summary/Diary matching", () => {
    const c = fixture([{ id: "A", content: "Café beta" }, { id: "B", content: "alpha", summary: "beta", metadata: { secret: "beta" } }]);
    value(c.addDiaryEntry({ content: "Café beta" }));
    expect(value(preview(c, { kind: "query", query: "CAFE\u0301 BETA" }))).toMatchObject({ selectedSourceIds: ["A"] });
    expect(value(preview(c, { kind: "query", query: "alpha beta" }))).toMatchObject({ selectedSourceIds: [] });
  });
  it("excludes candidate, archived, rejected, expired and future-created notes without mutation", () => {
    const c = fixture([{ id: "active" }, { id: "candidate", status: "candidate" }, { id: "archived", status: "archived" },
      { id: "rejected", status: "rejected" }, { id: "expired", expiresAt: new Date(100) }, { id: "future", createdAt: new Date(101) }]);
    const before = c.exportData(), revision = c.notes.revision;
    expect(value(preview(c, { kind: "all_active" }))).toMatchObject({ selectedSourceIds: ["active"] });
    expect(c.exportData()).toEqual(before); expect(c.notes.revision).toBe(revision);
  });
  it("accepts a promoted candidate as authoritative active memory", () => {
    const c = fixture([{ id: "candidate", status: "candidate" }]); value(c.notes.promoteCandidate("candidate"));
    expect(value(preview(c, { kind: "ids", ids: ["candidate"] }))).toMatchObject({ selectedSourceIds: ["candidate"] });
  });
  it("uses inclusive start and exclusive end on createdAt", () => {
    const c = fixture([{ id: "start", createdAt: new Date(10) }, { id: "end", createdAt: new Date(20) }]);
    expect(value(preview(c, { kind: "date-window", from: 10, to: 20 }))).toMatchObject({ selectedSourceIds: ["start"] });
  });
  it("captures the implicit clock exactly once and never reads it for explicit asOf", () => {
    const c = fixture(); const clock = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(1000);
    const a = Reflect.get(c, "previewDreamCycle").call(c, { kind: "all_active" }); expect(clock).toHaveBeenCalledTimes(1);
    clock.mockClear(); const b = preview(c, { kind: "all_active" }, { asOf: 100 });
    expect(clock).not.toHaveBeenCalled(); expect(a).toEqual(b);
  });
  it("preserves explicit asOf and evaluates expiry at that exact instant", () => {
    const c = fixture([{ id: "A", expiresAt: new Date(100) }]);
    expect(value(preview(c, { kind: "all_active" }, { asOf: 99 }))).toMatchObject({ asOf: 99, selectedSourceIds: ["A"] });
    expect(value(preview(c, { kind: "all_active" }, { asOf: 100 }))).toMatchObject({ asOf: 100, selectedSourceIds: [] });
  });
  it.each([undefined, null, [], {}, { kind: "bad" }, { kind: "all_active", ids: ["A"] }, { kind: "ids", ids: [] },
    { kind: "tags", tags: [] }, { kind: "query", query: "!!!" }, { kind: "date-window", from: 20, to: 10 }])("fails malformed selector %j", selector => fail(preview(fixture(), selector)));
  it.each([null, [], 1, { asOf: NaN }, { asOf: Infinity }, { asOf: 8640000000000001 }, { asOf: 1.5 }, { asOf: 100, extra: true },
    { asOf: 100, budgets: null }, { asOf: 100, budgets: { maxSources: 129 } }, { asOf: 100, budgets: { maxSources: 0 } }])("fails malformed options %j", options => fail(preview(fixture(), { kind: "all_active" }, options)));
  it("reports unknown explicit IDs rather than silently dropping intent", () => fail(preview(fixture(), { kind: "ids", ids: ["unknown"] }), "NOT_FOUND"));
  it.each(["candidate", "archived", "rejected"] as const)("fails explicitly requested ineligible %s memory", status => fail(preview(fixture([{ id: "A", status }]), { kind: "ids", ids: ["A"] })));
  it.each([255, 256])("bounds raw selector count before deterministic deduplication at %i", count => {
    expect(value(preview(fixture(), { kind: "ids", ids: Array(count).fill("A") }))).toMatchObject({ selectedSourceIds: ["A"] });
  });
  it("rejects N+1 and huge duplicate arrays before reading elements", () => {
    const ids = Array(257).fill("A"); Object.defineProperty(ids, 0, { get() { throw Error("must not read"); } });
    fail(preview(fixture(), { kind: "ids", ids })); fail(preview(fixture(), { kind: "tags", tags: Array(100000).fill("shared") }));
  });
  it.each(["ids", "tags", "query"])("rejects million-space %s before trim/normalization", kind => {
    const c = fixture(), huge = " ".repeat(1000000);
    const selector = kind === "ids" ? { kind, ids: [huge] } : kind === "tags" ? { kind, tags: [huge] } : { kind, query: huge };
    const trim = vi.spyOn(String.prototype, "trim"), normalize = vi.spyOn(String.prototype, "normalize");
    trim.mockClear(); normalize.mockClear(); const result = preview(c, selector);
    const calls = [trim.mock.calls.length, normalize.mock.calls.length]; trim.mockRestore(); normalize.mockRestore();
    fail(result); expect(calls).toEqual([0, 0]);
  });
  it("rejects accessor request fields without invoking caller code", () => {
    const c = fixture(); let reads = 0;
    const selector = { get kind() { reads++; return "all_active"; } };
    const options = { get asOf() { reads++; return 100; } };
    fail(preview(c, selector)); fail(preview(c, { kind: "all_active" }, options)); expect(reads).toBe(0);
  });
  it("selects deterministically at the source ceiling and reports exact truncated coverage", () => {
    const c = fixture(Array.from({ length: 129 }, (_, i) => ({ id: `n${String(128 - i).padStart(3, "0")}` })));
    const p = value(preview(c, { kind: "all_active" })) as any;
    expect(p.selectedSourceIds).toHaveLength(128); expect(p.selectedSourceIds[0]).toBe("n000"); expect(p.selectedSourceIds[127]).toBe("n127");
    expect(p).toMatchObject({ selectedCount: 128, knownCount: 129, selectionTruncated: true, truncationReasons: ["source-limit"] });
  });
  it("permits only caller reductions and truncates under lower source budgets", () => {
    const p = value(preview(fixture(), { kind: "all_active" }, { asOf: 100, budgets: { maxSources: 1 } })) as any;
    expect(p).toMatchObject({ selectedSourceIds: ["A"], selectedCount: 1, knownCount: 2, selectionTruncated: true });
  });
  it("rejects oversized non-ID population before enumeration but still permits direct ID selection", () => {
    const c = fixture(); const source = inspectionNotes(c.notes) as Map<string, MemoryNote>;
    const n = source.get("A")!; for (let i = 0; i < 4097; i++) source.set(`extra${i}`, { ...n, id: `extra${i}` });
    const keys = vi.spyOn(source, "keys").mockImplementation(() => { throw Error("must not enumerate"); });
    fail(preview(c, { kind: "all_active" }));
    expect(value(preview(c, { kind: "ids", ids: ["A"] }))).toMatchObject({ selectedSourceIds: ["A"] });
    expect(keys).not.toHaveBeenCalled();
  });
  it("bounds selected content before encoding and respects UTF8 rather than code-unit byte limits", () => {
    fail(preview(fixture([{ id: "A", content: "x".repeat(65537) }]), { kind: "ids", ids: ["A"] }));
    fail(preview(fixture([{ id: "A", content: "é".repeat(32769) }]), { kind: "ids", ids: ["A"] }));
    expect(preview(fixture([{ id: "A", content: "x".repeat(65536) }]), { kind: "ids", ids: ["A"] }).ok).toBe(true);
  });
});
