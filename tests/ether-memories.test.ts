import { describe, expect, it } from "vitest";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { toAgentToolResult } from "../src/adapters/agentTool.js";
import { toRlmEnv } from "../src/adapters/rlmEnv.js";

describe("Ether Memories v0.3.0", () => {
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
});
