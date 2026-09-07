import type {
  BuildMemoryContextInput, ContextCitation, ContextDiary, ContextGraphSlice,
  ContextNote, MemoryContext, MemoryContextBudget, MemoryContextQuery,
  MemoryNote, RetrievalMatch, RetrievalTrace, TruncationReport
} from "../types/index.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { MindGraphManager } from "./MindGraph.js";
import { MEMORY_CONTEXT_SCHEMA_VERSION } from "../version.js";

export const DEFAULT_BUDGET: MemoryContextBudget = {
  maxNotes: 12, maxDiary: 4, maxNodes: 24, maxEdges: 32, maxChars: 12000
};

export class MemoryContextBuilder {
  constructor(
    private readonly libraryVersion: string,
    private readonly userId: string,
    private readonly displayName: string | undefined,
    private readonly retriever: MemoryRetriever,
    private readonly graph: MindGraphManager,
    private readonly getNotes: () => MemoryNote[],
    private readonly getDiary: () => import("../types/index.js").DiaryEntry[]
  ) {}

  build(input: BuildMemoryContextInput): MemoryContext {
    const q: MemoryContextQuery = {
      ...(input.query ?? {}),
      budget: { ...DEFAULT_BUDGET, ...(input.query?.budget ?? {}) }
    };
    const budget = q.budget;
    const noteMatches: RetrievalMatch[] = q.text
      ? this.retriever.query(q.text, {
        ...q.filters, limit: Math.max(budget.maxNotes * 4, 50),
        graphRecall: q.graph?.enabled ? {
          enabled: true, depth: q.graph.neighborhoodDepth ?? 1, direction: q.graph.direction ?? "both",
          maxResults: q.graph.maxResults ?? 8, relationAllowlist: q.graph.relationAllowlist
        } : undefined
      })
      : [];
    const explicit = q.noteIds ?? [];
    const selected = new Map<string, RetrievalMatch>();
    for (const id of explicit) {
      const n = this.getNotes().find(x => x.id === id);
      if (n) selected.set(id, { memory: n, score: 0, matchedBy: ["explicit_id"] });
    }
    for (const m of noteMatches) if (!selected.has(m.memory.id)) selected.set(m.memory.id, m);

    const notes: ContextNote[] = [...selected.values()].slice(0, budget.maxNotes).map(m => ({
      note: cloneNote(m.memory),
      score: m.score,
      matchedBy: m.matchedBy,
      cite: citation("note", m.memory.id)
    } satisfies ContextNote));

    const diaryIds = q.diaryIds ?? [];
    const selectedDiary = new Map<string, ContextDiary>();
    for (const id of diaryIds) {
      const entry = this.getDiary().find(x => x.id === id);
      if (entry)       selectedDiary.set(id, { entry: cloneDiary(entry), matchedBy: ["explicit_id"], cite: citation("diary", entry.id) });
    }
    if (q.text?.trim()) {
      for (const entry of this.retriever.searchDiary(q.text, Math.max(budget.maxDiary * 4, 20))) {
        if (!selectedDiary.has(entry.id)) {
          selectedDiary.set(entry.id, { entry: cloneDiary(entry), matchedBy: ["exact_phrase"], cite: citation("diary", entry.id) });
        }
      }
    }
    const diaries = [...selectedDiary.values()].slice(0, budget.maxDiary);

    const depth = q.graph?.neighborhoodDepth ?? 1;
    const seedNodes = [
      ...notes.map(n => `memory:${n.note.id}`),
      ...diaries.map(d => `diary:${d.entry.id}`)
    ];
    const nodeMap = new Map<string, import("../types/index.js").MindGraphNode>();
    const edgeMap = new Map<string, import("../types/index.js").MindGraphEdge>();
    for (const seed of seedNodes) {
      const root = this.graph.getNode(seed);
      if (root) nodeMap.set(root.id, root);
      const slice = this.graph.getNeighbors(seed, depth, q.graph?.relationAllowlist, q.graph?.direction ?? "both");
      for (const n of slice.nodes) nodeMap.set(n.id, n);
      for (const e of slice.edges) edgeMap.set(e.id, e);
    }
    const nodes = [...nodeMap.values()].slice(0, budget.maxNodes);
    const includedNodeIds = new Set(nodes.map(n => n.id));
    const edges = [...edgeMap.values()]
      .filter(edge => includedNodeIds.has(edge.source) && includedNodeIds.has(edge.target))
      .slice(0, budget.maxEdges);
    const graph: ContextGraphSlice = {
      nodes, edges,
      policy: seedNodes.length ? "neighborhood" : "none",
      depth
    };

    const originalNoteChars = new Map(notes.map(item => [item.note.id, item.note.content.length]));
    const originalDiaryChars = new Map(diaries.map(item => [item.entry.id, item.entry.content.length]));
    let usedChars = 0;
    if (budget.maxChars !== undefined) {
      for (const item of notes) {
        const remaining = Math.max(0, budget.maxChars - usedChars);
        if (item.note.content.length > remaining) {
          item.excerpt = remaining >= 3 ? item.note.content.slice(0, remaining - 3) + "..." : item.note.content.slice(0, remaining);
          item.note = { ...item.note, content: item.excerpt };
          usedChars += item.excerpt.length;
        } else {
          usedChars += item.note.content.length;
        }
      }
      for (const item of diaries) {
        const remaining = Math.max(0, budget.maxChars - usedChars);
        if (item.entry.content.length > remaining) {
          item.excerpt = remaining >= 3 ? item.entry.content.slice(0, remaining - 3) + "..." : item.entry.content.slice(0, remaining);
          item.entry = { ...item.entry, content: item.excerpt };
          usedChars += item.excerpt.length;
        } else {
          usedChars += item.entry.content.length;
        }
      }
    }

    const citations: ContextCitation[] = [
      ...notes.map(n => n.cite),
      ...diaries.map(d => d.cite),
      ...nodes.map(n => citation("node", n.id)),
      ...edges.map(e => citation("edge", e.id))
    ];

    const conflictFlags: RetrievalTrace["conflictFlags"] = [];
    const byClaim = new Map<string, MemoryNote[]>();
    for (const n of notes.map(x => x.note)) {
      const claimKey = typeof n.metadata.claimKey === "string" ? n.metadata.claimKey : undefined;
      if (!claimKey) continue;
      const arr = byClaim.get(claimKey) ?? [];
      arr.push(n); byClaim.set(claimKey, arr);
    }
    for (const [claimKey, arr] of byClaim) {
      if (arr.length > 1) conflictFlags.push({ claimKey, noteIds: arr.map(x => x.id), reason: "duplicate_claim_key" });
    }

    const retrieval: RetrievalTrace = {
      mode: q.noteIds?.length && q.text ? "hybrid" : q.noteIds?.length ? "ids" : q.text ? "query" : "empty",
      matchedNoteCount: noteMatches.length,
      matchedDiaryCount: diaries.length,
      filtersApplied: Object.entries(q.filters ?? {}).filter(([,v]) => v !== undefined).map(([k]) => k),
      ranking: "deterministic_v1",
      conflictFlags
    };

    // This counts only text truncated from selected context items, not text from
    // items omitted by another budget. It is therefore precise about its scope.
    const charsOmitted = notes.reduce((s, n) => s + (originalNoteChars.get(n.note.id) ?? n.note.content.length) - n.note.content.length, 0)
      + diaries.reduce((s, d) => s + (originalDiaryChars.get(d.entry.id) ?? d.entry.content.length) - d.entry.content.length, 0);
    const truncation: TruncationReport = {
      notesOmitted: Math.max(0, selected.size - notes.length),
      diaryOmitted: Math.max(0, selectedDiary.size - diaries.length),
      nodesOmitted: Math.max(0, nodeMap.size - nodes.length),
      edgesOmitted: Math.max(0, edgeMap.size - edges.length),
      charsOmitted,
      hitBudget: selected.size > notes.length || selectedDiary.size > diaries.length || nodeMap.size > nodes.length || edgeMap.size > edges.length || charsOmitted > 0
    };


    return {
      schemaVersion: MEMORY_CONTEXT_SCHEMA_VERSION,
      libraryVersion: this.libraryVersion,
      purpose: input.purpose,
      producedAt: new Date().toISOString(),
      userId: this.userId,
      identity: { userId: this.userId, displayName: this.displayName },
      query: q,
      retrieval,
      notes,
      diary: diaries,
      graph,
      citations,
      truncation
    };
  }
}

const citation = (kind: ContextCitation["kind"], id: string): ContextCitation => ({
  ref: `${kind}:${id}`, kind, id
});
const cloneNote = (n: MemoryNote): MemoryNote => ({ ...n, tags: [...n.tags], provenance: cloneValue(n.provenance), metadata: cloneValue(n.metadata), createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt), expiresAt: n.expiresAt ? new Date(n.expiresAt) : undefined });
const cloneDiary = (d: import("../types/index.js").DiaryEntry): import("../types/index.js").DiaryEntry => ({ ...d, tags: [...d.tags], metadata: cloneValue(d.metadata), createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt) });
const cloneValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cloneValue(v)])) as T;
};
