import { describe, expect, it } from "vitest";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";

describe("v0.4 release-gate diagnostics", () => {
  it("keeps dense triangle edges in structural neighborhoods", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    for (const id of ["a", "b", "c"]) e.graph.addNode({ id, type: "test", data: {} });
    e.graph.addEdgeWithId("ab", "a", "b");
    e.graph.addEdgeWithId("bc", "b", "c");
    e.graph.addEdgeWithId("ca", "c", "a");
    const slice = e.graph.getNeighbors("a", 1);
    expect(slice.nodes.map(n => n.id)).toEqual(["b", "c"]);
    expect(slice.edges.map(edge => edge.id)).toEqual(["ab", "ca"]);
  });

  it("caps recall BFS, does not re-expand visited nodes, and is deterministic", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    const notes = ["needle", "b", "c", "d"].map(content => e.addMemory({ content }));
    expect(notes.every(n => n.ok)).toBe(true);
    if (!notes.every(n => n.ok)) return;
    e.graph.addEdgeWithId("e1", `memory:${notes[0].value.id}`, `memory:${notes[1].value.id}`);
    e.graph.addEdgeWithId("e2", `memory:${notes[1].value.id}`, `memory:${notes[2].value.id}`);
    e.graph.addEdgeWithId("e3", `memory:${notes[2].value.id}`, `memory:${notes[3].value.id}`);
    const seed = notes[0].value;
    const first = e.graph.getRecallNeighbors(`memory:${seed.id}`, 2, 2);
    const second = e.graph.getRecallNeighbors(`memory:${seed.id}`, 2, 2);
    expect(first.nodes.length).toBeLessThanOrEqual(2);
    expect(first.nodes.map(n => n.id)).toEqual(second.nodes.map(n => n.id));
    expect(first.edges.map(edge => edge.id)).toEqual(second.edges.map(edge => edge.id));
  });

  it("honors recall direction and relation allowlists", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    for (const id of ["a", "b", "c"]) e.graph.addNode({ id, type: "test", data: {} });
    e.graph.addEdgeWithId("out", "a", "b", "supports");
    e.graph.addEdgeWithId("in", "c", "a", "mentions");
    expect(e.graph.getRecallNeighbors("a", 1, 8, ["supports"], "out").nodes.map(n => n.id)).toEqual(["b"]);
    expect(e.graph.getRecallNeighbors("a", 1, 8, ["mentions"], "in").nodes.map(n => n.id)).toEqual(["c"]);
  });

  it("uses the highest-scoring seed path and does not accumulate scores", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    const weak = e.addMemory({ content: "needle weak", importance: 0 });
    const strong = e.addMemory({ content: "needle strong", importance: 1 });
    const target = e.addMemory({ content: "unrelated target" });
    expect(weak.ok && strong.ok && target.ok).toBe(true);
    if (!weak.ok || !strong.ok || !target.ok) return;
    e.graph.addEdgeWithId("a-weak", `memory:${weak.value.id}`, `memory:${target.value.id}`);
    e.graph.addEdgeWithId("z-strong", `memory:${strong.value.id}`, `memory:${target.value.id}`);
    const result = e.queryMemoriesDetailed("needle", { graphRecall: { enabled: true, depth: 1, maxResults: 8 } });
    if (!result.ok) return;
    const match = result.value.find(item => item.memory.id === target.value.id)!;
    expect(match.graphEvidence?.seedMemoryId).toBe(strong.value.id);
    expect(result.value.filter(item => item.memory.id === target.value.id)).toHaveLength(1);
  });

  it("exposes graph evidence on context notes", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    const a = e.addMemory({ content: "needle" });
    const b = e.addMemory({ content: "neighbor" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    e.graph.addEdgeWithId("ab", `memory:${a.value.id}`, `memory:${b.value.id}`);
    const context = e.buildMemoryContext({ purpose: "debug", query: {
      text: "needle", graph: { enabled: true, neighborhoodDepth: 1 }, budget: { maxNotes: 10 }
    }});
    expect(context.ok).toBe(true);
    expect(context.ok && context.value.notes.find(n => n.note.id === b.value.id)?.graphEvidence?.path[0].edgeId).toBe("ab");
  });

  it("isolates nested metadata and provenance on every note read and input", () => {
    const metadata = { nested: { value: 1 }, list: [{ value: 2 }] };
    const provenance = { kind: "inferred" as const, detail: "original" };
    const e = new EtherMemoriesCore({ userId: "u", preferences: { nested: { keep: true } } });
    const added = e.addMemory({ content: "clone", metadata, provenance });
    metadata.nested.value = 9; provenance.detail = "changed";
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    added.value.metadata.nested = { value: 8 };
    added.value.provenance.detail = "changed";
    const initial = e.notes.get(added.value.id);
    expect(initial.ok && initial.value.metadata.nested).toEqual({ value: 1 });
    const read = e.notes.get(added.value.id);
    if (read.ok) ((read.value.metadata.list as Array<{ value: number }>)[0]).value = 7;
    const stored = e.notes.get(added.value.id);
    expect(stored.ok && stored.value.metadata.list).toEqual([{ value: 2 }]);
    const state = e.getSystemState();
    (state.preferences.nested as { keep: boolean }).keep = false;
    expect((e.getSystemState().preferences.nested as { keep: boolean }).keep).toBe(true);
  });

  it("isolates nested diary metadata on read, update, and input", () => {
    const metadata = { nested: { value: 1 } };
    const e = new EtherMemoriesCore({ userId: "u" });
    const added = e.addDiaryEntry({ content: "diary", metadata });
    metadata.nested.value = 5;
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    (added.value.metadata.nested as { value: number }).value = 6;
    const initial = e.diary.get(added.value.id);
    expect(initial.ok && initial.value.metadata.nested).toEqual({ value: 1 });
    const updated = e.updateDiary(added.value.id, { metadata: { nested: { value: 2 } } });
    expect(updated.ok).toBe(true);
    if (updated.ok) (updated.value.metadata.nested as { value: number }).value = 9;
    const final = e.diary.get(added.value.id);
    expect(final.ok && final.value.metadata.nested).toEqual({ value: 2 });
  });

  it("rejects every malformed present graph variant without mutation", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    e.addMemory({ content: "keep" });
    const baseline = JSON.stringify(e.exportData());
    const variants = [
      { graph: [] },
      { graph: { nodes: {}, edges: [] } },
      { graph: { nodes: [{ id: "n", type: "x", data: {} }], edges: [{ id: "e", source: "missing", target: "n" }] } },
      { graph: { nodes: [{ id: "n", type: "x", data: {} }], edges: [{ id: "e", source: "n", target: "n", data: [] }] } }
    ];
    for (const variant of variants) {
      const incoming = { ...e.exportData(), ...variant };
      expect(e.importData(incoming).ok).toBe(false);
      expect(JSON.stringify(e.exportData())).toBe(baseline);
    }
  });

  it("rejects duplicate directed endpoints and preserves state on rejected imports", () => {
    const e = new EtherMemoriesCore({ userId: "u" });
    const a = e.addMemory({ content: "keep" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const incoming = e.exportData();
    const node = { id: "x", type: "test", data: {} };
    incoming.graph.nodes.push(node, { ...node, id: "y" });
    incoming.graph.edges.push(
      { id: "one", source: "x", target: "y", relationship: "supports", data: {} },
      { id: "two", source: "x", target: "y", relationship: "mentions", data: {} }
    );
    const before = JSON.stringify(e.exportData());
    expect(e.importData(incoming).ok).toBe(false);
    expect(JSON.stringify(e.exportData())).toBe(before);
  });
});
