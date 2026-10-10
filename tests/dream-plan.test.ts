import { afterEach, describe, expect, it, vi } from "vitest";
import { EtherMemoriesCore, type MemoryNote, type DreamSelector, type DreamCyclePreviewOptions } from "../src/index.js";
import { value } from "./helpers/persistence.js";
import { inspectionNotes, inspectionGraph } from "../src/core/inspectionSources.js";

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
  it.each([null, [], 1, { asOf: NaN }, { asOf: Infinity }, { asOf: 8640000000000001 }, { asOf: 1.5 }, { asOf: 100, budgets: { maxSources: 1.5 } },
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
  it.each(["selector", "options", "budgets"])("reads only fixed schema descriptors on wide %s containers", location => {
    const c = fixture();
    const baseline = preview(c, { kind: "all_active" }, { asOf: 100, budgets: { maxSources: 1 } });
    for (const width of [0, 100000]) {
      const selector: Record<string, unknown> = { kind: "all_active" };
      const budgets: Record<string, unknown> = { maxSources: 1 };
      const options: Record<string, unknown> = { asOf: 100, budgets };
      const target = location === "selector" ? selector : location === "options" ? options : budgets;
      for (let i = 0; i < width; i++) target[`unrelated_${i}`] = i;
      const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
      const result = preview(c, selector, options);
      const keys = descriptors.mock.calls.filter(([object]) => object === target).map(([, key]) => key);
      descriptors.mockRestore();
      expect(result).toEqual(baseline);
      expect(keys).toEqual(location === "selector" ? ["kind", "ids", "tags", "query", "from", "to"] :
        location === "options" ? ["asOf", "budgets"] : Object.keys(baseline.value.budgets));
    }
  });
  it.each(["selector", "options", "budgets"])("ignores unrelated %s data, symbols and accessors without reading or returning them", location => {
    const c = fixture();
    const selector: Record<string, unknown> = { kind: "all_active" };
    const budgets: Record<string, unknown> = { maxSources: 1 };
    const options: Record<string, unknown> = { asOf: 100, budgets };
    const baseline = preview(c, selector, options);
    const target = location === "selector" ? selector : location === "options" ? options : budgets;
    let reads = 0;
    Object.defineProperty(target, "unrelated", { enumerable: true, get() { reads++; throw Error("must not read"); } });
    Object.defineProperty(target, "hiddenUnrelated", { value: "SECRET", enumerable: false });
    Object.defineProperty(target, Symbol("unrelated"), { enumerable: true, get() { reads++; throw Error("must not read"); } });
    expect(preview(c, selector, options)).toEqual(baseline); expect(reads).toBe(0);
  });
  it.each([
    [4097, "\u0130a".repeat(1365) + " a"],
    [6144, "\u0130a".repeat(2048)]
  ] as const)("rejects bounded raw queries that expand to %i normalized units", (_normalizedUnits, query) => {
    expect(query.length).toBeLessThanOrEqual(4096);
    fail(preview(fixture(), { kind: "query", query }));
  });
  it("replays the returned normalized query exactly at the canonical query ceiling", () => {
    const c = fixture([{ id: "A", content: "i ai aa" }]);
    const plan = value(preview(c, { kind: "query", query: "\u0130a".repeat(1365) + "a" })) as any;
    expect(plan.selector.query.length).toBe(4096); expect(plan.selectedSourceIds).toEqual(["A"]);
    expect(preview(c, plan.selector, { asOf: plan.asOf, budgets: plan.budgets })).toEqual({ ok: true, value: plan });
  });
  it.each(["selector", "options", "budgets", "ids", "tags"])("rejects proxy %s containers before invoking any caller trap", location => {
    const c = fixture(); let traps = 0;
    const wrap = (target: object) => new Proxy(target, {
      getPrototypeOf(value) { traps++; return Reflect.getPrototypeOf(value); },
      ownKeys(value) { traps++; return Reflect.ownKeys(value); },
      get(value, key, receiver) { traps++; return Reflect.get(value, key, receiver); },
      getOwnPropertyDescriptor(value, key) { traps++; return Reflect.getOwnPropertyDescriptor(value, key); }
    });
    let selector: unknown = { kind: "ids", ids: ["A"] }, options: unknown = { asOf: 100 };
    if (location === "selector") selector = wrap({ kind: "all_active" });
    if (location === "options") options = wrap({ asOf: 100 });
    if (location === "budgets") options = { asOf: 100, budgets: wrap({ maxSources: 1 }) };
    if (location === "ids") selector = { kind: "ids", ids: wrap(["A"]) };
    if (location === "tags") selector = { kind: "tags", tags: wrap(["shared"]) };
    const result = preview(c, selector, options); expect(traps).toBe(0); fail(result);
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

describe("T3 dependency closure and information boundary", () => {
  const ids = { kind: "ids", ids: ["A", "B"] };
  const edge = (c: EtherMemoriesCore, id: string, from: string, to: string, relation = "related_to") =>
    value(c.graph.addEdgeWithId(id, `memory:${from}`, `memory:${to}`, relation, { secret: "unused-edge-body" }));
  it("binds selected-selected relationships and changes digest with their semantics", () => {
    const c = fixture(); const a = value(preview(c, ids)) as any;
    edge(c, "AB", "A", "B", "supports"); const b = value(preview(c, ids)) as any;
    expect(b.graph).toEqual({ relationshipCount: 1 }); expect(b.dependencyDigest).not.toBe(a.dependencyDigest);
    inspectionGraph(c.graph).setEdgeAttribute("AB", "relationship", "mentions");
    expect(value(preview(c, ids))).not.toMatchObject({ dependencyDigest: b.dependencyDigest });
  });
  it("excludes secret neighbors, second degree, foreign edges and Diary from selection and identity", () => {
    const c = fixture([{ id: "A" }, { id: "B" }, { id: "SECRET-C", content: "neighbor-secret-body" }, { id: "SECRET-D" }]);
    const before = preview(c, ids);
    edge(c, "SECRET-AC", "A", "SECRET-C"); edge(c, "SECRET-CD", "SECRET-C", "SECRET-D");
    value(c.addDiaryEntry({ content: "diary-secret-body", tags: ["shared"] }));
    expect(preview(c, ids)).toEqual(before); const text = JSON.stringify(before);
    for (const sentinel of ["SECRET-C", "SECRET-D", "SECRET-AC", "neighbor-secret-body", "diary-secret-body"]) expect(text).not.toContain(sentinel);
    expect(value(preview(c, { kind: "query", query: "diary secret body" }))).toMatchObject({ selectedSourceIds: [] });
  });
  it("never traverses neighbors or reads graph node labels/data", () => {
    const c = fixture(); edge(c, "AB", "A", "B");
    const graph = inspectionGraph(c.graph);
    const neighbors = vi.spyOn(graph, "neighbors").mockImplementation(() => { throw Error("traversal forbidden"); });
    const data = vi.spyOn(graph, "getNodeAttributes").mockImplementation(() => { throw Error("node content forbidden"); });
    expect(value(preview(c, ids))).toMatchObject({ graph: { relationshipCount: 1 } });
    expect(neighbors).not.toHaveBeenCalled(); expect(data).not.toHaveBeenCalled();
  });
  it("does not bind or expose arbitrary selected edge data", () => {
    const c = fixture(); edge(c, "AB", "A", "B"); const before = preview(c, ids);
    inspectionGraph(c.graph).setEdgeAttribute("AB", "data", { private: "huge-and-irrelevant", nested: Array(1000).fill("x") });
    expect(preview(c, ids)).toEqual(before); expect(JSON.stringify(before)).not.toContain("unused-edge-body");
  });
  it("makes graph and note insertion permutations produce the same complete plan", () => {
    const a = fixture([{ id: "A" }, { id: "B" }]), b = fixture([{ id: "B" }, { id: "A" }]);
    edge(a, "AB", "A", "B"); edge(a, "BA", "B", "A", "mentions");
    edge(b, "BA", "B", "A", "mentions"); edge(b, "AB", "A", "B");
    expect(preview(a, ids)).toEqual(preview(b, { kind: "ids", ids: ["B", "A", "B"] }));
  });
  it("retains the independent empty-plan golden digest and distinct plan ID", () => {
    const p = value(preview(fixture(), { kind: "tags", tags: ["missing"] })) as any;
    expect(p.dependencyDigest).toBe("3b7d9df6e31ade3ca3ff96fd8154cf52fb481bd68d6ceeec4db590e08ba4f857");
    expect(p.planId).toBe("8e1cdcc6cdac876342e0b265fe4f26c7ba00a9bcbbcbb716d19ece32afe0f295");
    expect(p.planId).not.toBe(p.dependencyDigest);
  });
  it.each(["content", "tags", "expiresAt", "createdAt"])("binds consumed selected %s changes", key => {
    const c = fixture(), source = inspectionNotes(c.notes) as Map<string, MemoryNote>;
    const before = value(preview(c, ids)) as any, n = source.get("A")!;
    if (key === "content") n.content = "new content";
    if (key === "tags") n.tags = ["changed"];
    if (key === "expiresAt") n.expiresAt = new Date(200);
    if (key === "createdAt") n.createdAt = new Date(11);
    expect(value(preview(c, ids))).not.toMatchObject({ dependencyDigest: before.dependencyDigest });
  });
  it("does not bind unused metadata, updatedAt or arbitrary application fields", () => {
    const c = fixture(), before = preview(c, ids);
    value(c.updateMemory("A", { metadata: { secret: "unused" }, summary: "unused summary", category: "unused category", importance: 0.1, confidence: 0.1, pinned: true }));
    expect(preview(c, ids)).toEqual(before);
  });
  it("does not even read cyclic/accessor metadata or clone unselected sources", () => {
    const c = fixture([{ id: "A" }, { id: "B" }, { id: "Z", content: "x".repeat(1000000) }]);
    const source = inspectionNotes(c.notes) as Map<string, MemoryNote>, n = source.get("A")!;
    Object.defineProperty(n, "metadata", { get() { throw Error("metadata forbidden"); } });
    expect(preview(c, ids).ok).toBe(true);
    const getter = vi.spyOn(c.notes, "valuesUnsafe").mockImplementation(() => { throw Error("full clone forbidden"); });
    expect(preview(c, ids).ok).toBe(true); expect(getter).not.toHaveBeenCalled();
  });
  it("keeps ID plans stable after unrelated note changes and creation", () => {
    const c = fixture([{ id: "A" }, { id: "B" }, { id: "Z" }]), before = preview(c, ids);
    value(c.updateMemory("Z", { content: "unrelated new content", tags: ["different"] }));
    value(c.addMemory({ content: "unrelated later note" })); expect(preview(c, ids)).toEqual(before);
  });
  it.each(["all_active", "query"])("binds relevant %s bounded-set and coverage changes", kind => {
    const c = fixture([{ id: "B" }, { id: "C" }]), selector = kind === "query" ? { kind, query: "alpha" } : { kind };
    const options = { asOf: 100, budgets: { maxSources: 1 } };
    const before = value(preview(c, selector, options)) as any;
    const source = inspectionNotes(c.notes) as Map<string, MemoryNote>, n = source.get("B")!;
    source.set("A", { ...n, id: "A" }); const changed = value(preview(c, selector, options)) as any;
    expect(changed.selectedSourceIds).toEqual(["A"]); expect(changed.dependencyDigest).not.toBe(before.dependencyDigest);
    source.set("Z", { ...n, id: "Z" }); const coverage = value(preview(c, selector, options)) as any;
    expect(coverage.selectedSourceIds).toEqual(["A"]); expect(coverage.knownCount).toBe(4); expect(coverage.planId).not.toBe(changed.planId);
  });
  it("does not bind a query-nonmatching note body's changes", () => {
    const c = fixture([{ id: "A" }, { id: "Z", content: "unrelated" }]), selector = { kind: "query", query: "alpha" };
    const before = preview(c, selector); value(c.updateMemory("Z", { content: "still unrelated" })); expect(preview(c, selector)).toEqual(before);
  });
  it("binds selector, budget and asOf changes to identity", () => {
    const c = fixture(), a = value(preview(c, ids)) as any;
    for (const next of [preview(c, { kind: "all_active" }), preview(c, ids, { asOf: 100, budgets: { maxSources: 2 } }), preview(c, ids, { asOf: 101 })]) {
      expect(value(next)).not.toMatchObject({ planId: a.planId });
    }
  });
  it("is locale-independent and uses no random plan identifiers", () => {
    const c = fixture([{ id: "a" }, { id: "Z" }, { id: "A" }]);
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw Error("locale forbidden"); });
    vi.spyOn(Math, "random").mockImplementation(() => { throw Error("random forbidden"); });
    expect(value(preview(c, { kind: "all_active" }))).toMatchObject({ selectedSourceIds: ["A", "Z", "a"] });
  });
  it("rejects relationship overflow rather than silently binding partial evidence", () => {
    const c = fixture(); edge(c, "AB", "A", "B"); edge(c, "BA", "B", "A");
    fail(preview(c, ids, { asOf: 100, budgets: { maxRelationships: 1 } }));
    expect(value(preview(c, ids, { asOf: 100, budgets: { maxRelationships: 2 } }))).toMatchObject({ graph: { relationshipCount: 2 } });
  });
  it("handles selected self-relationships exactly once", () => {
    const c = fixture(); edge(c, "AA", "A", "A"); expect(value(preview(c, ids))).toMatchObject({ graph: { relationshipCount: 1 } });
  });
  it.each(["maxDependencyBytes", "maxNoteDependencyBytes", "maxPlanBytes", "maxSelectionBytes"])("fails boundedly under tiny %s ceilings", key => {
    fail(preview(fixture(), ids, { asOf: 100, budgets: { [key]: 1 } }));
  });
  it("rejects excess canonical tags before element access", () => {
    const c = fixture(), n = (inspectionNotes(c.notes) as Map<string, MemoryNote>).get("A")!;
    n.tags = Array(65).fill("x"); Object.defineProperty(n.tags, 0, { get() { throw Error("must not read"); } });
    fail(preview(c, ids));
  });
  it("fails aggregate dependency bytes while each source is individually legal", () => {
    const c = fixture(Array.from({ length: 17 }, (_, i) => ({ id: `n${i}`, content: "x".repeat(65536) })));
    fail(preview(c, { kind: "all_active" }));
  });
  it("stops dependency projection before touching later bodies when the aggregate is exhausted", () => {
    const c = fixture([{ id: "A", content: "x".repeat(1024) }, { id: "B" }]);
    const n = (inspectionNotes(c.notes) as Map<string, MemoryNote>).get("B")!; let reads = 0;
    Object.defineProperty(n, "content", { get() { reads++; return "late-body"; } });
    fail(preview(c, ids, { asOf: 100, budgets: { maxDependencyBytes: 256 } })); expect(reads).toBe(0);
  });
  it("rejects query scan work before processing an excessive aggregate of unselected text", () => {
    const c = fixture([{ id: "A", content: "unrelated" }, { id: "B", content: "unrelated" }]);
    fail(preview(c, { kind: "query", query: "missing" }, { asOf: 100, budgets: { maxSelectionBytes: 5 } }));
  });
  it("keeps output small and completely detached in both directions", () => {
    const c = fixture(); const p = value(preview(c, ids)) as any, old = structuredClone(p);
    p.selectedSourceIds.push("foreign"); p.selector.ids.push("foreign"); p.budgets.maxSources = 1; p.graph.relationshipCount = 9;
    expect(preview(c, ids)).toEqual({ ok: true, value: old });
    value(c.updateMemory("A", { content: "later change" })); expect(old.selectedSourceIds).toEqual(["A", "B"]);
    expect(JSON.stringify(p).length).toBeLessThan(2048); expect(p.asOf).toBeTypeOf("number");
  });
  it("never invokes condensation or creates candidates during preview", () => {
    const c = fixture(); const before = c.exportData(), revision = c.notes.revision;
    const condensation = vi.spyOn(c.condensation, "analyze").mockImplementation(() => { throw Error("analysis forbidden"); });
    const commit = vi.spyOn(c.condensation, "commitAnalysis").mockImplementation(() => { throw Error("candidate creation forbidden"); });
    const condense = vi.spyOn(c.condensation, "condense").mockImplementation(() => { throw Error("condensation forbidden"); });
    expect(preview(c, ids).ok).toBe(true); expect(c.exportData()).toEqual(before); expect(c.notes.revision).toBe(revision);
    expect(condensation).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled(); expect(condense).not.toHaveBeenCalled();
  });
});
