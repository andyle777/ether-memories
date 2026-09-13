import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { toAgentToolResult } from "../src/adapters/agentTool.js";
import { toRlmEnv } from "../src/adapters/rlmEnv.js";
import { LIBRARY_VERSION, STORE_SCHEMA_VERSION } from "../src/version.js";

describe("Ether Memories v0.4.0", () => {
  it("creates notes and links foundation nodes", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const r = e.addMemory({ content: "Andy is building Ether Memories.", tags: ["project"] });
    expect(r.ok).toBe(true);
    expect(e.graph.getNode(`memory:${r.ok ? r.value.id : ""}`)).toBeTruthy();
  });

  it("protects pinned edits", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const r = e.addMemory({ content: "Pinned fact", pinned: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blocked = e.updateMemory(r.value.id, { content: "Changed" });
    expect(blocked.ok).toBe(false);
    const allowed = e.updateMemory(r.value.id, { content: "Changed", allowPinnedEdit: true });
    expect(allowed.ok).toBe(true);
  });

  it("restores identity and rejects foreign users", async () => {
    const a = new EtherMemoriesCore({ userId: "u1", displayName: "Andy" });
    const note = a.addMemory({ content: "Persist me" });
    expect(note.ok).toBe(true);
    const snap = a.exportData();

    const b = new EtherMemoriesCore({ userId: "u1" });
    expect(b.importData(snap).ok).toBe(true);
    expect(b.getSystemState().displayName).toBe("Andy");
    expect(b.notes.getAll()[0].createdAt instanceof Date).toBe(true);

    const foreign = new EtherMemoriesCore({ userId: "u2" });
    const result = foreign.importData(snap);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("USER_ID_MISMATCH");
  });

  it("supports diary CRUD", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const r = e.addDiaryEntry({ content: "Today I shipped a memory library." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(e.updateDiary(r.value.id, { content: "Updated diary." }).ok).toBe(true);
    expect(e.deleteDiary(r.value.id).ok).toBe(true);
    expect(e.diary.getAll()).toHaveLength(0);
  });

  it("builds bounded, citeable context with graph neighborhood", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const a = e.addMemory({ content: "Ether has three foundations.", metadata: { claimKey: "foundations" } });
    const b = e.addMemory({ content: "Memory Notes are durable facts.", metadata: { claimKey: "notes" } });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    e.graph.addEdge(`memory:${a.value.id}`, `memory:${b.value.id}`, "related_to", { origin: "manual" });
    const c = e.buildMemoryContext({
      purpose: "agent_tool",
      query: { text: "three foundations", noteIds: [a.value.id], budget: { maxNotes: 2, maxNodes: 10, maxEdges: 10, maxDiary: 2 } }
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.notes[0].cite.ref).toBe(`note:${a.value.id}`);
    expect(c.value.graph.nodes.length).toBeGreaterThan(0);
    expect(toAgentToolResult(c.value).citations.length).toBeGreaterThan(0);
    expect(toRlmEnv(c.value).handles.noteIds).toContain(a.value.id);
  });

  it("keeps candidate memories out of default retrieval", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.condensation.condense("Candidate memory");
    const hidden = e.queryMemories("Candidate memory");
    expect(hidden.ok && hidden.value).toHaveLength(0);
    const visible = e.queryMemories("Candidate memory", { includeCandidate: true });
    expect(visible.ok && visible.value.length).toBe(1);
  });

  it("flags duplicate claim keys without inventing an AI conflict judgment", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.addMemory({ content: "Favourite language is TypeScript.", metadata: { claimKey: "favorite_language" } });
    e.addMemory({ content: "Favourite language is Python.", metadata: { claimKey: "favorite_language" } });
    const c = e.buildMemoryContext({ purpose: "debug", query: { text: "language", budget: { maxNotes: 10, maxDiary: 2, maxNodes: 10, maxEdges: 10 } } });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.retrieval.conflictFlags[0].reason).toBe("duplicate_claim_key");
  });
  it("duplicate_edge_returns_conflict", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.graph.addNode({ id: "a", type: "test", data: {} });
    e.graph.addNode({ id: "b", type: "test", data: {} });
    expect(e.graph.addEdge("a", "b", "related_to").ok).toBe(true);
    const duplicate = e.graph.addEdge("a", "b", "supports");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFLICT");
  });

  it("diary_text_enters_memory_context", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const entry = e.addDiaryEntry({ content: "Configured Termux during the train ride." });
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    const context = e.buildMemoryContext({ purpose: "debug", query: { text: "Termux", budget: { maxDiary: 2 } } });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value.diary.map(item => item.entry.id)).toContain(entry.value.id);
    expect(context.value.citations.map(c => c.ref)).toContain(`diary:${entry.value.id}`);
  });

  it("condensation_creates_graph_link", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const diary = e.addDiaryEntry({ content: "A source entry." });
    expect(diary.ok).toBe(true);
    if (!diary.ok) return;
    const note = e.condensation.condense("A candidate distilled from the diary.", diary.value.id);
    expect(note).toBeTruthy();
    if (!note) return;
    expect(note.status).toBe("candidate");
    expect(note.provenance).toMatchObject({ kind: "diary_extract", parentDiaryId: diary.value.id });
    expect(e.graph.getNode(`memory:${note.id}`)).toBeTruthy();
    expect(e.graph.getNode(`diary:${diary.value.id}`)).toBeTruthy();
    expect(e.graph.getAllEdges()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: `memory:${note.id}`, target: `diary:${diary.value.id}`, relationship: "derived_from" })
    ]));
  });

  it("purge_expired_removes_graph_node", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const note = e.addMemory({ content: "Temporary linked fact", expiresAt: new Date(Date.now() - 1) });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    e.graph.addNode({ id: "other", type: "test", data: {} });
    expect(e.graph.addEdge(`memory:${note.value.id}`, "other").ok).toBe(true);
    expect(e.graph.getNode(`memory:${note.value.id}`)).toBeTruthy();
    expect(e.purgeExpired()).toBe(1);
    expect(e.notes.get(note.value.id).ok).toBe(false);
    expect(e.graph.getNode(`memory:${note.value.id}`)).toBeUndefined();
    expect(e.graph.getAllEdges()).toHaveLength(0);
  });

  it("empty_query_returns_empty", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.addMemory({ content: "A durable fact", pinned: true, importance: 1 });
    const result = e.queryMemories("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("matchedBy_only_reports_fired_evidence", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const note = e.addMemory({ content: "Termux setup instructions", importance: 1 });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const detailed = e.queryMemoriesDetailed("Termux");
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) return;
    expect(detailed.value[0].matchedBy).toContain("exact_phrase");
    expect(detailed.value[0].matchedBy).not.toContain("importance");
    expect(detailed.value[0].matchedBy).not.toContain("recency");
  });

  it("pinned_only_does_not_create_false_query_evidence", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.addMemory({ content: "Pinned fact", pinned: true });
    const detailed = e.queryMemoriesDetailed("unrelated", { pinnedOnly: true });
    expect(detailed.ok).toBe(true);
    if (detailed.ok) expect(detailed.value).toEqual([]);
  });

  it("deduplicates_explicit_diary_ids", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const entry = e.addDiaryEntry({ content: "A repeated diary source." });
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    const context = e.buildMemoryContext({
      purpose: "debug",
      query: { diaryIds: [entry.value.id, entry.value.id], budget: { maxDiary: 2 } }
    });
    expect(context.ok).toBe(true);
    if (context.ok) {
      expect(context.value.diary).toHaveLength(1);
      expect(context.value.truncation.diaryOmitted).toBe(0);
    }
  });

  it("reports_diary_budget_truncation", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.addDiaryEntry({ content: "First matching diary entry." });
    e.addDiaryEntry({ content: "Second matching diary entry." });
    const context = e.buildMemoryContext({
      purpose: "debug",
      query: { text: "matching diary", budget: { maxDiary: 1 } }
    });
    expect(context.ok).toBe(true);
    if (context.ok) {
      expect(context.value.diary).toHaveLength(1);
      expect(context.value.truncation.diaryOmitted).toBe(1);
      expect(context.value.truncation.hitBudget).toBe(true);
    }
  });

  it("accounts_for_character_budget_boundaries", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const note = e.addMemory({ content: "1234567890" });
    expect(note.ok).toBe(true);
    if (!note.ok) return;

    const exact = e.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: [note.value.id], budget: { maxChars: 10, maxNodes: 0, maxEdges: 0 } }
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.value.notes[0].note.content).toBe("1234567890");
    expect(exact.value.truncation.charsOmitted).toBe(0);

    const truncated = e.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: [note.value.id], budget: { maxChars: 5, maxNodes: 0, maxEdges: 0 } }
    });
    expect(truncated.ok).toBe(true);
    if (truncated.ok) {
      expect(truncated.value.notes[0].note.content).toBe("12...");
      expect(truncated.value.truncation.charsOmitted).toBe(5);
      expect(truncated.value.truncation.hitBudget).toBe(true);
    }
  });

  it("loads_supported_v03_snapshot_schema", () => {
    const source = new EtherMemoriesCore({ userId: "u1" });
    const note = source.addMemory({ content: "Supported snapshot" });
    expect(note.ok).toBe(true);
    const target = new EtherMemoriesCore({ userId: "u1" });
    const result = target.importData(source.exportData());
    expect(result.ok).toBe(true);
    expect(target.notes.getAll()[0].content).toBe("Supported snapshot");
  });

  it("rejects_unknown_schema_without_mutating_state", () => {
    const target = new EtherMemoriesCore({ userId: "u1", displayName: "Before" });
    const note = target.addMemory({ content: "Existing note" });
    const diary = target.addDiaryEntry({ content: "Existing diary" });
    expect(note.ok && diary.ok).toBe(true);
    if (!note.ok || !diary.ok) return;
    target.graph.addNode({ id: "custom", type: "custom", data: { keep: true } });
    const before = JSON.stringify(target.exportData());

    const incoming = target.exportData();
    incoming.schemaVersion = "ether.memory_store.v0.4" as typeof STORE_SCHEMA_VERSION;
    incoming.identity.displayName = "Should not load";
    incoming.memoryNotes = [];
    incoming.diary = [];
    const result = target.importData(incoming);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_SCHEMA");
    expect(JSON.stringify(target.exportData())).toBe(before);
  });

  it("reports_current_library_version_in_context", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const context = e.buildMemoryContext({ purpose: "debug" });
    expect(context.ok).toBe(true);
    if (context.ok) expect(context.value.libraryVersion).toBe("0.4.0");
    expect(LIBRARY_VERSION).toBe("0.4.0");
  });

  it("does not leak nested public state and preserves edge identity", () => {
    const source = new EtherMemoriesCore({ userId: "u1" });
    const note = source.addMemory({ content: "graph seed", metadata: { nested: { keep: true } } });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    source.graph.addNode({ id: "custom", type: "custom", data: { nested: { keep: true } } });
    const edge = source.graph.addEdgeWithId("stable-edge", `memory:${note.value.id}`, "custom");
    expect(edge.ok).toBe(true);
    const exported = source.exportData();
    (exported.memoryNotes[0].metadata.nested as { keep: boolean }).keep = false;
    (exported.graph.nodes.find(n => n.id === "custom")!.data.nested as { keep: boolean }).keep = false;
    const stored = source.notes.get(note.value.id);
    expect(stored.ok && stored.value.metadata.nested).toEqual({ keep: true });
    expect(source.graph.getNode("custom")!.data.nested).toEqual({ keep: true });
    const target = new EtherMemoriesCore({ userId: "u1" });
    expect(target.importData(source.exportData()).ok).toBe(true);
    expect(target.graph.getAllEdges()[0].id).toBe("stable-edge");
  });

  it("bounds graph recall and reports the actual path", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const a = e.addMemory({ content: "seed phrase" });
    const b = e.addMemory({ content: "neighbor one" });
    const c = e.addMemory({ content: "neighbor two" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    e.graph.addEdgeWithId("edge-ab", `memory:${a.value.id}`, `memory:${b.value.id}`, "supports");
    e.graph.addEdgeWithId("edge-bc", `memory:${b.value.id}`, `memory:${c.value.id}`, "supports");
    const result = e.queryMemoriesDetailed("seed phrase", { graphRecall: { enabled: true, depth: 2, maxResults: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const neighbor = result.value.find(item => item.memory.id === b.value.id);
      expect(neighbor?.graphEvidence?.path.map(edge => edge.edgeId)).toEqual(["edge-ab"]);
      expect(result.value.filter(item => item.matchedBy.includes("graph_neighbor"))).toHaveLength(1);
    }
  });

  it("rejects malformed imports without mutating existing notes", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    e.addMemory({ content: "keep" });
    const malformed = e.exportData();
    malformed.memoryNotes[0].tags = [42 as unknown as string];
    const result = e.importData(malformed);
    expect(result.ok).toBe(false);
    expect(e.notes.getAll()[0].content).toBe("keep");
  });

  it("preserves_save_load_roundtrip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ether-memories-"));
    const path = join(directory, "snapshot.json");
    try {
      const source = new EtherMemoriesCore({ userId: "u1", displayName: "Roundtrip", storagePath: path });
      source.addMemory({ content: "Persisted note" });
      source.addDiaryEntry({ content: "Persisted diary" });
      expect((await source.save()).ok).toBe(true);

      const target = new EtherMemoriesCore({ userId: "u1", storagePath: path });
      expect((await target.load()).ok).toBe(true);
      expect(target.getSystemState().displayName).toBe("Roundtrip");
      expect(target.notes.getAll()[0].content).toBe("Persisted note");
      expect(target.diary.getAll()[0].content).toBe("Persisted diary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves millisecond timestamps across export-import-export", () => {
    const source = new EtherMemoriesCore({ userId: "u1" });
    const note = source.addMemory({ content: "Precise note", expiresAt: new Date(1_700_000_000_123) });
    const diary = source.addDiaryEntry({ content: "Precise diary" });
    expect(note.ok && diary.ok).toBe(true);
    if (!note.ok || !diary.ok) return;
    const exported = source.exportData();
    exported.identity.createdAt = new Date(1_700_000_000_101);
    exported.identity.lastActive = new Date(1_700_000_000_102);
    exported.memoryNotes[0].createdAt = new Date(1_700_000_000_103);
    exported.memoryNotes[0].updatedAt = new Date(1_700_000_000_104);
    exported.memoryNotes[0].expiresAt = new Date(1_700_000_000_105);
    exported.diary[0].createdAt = new Date(1_700_000_000_106);
    exported.diary[0].updatedAt = new Date(1_700_000_000_107);
    const target = new EtherMemoriesCore({ userId: "u1" });
    expect(target.importData(JSON.parse(JSON.stringify(exported))).ok).toBe(true);
    expect(JSON.stringify(target.exportData())).toBe(JSON.stringify(exported));
  });

  it("keeps filesystem save-load-save timestamps byte-stable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ether-memories-"));
    const path = join(directory, "snapshot.json");
    try {
      const source = new EtherMemoriesCore({ userId: "u1", storagePath: path });
      source.addMemory({ content: "Stable timestamps", expiresAt: new Date(1_700_000_000_123) });
      source.addDiaryEntry({ content: "Stable diary" });
      expect((await source.save()).ok).toBe(true);
      const first = await readFile(path, "utf8");
      const loaded = new EtherMemoriesCore({ userId: "u1", storagePath: path });
      expect((await loaded.load()).ok).toBe(true);
      expect((await loaded.save()).ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
