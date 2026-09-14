import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { tokenize } from "../src/core/Tokenizer.js";
import { LIBRARY_VERSION } from "../src/version.js";
import type { MemoryNote } from "../src/types/index.js";

const note = (id: string, content: string, changes: Partial<MemoryNote> = {}): MemoryNote => ({
  id,
  content,
  tags: [],
  source: "user",
  provenance: { kind: "user_explicit" },
  importance: 0.5,
  confidence: 0.75,
  pinned: false,
  status: "active",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  metadata: {},
  ...changes
});

describe("v0.5 deterministic retrieval foundation", () => {
  it("tokenizes Unicode, accents, apostrophes, punctuation, whitespace, numbers, and non-ASCII text canonically", () => {
    expect(tokenize("  Café’s—résumé,\t42 你好!  ")).toEqual(["café’s", "résumé", "42", "你好"]);
    expect(tokenize("e\u0301 É")).toEqual(["é", "é"]);
    expect(tokenize("don't stop")).toEqual(["don't", "stop"]);
  });

  it("gates lower match classes below stronger classes", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([
      note("partial", "TypeScript only"),
      note("tagged", "Unrelated text", { tags: ["typescript"] }),
      note("exact", "TypeScript project"),
      note("full", "Project TypeScript", { importance: 1 })
    ]);

    const result = core.queryMemoriesDetailed("TypeScript project");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(item => [item.memory.id, item.matchClass])).toEqual([
      ["exact", "exact_phrase"],
      ["full", "full_token_match"],
      ["partial", "partial_token_match"],
      ["tagged", "tag_metadata_match"]
    ]);
  });

  it("supports explicit IDs and deterministic code-unit ordering", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([
      note("a", "same", { createdAt: new Date(0), updatedAt: new Date(0) }),
      note("B", "same", { createdAt: new Date(0), updatedAt: new Date(0) })
    ]);
    const explicit = core.queryMemoriesDetailed("", { explicitIds: ["a"] });
    expect(explicit.ok && explicit.value[0].matchClass).toBe("explicit_id");
    const ordered = core.queryMemoriesDetailed("same");
    expect(ordered.ok && ordered.value.map(item => item.memory.id)).toEqual(["B", "a"]);
  });

  it("uses asOf for expiry and gives repeated queries stable output", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([
      note("future", "release", { expiresAt: new Date("2024-01-02T00:00:00.000Z") }),
      note("past", "release", { expiresAt: new Date("2023-12-31T00:00:00.000Z") })
    ]);
    const options = { asOf: new Date("2024-01-01T12:00:00.000Z") };
    const first = core.queryMemoriesDetailed("release", options);
    const second = core.queryMemoriesDetailed("release", options);
    expect(first).toEqual(second);
    expect(first.ok && first.value.map(item => item.memory.id)).toEqual(["future"]);
  });

  it("rebuilds the derived index after public manager mutations", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const added = core.notes.add({ content: "indexed directly" });
    expect(added.ok).toBe(true);
    const initial = core.queryMemories("indexed directly");
    expect(initial.ok && initial.value).toHaveLength(1);
    if (!added.ok) return;
    core.notes.update(added.value.id, { content: "renamed directly" });
    const oldQuery = core.queryMemories("indexed");
    const newQuery = core.queryMemories("renamed directly");
    expect(oldQuery.ok && oldQuery.value).toHaveLength(0);
    expect(newQuery.ok && newQuery.value).toHaveLength(1);

    const diary = core.diary.add({ content: "diary indexed directly" });
    expect(diary.ok).toBe(true);
    expect(core.retriever.searchDiary("diary indexed directly")).toHaveLength(1);
  });

  it("matches the fixed corpus golden retrieval baseline", async () => {
    const snapshot = JSON.parse(await readFile(new URL("./fixtures/store-v0.3.json", import.meta.url), "utf8"));
    const golden = JSON.parse(await readFile(new URL("./fixtures/retrieval-golden-v1.json", import.meta.url), "utf8"));
    const core = new EtherMemoriesCore({ userId: "fixture-user" });
    expect(core.importData(snapshot).ok).toBe(true);
    const summarize = (text: string, options = {}) => {
      const result = core.queryMemoriesDetailed(text, options);
      expect(result.ok).toBe(true);
      return result.ok ? result.value.map(item => ({
        id: item.memory.id,
        score: item.score,
        matchClass: item.matchClass,
        matchedBy: item.matchedBy,
        graphEvidence: item.graphEvidence
      })) : [];
    };
    expect(summarize("TypeScript")).toEqual(golden.queries.default);
    expect(summarize("TypeScript", { includeCandidate: true, includeArchived: true, includeExpired: true })).toEqual(golden.queries.allFilters);
    expect(summarize("TypeScript", { graphRecall: { enabled: true, depth: 1, maxResults: 1 } })).toEqual(golden.queries.graph);
  });

  it("reports structured lexical evidence without phantom signals", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([note("evidence", "Café project", {
      tags: ["project"],
      category: "work",
      metadata: { claimKey: "cafe" }
    })]);
    const result = core.queryMemoriesDetailed("Café");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].evidence).toMatchObject({
      matchClass: "exact_phrase",
      exactPhrase: "café",
      matchedTokens: ["café"],
      explicitId: false,
      contributions: { graph: 0 }
    });
    expect(result.value[0].evidence.graph).toBeUndefined();
  });

  it("deep-clones structured evidence at the public retrieval boundary", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addMemory({ content: "isolated evidence" });
    const first = core.queryMemoriesDetailed("isolated evidence");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.value[0].evidence.matchedTokens[0] = "mutated";
    first.value[0].evidence.contributions.lexical = -1;
    const second = core.queryMemoriesDetailed("isolated evidence");
    expect(second.ok && second.value[0].evidence.matchedTokens[0]).toBe("isolated");
    expect(second.ok && second.value[0].evidence.contributions.lexical).toBeGreaterThan(0);
  });

  it("preserves graph evidence and chooses the lexicographically smallest equal path", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const seed = core.addMemory({ content: "seed" });
    const left = core.addMemory({ content: "left" });
    const right = core.addMemory({ content: "right" });
    const target = core.addMemory({ content: "unrelated target" });
    expect(seed.ok && left.ok && right.ok && target.ok).toBe(true);
    if (!seed.ok || !left.ok || !right.ok || !target.ok) return;
    core.graph.addEdgeWithId("z-seed-left", `memory:${seed.value.id}`, `memory:${left.value.id}`);
    core.graph.addEdgeWithId("z-left-target", `memory:${left.value.id}`, `memory:${target.value.id}`);
    core.graph.addEdgeWithId("a-seed-right", `memory:${seed.value.id}`, `memory:${right.value.id}`);
    core.graph.addEdgeWithId("a-right-target", `memory:${right.value.id}`, `memory:${target.value.id}`);
    const result = core.queryMemoriesDetailed("seed", { graphRecall: { enabled: true, depth: 2, maxResults: 8 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.value.find(item => item.memory.id === target.value.id);
    expect(match?.graphEvidence?.path.map(step => step.edgeId)).toEqual(["a-seed-right", "a-right-target"]);
    expect(match?.evidence.graph?.edgeIds).toEqual(["a-seed-right", "a-right-target"]);
    expect(match?.evidence.contributions.graph).toBeGreaterThan(0);
  });

  it("honors graph direction, relation filters, cycles, triangles, and traversal caps", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const seed = core.addMemory({ content: "seed" });
    const out = core.addMemory({ content: "out target" });
    const incoming = core.addMemory({ content: "incoming target" });
    const blocked = core.addMemory({ content: "blocked target" });
    expect(seed.ok && out.ok && incoming.ok && blocked.ok).toBe(true);
    if (!seed.ok || !out.ok || !incoming.ok || !blocked.ok) return;
    core.graph.addEdgeWithId("out-edge", `memory:${seed.value.id}`, `memory:${out.value.id}`, "supports");
    core.graph.addEdgeWithId("in-edge", `memory:${incoming.value.id}`, `memory:${seed.value.id}`, "supports");
    core.graph.addEdgeWithId("blocked-edge", `memory:${seed.value.id}`, `memory:${blocked.value.id}`, "mentions");
    core.graph.addEdgeWithId("cycle-edge", `memory:${out.value.id}`, `memory:${seed.value.id}`, "supports");
    const result = core.queryMemoriesDetailed("seed", {
      graphRecall: { enabled: true, depth: 1, maxResults: 1, direction: "out", relationAllowlist: ["supports"] }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filter(item => item.matchedBy.includes("graph_neighbor")).map(item => item.memory.id)).toEqual([out.value.id]);
  });

  it("uses live Note state for deleted, candidate, archived, and expired graph targets", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const seed = core.addMemory({ content: "seed" });
    const deleted = core.addMemory({ content: "deleted" });
    const candidate = core.addMemory({ content: "candidate", status: "candidate" });
    const archived = core.addMemory({ content: "archived", status: "archived" });
    const expired = core.addMemory({ content: "expired", expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    expect(seed.ok && deleted.ok && candidate.ok && archived.ok && expired.ok).toBe(true);
    if (!seed.ok || !deleted.ok || !candidate.ok || !archived.ok || !expired.ok) return;
    for (const target of [deleted, candidate, archived, expired]) {
      if (target.ok) core.graph.addEdge(`memory:${seed.value.id}`, `memory:${target.value.id}`, "supports");
    }
    core.deleteMemory(deleted.value.id);
    const result = core.queryMemoriesDetailed("seed", {
      asOf: new Date("2024-01-01T00:00:00.000Z"),
      graphRecall: { enabled: true, depth: 1, maxResults: 8 }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.some(item => item.memory.id === deleted.value.id)).toBe(false);
    expect(result.value.some(item => item.memory.id === candidate.value.id)).toBe(false);
    expect(result.value.some(item => item.memory.id === archived.value.id)).toBe(false);
    expect(result.value.some(item => item.memory.id === expired.value.id)).toBe(false);
  });

  it("reports LIBRARY_VERSION as 0.5.0 per the frozen v0.5 design", () => {
    expect(LIBRARY_VERSION).toBe("0.5.0");
    const core = new EtherMemoriesCore({ userId: "u1" });
    const context = core.buildMemoryContext({ purpose: "debug" });
    expect(context.ok).toBe(true);
    if (context.ok) expect(context.value.libraryVersion).toBe("0.5.0");
  });

  it("S1: diary matchedBy reports token-only matches as token, not exact_phrase", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    // Diary contains "alpha" but not the exact phrase "alpha gamma"
    core.addDiaryEntry({ content: "alpha beta diary entry" });
    const context = core.buildMemoryContext({
      purpose: "debug",
      query: { text: "alpha gamma", budget: { maxNotes: 0, maxDiary: 10, maxNodes: 0, maxEdges: 0 } }
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value.diary).toHaveLength(1);
    // "alpha gamma" is not an exact phrase in the diary text, only "alpha" is a token hit
    expect(context.value.diary[0].matchedBy).not.toContain("exact_phrase");
    expect(context.value.diary[0].matchedBy).toContain("token");
  });

  it("S1: diary matchedBy reports exact-phrase matches as exact_phrase", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addDiaryEntry({ content: "alpha beta diary entry" });
    const context = core.buildMemoryContext({
      purpose: "debug",
      query: { text: "alpha beta", budget: { maxNotes: 0, maxDiary: 10, maxNodes: 0, maxEdges: 0 } }
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value.diary).toHaveLength(1);
    expect(context.value.diary[0].matchedBy).toContain("exact_phrase");
  });

  it("S2: explicit noteIds respects lifecycle filters (candidate excluded by default)", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([
      note("cand", "candidate text", { status: "candidate" }),
      note("act", "active text")
    ]);
    // Without includeCandidate, candidate note should NOT appear
    const excluded = core.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["cand", "act"], budget: { maxNotes: 10, maxDiary: 0, maxNodes: 0, maxEdges: 0 } }
    });
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) return;
    expect(excluded.value.notes.map(n => n.note.id)).toEqual(["act"]);
    // With includeCandidate, candidate note SHOULD appear
    const included = core.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["cand", "act"], filters: { includeCandidate: true }, budget: { maxNotes: 10, maxDiary: 0, maxNodes: 0, maxEdges: 0 } }
    });
    expect(included.ok).toBe(true);
    if (!included.ok) return;
    expect(included.value.notes.map(n => n.note.id).sort()).toEqual(["act", "cand"]);
  });

  it("S2: explicit noteIds respects expiry and archived filters", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.notes.replaceAll([
      note("exp", "expired text", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
      note("arch", "archived text", { status: "archived" })
    ]);
    const excluded = core.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["exp", "arch"], budget: { maxNotes: 10, maxDiary: 0, maxNodes: 0, maxEdges: 0 } }
    });
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) return;
    expect(excluded.value.notes).toHaveLength(0);
    const included = core.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["exp", "arch"], filters: { includeExpired: true, includeArchived: true }, budget: { maxNotes: 10, maxDiary: 0, maxNodes: 0, maxEdges: 0 } }
    });
    expect(included.ok).toBe(true);
    if (!included.ok) return;
    expect(included.value.notes.map(n => n.note.id).sort()).toEqual(["arch", "exp"]);
  });

  it("S3: matchedDiaryCount is pre-truncation, parallel to matchedNoteCount", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addDiaryEntry({ content: "matching diary one" });
    core.addDiaryEntry({ content: "matching diary two" });
    core.addDiaryEntry({ content: "matching diary three" });
    const context = core.buildMemoryContext({
      purpose: "debug",
      query: { text: "matching diary", budget: { maxNotes: 0, maxDiary: 1, maxNodes: 0, maxEdges: 0 } }
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    // matchedDiaryCount should be 3 (pre-truncation), not 1 (post-truncation)
    expect(context.value.retrieval.matchedDiaryCount).toBe(3);
    expect(context.value.diary).toHaveLength(1);
    expect(context.value.truncation.diaryOmitted).toBe(2);
  });

  it("S4: queryMemoriesDetailed clones matchedBy array at the public boundary", () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addMemory({ content: "clone boundary test" });
    const first = core.queryMemoriesDetailed("clone boundary");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value[0].matchedBy.length).toBeGreaterThan(0);
    (first.value[0].matchedBy as string[]).push("injected");
    (first.value[0].matchedBy as string[])[0] = "mutated";
    const second = core.queryMemoriesDetailed("clone boundary");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value[0].matchedBy).not.toContain("injected");
    expect(second.value[0].matchedBy).not.toContain("mutated");
    expect(second.value[0].matchedBy).toContain("exact_phrase");
  });
});
