import { afterEach, describe, expect, it, vi } from "vitest";
import { EtherMemoriesCore } from "../src/index.js";
import { value } from "./helpers/persistence.js";
import { explanationSnapshot, healthSnapshot, INSPECTION_LIMITS } from "../src/core/inspectionSnapshot.js";
import { analyzeHealth, analyzeExplanation } from "../src/core/memoryInspection.js";
import { inspectionGraph, inspectionNotes } from "../src/core/inspectionSources.js";

const core = () => new EtherMemoriesCore({ userId: "inspection" });
afterEach(() => vi.restoreAllMocks());

describe("T2 factual memory inspection", () => {
  it("rejects invalid and unknown IDs, including diary IDs", () => {
    const c = core();
    expect(c.explainMemory("", { asOf: 100 }).ok).toBe(false);
    expect(c.explainMemory("unknown", { asOf: 100 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const diary = value(c.addDiaryEntry({ content: "diary only" }));
    expect(c.explainMemory(diary.id, { asOf: 100 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("reports canonical evidence and effective expiry without changing canonical state", () => {
    const c = core();
    const n = value(c.addMemory({ content: "private body", status: "candidate", tags: ["z", "A", "a"],
      category: "fact", confidence: 0.3, expiresAt: new Date(100), metadata: { private: "unused" } }));
    const before = c.exportData(), revision = c.notes.revision;
    const report = value(c.explainMemory(n.id, { asOf: 100 }));
    expect(report.note).toMatchObject({ id: n.id, status: "candidate", expired: true, confidence: 0.3,
      category: "fact", tags: ["A", "a", "z"], expiresAt: 100 });
    expect(report.relationships).toMatchObject({ knownCount: 0, returnedCount: 0, truncated: false });
    expect(JSON.stringify(report)).not.toContain("private body");
    expect(JSON.stringify(report)).not.toContain("unused");
    expect(c.exportData()).toEqual(before);
    expect(c.notes.revision).toBe(revision);
    expect(value(c.explainMemory(n.id, { asOf: 99 })).note.expired).toBe(false);
    value(c.inspectMemoryHealth({ asOf: 100 }));
    expect(c.exportData()).toEqual(before);
    expect(c.notes.revision).toBe(revision);
  });

  it("captures the clock once and gives repeatable explicit-time reports", () => {
    const c = core(), n = value(c.addMemory({ content: "time", expiresAt: new Date(100) }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const a = value(c.explainMemory(n.id));
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockClear();
    expect(value(c.inspectMemoryHealth()).asOf).toBe(100);
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockClear();
    expect(value(c.explainMemory(n.id, { asOf: 100 }))).toEqual(a);
    expect(clock).not.toHaveBeenCalled();
    expect(c.inspectMemoryHealth({ asOf: NaN })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("selects sorted direct edges only and never returns adjacent content", () => {
    const c = core(), n = value(c.addMemory({ content: "root" }));
    const root = `memory:${n.id}`;
    for (const id of ["z", "a", "A", "depth2"]) value(c.graph.addNode({ id, type: "concept", label: "adjacent secret", data: { secret: "metadata secret" } }));
    value(c.graph.addEdgeWithId("z-edge", root, "z", "supports"));
    value(c.graph.addEdgeWithId("A-edge", "A", root, "mentions"));
    value(c.graph.addEdgeWithId("a-edge", root, "a", "about"));
    value(c.graph.addEdgeWithId("indirect", "a", "depth2"));
    value(c.graph.addEdgeWithId("self", root, root));
    const r = value(c.explainMemory(n.id, { asOf: 100 }));
    expect(r.relationships.entries.map(e => e.id)).toEqual(["A-edge", "a-edge", "self", "z-edge"]);
    expect(r.relationships.entries.map(e => e.direction)).toEqual(["in", "out", "self", "out"]);
    expect(r.relationships.knownCount).toBe(4);
    for (const secret of ["depth2", "adjacent secret", "metadata secret", "indirect"]) expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("uses bounded projections rather than existing whole-store clone APIs", () => {
    const c = core(), n = value(c.addMemory({ content: "private", metadata: { huge: "x".repeat(200000) } }));
    for (const method of ["get", "getAll", "valuesUnsafe"] as const) vi.spyOn(c.notes, method).mockImplementation(() => { throw Error("whole clone"); });
    for (const method of ["getNeighbors", "getAllNodes", "getAllEdges"] as const) vi.spyOn(c.graph, method).mockImplementation(() => { throw Error("whole graph"); });
    expect(c.explainMemory(n.id, { asOf: 100 }).ok).toBe(true);
    expect(c.inspectMemoryHealth({ asOf: 100 }).ok).toBe(true);
  });

  it("reports health taxonomy and explicit empty/full coverage", () => {
    const c = core();
    expect(value(c.inspectMemoryHealth({ asOf: 100 }))).toMatchObject({ asOf: 100,
      invariantFailures: [], observations: [], suggestions: [], coverage: { complete: true, knownCount: 0, inspectedCount: 0 } });
    value(c.addMemory({ content: "expired", expiresAt: new Date(100) }));
    value(c.notes.add({ content: "unlinked invalid confidence", confidence: NaN }));
    const r = value(c.inspectMemoryHealth({ asOf: 100 }));
    expect(r.coverage).toMatchObject({ complete: true, knownCount: 2, inspectedCount: 2 });
    expect(r.invariantFailures.map(f => f.code)).toContain("invalid-confidence");
    expect(r.observations.map(f => f.code)).toEqual(expect.arrayContaining(["expired-notes", "missing-graph-nodes", "isolated-notes"]));
    expect(r.suggestions.every(s => s.authoritative === false)).toBe(true);
    expect(r).not.toHaveProperty("healthy");
    expect(r).not.toHaveProperty("score");
  });

  it.each(["active", "candidate", "archived", "rejected"] as const)("explains stored %s status even when expired", status => {
    const c = core(), n = value(c.addMemory({ content: "lifecycle", status, expiresAt: new Date(10) }));
    expect(value(c.explainMemory(n.id, { asOf: 10 })).note).toMatchObject({ status, expired: true });
    expect(value(c.inspectMemoryHealth({ asOf: 10 })).counts[status]).toBe(1);
  });

  it("does not invent provenance, graph facts or ranking reasons", () => {
    const c = core(), n = value(c.notes.add({ content: "evidence" }));
    // This shape is accepted by existing snapshot preparation; absent kind is not inferred by T2.
    n.provenance = {} as typeof n.provenance;
    c.notes.replaceAll([n]);
    const r = value(c.explainMemory(n.id, { asOf: 100 }));
    expect(r.note.provenance).toBeNull();
    expect(r.unavailableEvidence).toEqual(["provenance", "category", "graph-node"]);
    expect(r.relationships.entries).toEqual([]);
    for (const key of ["rank", "accessCount", "causalReason", "importance", "metadata", "content"]) expect(r.note).not.toHaveProperty(key);
  });

  it("whitelists provenance references and excludes freeform detail", () => {
    const c = core(), n = value(c.addMemory({ content: "p", provenance: { kind: "imported", parentNoteId: "parent", importBatchId: "batch", detail: "private narrative" } }));
    expect(value(c.explainMemory(n.id, { asOf: 100 })).note.provenance).toEqual({ kind: "imported", parentNoteId: "parent", importBatchId: "batch" });
  });

  it("detaches snapshots and reports in both directions and uses no nonplain values", () => {
    const c = core(), n = value(c.addMemory({ content: "old", tags: ["old"], provenance: { kind: "imported", importBatchId: "old" } }));
    const e = explanationSnapshot(c.notes, c.graph, n.id, 100)!;
    const h = healthSnapshot(c.notes, c.graph, 100);
    const assertPlain = (v: unknown): void => {
      if (v && typeof v === "object") {
        expect(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype).toBe(true);
        for (const child of Object.values(v)) assertPlain(child);
      } else expect(["string", "number", "boolean", "undefined"].includes(typeof v) || v === null).toBe(true);
    };
    assertPlain(e); assertPlain(h);
    const eBefore = JSON.stringify(e), hBefore = JSON.stringify(h);
    value(c.updateMemory(n.id, { tags: ["new"], confidence: 0.9 }));
    expect(JSON.stringify(e)).toBe(eBefore); expect(JSON.stringify(h)).toBe(hBefore);
    const r = value(c.explainMemory(n.id, { asOf: 100 }));
    r.note.tags.push("caller"); r.note.provenance!.importBatchId = "caller";
    r.relationships.entries.push({ id: "caller", relationship: "about", direction: "out", adjacentId: "caller" });
    const hr = value(c.inspectMemoryHealth({ asOf: 100 }));
    hr.coverage.reasons.push("caller"); hr.counts.active = 0;
    expect(value(c.explainMemory(n.id, { asOf: 100 })).note.tags).toEqual(["new"]);
    expect(value(c.explainMemory(n.id, { asOf: 100 })).note.provenance!.importBatchId).toBe("old");
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).counts.active).toBe(1);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("pure clock"); });
    expect(analyzeExplanation(e).asOf).toBe(100); expect(analyzeHealth(h).asOf).toBe(100);
    expect(clock).not.toHaveBeenCalled();
  });

  it.each([31, 32, 33, 4096, 4097])("bounds direct relationships at %i with honest known/returned counts", count => {
    const c = core(), n = value(c.addMemory({ content: "graph bound" })), root = `memory:${n.id}`;
    for (let i = count - 1; i >= 0; i--) {
      const id = `adj-${String(i).padStart(5, "0")}`;
      value(c.graph.addNode({ id, type: "concept", label: "unused", data: {} }));
      value(c.graph.addEdgeWithId(`edge-${String(i).padStart(5, "0")}`, root, id));
    }
    const r = value(c.explainMemory(n.id, { asOf: 100 })).relationships;
    const expected = count > 4096 ? 0 : Math.min(count, 32);
    expect(r).toMatchObject({ knownCount: count, returnedCount: expected, truncated: count > expected });
    expect(r.entries.map(e => e.id)).toEqual(Array.from({ length: expected }, (_, i) => `edge-${String(i).padStart(5, "0")}`));
    if (count > 4096) expect(r.reasons).toEqual(["relationship-work-limit"]);
  });

  it.each([31, 32, 33, 256, 257])("bounds and sorts %i tags", count => {
    const c = core(), tags = Array.from({ length: count }, (_, i) => `tag-${String(i).padStart(3, "0")}`).reverse();
    const n = value(c.addMemory({ content: "tags", tags }));
    const r = value(c.explainMemory(n.id, { asOf: 100 })).note;
    expect(r.tags.length).toBe(count > 256 ? 0 : Math.min(count, 32));
    expect(r.tagsKnownCount).toBe(count); expect(r.tagsTruncated).toBe(count > r.tags.length);
    expect(r.tags).toEqual([...r.tags].sort());
  });

  it.each([255, 256, 257, 4096, 4097])("reports deterministic health coverage for %i notes", count => {
    const c = core(), template = value(c.notes.add({ content: "coverage" }));
    const notes = Array.from({ length: count }, (_, i) => ({ ...template, id: `note-${String(i).padStart(5, "0")}`, confidence: NaN }));
    c.notes.replaceAll([...notes].reverse());
    const a = value(c.inspectMemoryHealth({ asOf: 100 }));
    expect(a.coverage).toMatchObject({ knownCount: count, inspectedCount: count > 4096 ? 0 : Math.min(count, 256), complete: count <= 256 });
    expect(a.invariantFailures.length).toBe(count > 4096 ? 0 : 128);
    expect(a.findingsTruncated).toBe(count <= 4096);
    c.notes.replaceAll(notes);
    expect(value(c.inspectMemoryHealth({ asOf: 100 }))).toEqual(a);
    expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThan(INSPECTION_LIMITS.snapshotBytes);
  });

  it("bounds identifier bytes before selection and scalar bytes before projection", () => {
    const c = core(), template = value(c.notes.add({ content: "bytes" }));
    c.notes.replaceAll(Array.from({ length: 1500 }, (_, i) => ({ ...template, id: `${"中".repeat(250)}${String(i).padStart(4, "0")}` })));
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).coverage).toMatchObject({ complete: false, inspectedCount: 0, reasons: ["population-selection-byte-limit"] });
    c.notes.replaceAll([{ ...template, id: "x".repeat(257) }]);
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).coverage.reasons).toEqual(["identifier-scalar-limit"]);
    expect(c.explainMemory("x".repeat(257), { asOf: 100 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("uses deterministic limit reasons when multiple selection bounds are exceeded", () => {
    const c = core(), template = value(c.notes.add({ content: "multiple bounds" }));
    const notes = Array.from({ length: 1500 }, (_, i) => ({ ...template, id: `${"中".repeat(250)}${String(i).padStart(4, "0")}` }));
    notes.push({ ...template, id: "x".repeat(257) });
    c.notes.replaceAll(notes);
    const a = value(c.inspectMemoryHealth({ asOf: 100 }));
    c.notes.replaceAll([...notes].reverse());
    expect(value(c.inspectMemoryHealth({ asOf: 100 }))).toEqual(a);
  });

  it("flags reachable invalid timestamps but does not invent a note chronology invariant", () => {
    const c = core(), n = value(c.notes.add({ content: "timestamp", expiresAt: new Date(NaN) }));
    n.createdAt = new Date(200); n.updatedAt = new Date(100);
    c.notes.replaceAll([n]);
    expect(value(c.explainMemory(n.id, { asOf: 100 })).note.expired).toBeNull();
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).invariantFailures).toEqual([{ code: "invalid-timestamp", noteId: n.id }]);
    n.expiresAt = undefined; c.notes.replaceAll([n]);
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).invariantFailures).toEqual([]);
  });

  it("ignores unused body and metadata size while work depends on bounded fields only", () => {
    const c = core(), n = value(c.addMemory({ content: "small" }));
    const before = value(c.inspectMemoryHealth({ asOf: 100 }));
    const e = value(c.explainMemory(n.id, { asOf: 100 }));
    const changed = value(c.notes.get(n.id));
    changed.content = "x".repeat(1000000); changed.metadata = { huge: "x".repeat(1000000) };
    c.notes.replaceAll([changed]);
    expect(value(c.inspectMemoryHealth({ asOf: 100 }))).toEqual(before);
    expect(value(c.explainMemory(n.id, { asOf: 100 }))).toEqual(e);
  });

  it.each([null, [], "x", { asOf: Infinity }, { asOf: 8640000000000001 }])("rejects invalid options %j without throwing", options => {
    expect(core().inspectMemoryHealth(options as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it.each([255, 256, 257])("enforces the %i-code-unit scalar boundary without shortening evidence", length => {
    const c = core(), n = value(c.addMemory({ content: "scalar", category: "x".repeat(length) }));
    const result = c.explainMemory(n.id, { asOf: 100 });
    expect(result.ok).toBe(length <= 256);
    if (result.ok) expect(result.value.note.category!.length).toBe(length);
  });

  it.each([-1, 0, 1])("enforces identifier-selection byte cap with offset %i", offset => {
    const c = core(), template = value(c.notes.add({ content: "bytes boundary" }));
    const notes = Array.from({ length: 4096 }, (_, i) => ({ ...template, id: `${"x".repeat(252)}${String(i).padStart(4, "0")}` }));
    if (offset === -1) notes[0].id = notes[0].id.slice(1);
    if (offset === 1) notes[0].id = `é${notes[0].id.slice(1)}`;
    c.notes.replaceAll(notes);
    const coverage = value(c.inspectMemoryHealth({ asOf: 100 })).coverage;
    expect(coverage.inspectedCount).toBe(offset > 0 ? 0 : 256);
    expect(coverage.reasons).toEqual(offset > 0 ? ["population-selection-byte-limit"] : ["note-output-limit"]);
  });

  it("applies the snapshot byte cap to a deterministic health prefix", () => {
    const c = core(), template = value(c.notes.add({ content: "snapshot bytes" }));
    const notes = Array.from({ length: 256 }, (_, i) => ({ ...template,
      id: `${"中".repeat(252)}${String(i).padStart(4, "0")}`, status: "中".repeat(256) as typeof template.status }));
    c.notes.replaceAll(notes);
    const s = healthSnapshot(c.notes, c.graph, 100);
    expect(s.coverage.complete).toBe(false); expect(s.coverage.inspectedCount).toBeGreaterThan(0);
    expect(s.coverage.inspectedCount).toBeLessThan(256);
    expect(s.coverage.reasons).toEqual(["snapshot-byte-limit"]);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(INSPECTION_LIMITS.snapshotBytes);
    c.notes.replaceAll([...notes].reverse());
    expect(healthSnapshot(c.notes, c.graph, 100)).toEqual(s);
  });

  it("uses indexed constant-time graph access for at most 256 health notes", () => {
    const c = core();
    for (let i = 0; i < 257; i++) value(c.addMemory({ content: `note ${i}` }));
    const graph = inspectionGraph(c.graph);
    const degree = vi.spyOn(graph, "degree"), self = vi.spyOn(graph, "hasDirectedEdge");
    const edges = vi.spyOn(graph, "edges").mockImplementation(() => { throw Error("health must not enumerate edges"); });
    const source = inspectionNotes(c.notes);
    const get = vi.spyOn(source, "get");
    expect(c.inspectMemoryHealth({ asOf: 100 }).ok).toBe(true);
    expect(get).toHaveBeenCalledTimes(256); expect(degree).toHaveBeenCalledTimes(256); expect(self).toHaveBeenCalledTimes(256);
    expect(edges).not.toHaveBeenCalled();
  });

  it("does not visit identifiers or notes above the population work limit", () => {
    const c = core(), template = value(c.notes.add({ content: "work" }));
    c.notes.replaceAll(Array.from({ length: 4097 }, (_, i) => ({ ...template, id: `id-${i}` })));
    const source = inspectionNotes(c.notes);
    const keys = vi.spyOn(source, "keys").mockImplementation(() => { throw Error("over-limit identifier scan"); });
    const get = vi.spyOn(source, "get");
    expect(value(c.inspectMemoryHealth({ asOf: 100 })).coverage.reasons).toEqual(["population-work-limit"]);
    expect(keys).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });

  it("enforces the edge-identifier byte ceiling before selecting attributes", () => {
    const c = core(), n = value(c.addMemory({ content: "edge bytes" })), root = `memory:${n.id}`;
    for (let i = 0; i < 1500; i++) {
      const id = `adj-${i}`; value(c.graph.addNode({ id, type: "concept", label: "unused", data: {} }));
      value(c.graph.addEdgeWithId(`${"中".repeat(250)}${String(i).padStart(4, "0")}`, root, id));
    }
    const graph = inspectionGraph(c.graph), attrs = vi.spyOn(graph, "getEdgeAttribute");
    expect(value(c.explainMemory(n.id, { asOf: 100 })).relationships).toMatchObject({ knownCount: 1500,
      returnedCount: 0, truncated: true, reasons: ["relationship-selection-byte-limit"] });
    expect(attrs).not.toHaveBeenCalled();
  });
});
