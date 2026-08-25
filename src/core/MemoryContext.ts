import type {
  BuildMemoryContextInput, ContextCitation, ContextDiary, ContextGraphSlice,
  ContextNote, MemoryContext, MemoryContextBudget, MemoryContextQuery,
  MemoryNote, RetrievalMatch, RetrievalTrace, TruncationReport
} from "../types/index.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { MindGraphManager } from "./MindGraph.js";

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
      ? this.retriever.query(q.text, { ...q.filters, limit: Math.max(budget.maxNotes * 4, 50) })
      : [];
    const explicit = q.noteIds ?? [];
    const selected = new Map<string, RetrievalMatch>();
    for (const id of explicit) {
      const n = this.getNotes().find(x => x.id === id);
      if (n) selected.set(id, { memory: n, score: 0, matchedBy: ["explicit_id"] });
    }
    for (const m of noteMatches) if (!selected.has(m.memory.id)) selected.set(m.memory.id, m);

    const notes: ContextNote[] = [...selected.values()].slice(0, budget.maxNotes).map(m => ({
      note: m.memory,
      score: m.score,
      matchedBy: m.matchedBy,
      cite: citation("note", m.memory.id)
    } satisfies ContextNote));

    const diaryIds = q.diaryIds ?? [];
    const diaries: ContextDiary[] = diaryIds
      .map(id => this.getDiary().find(x => x.id === id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .slice(0, budget.maxDiary)
      .map(entry => ({ entry, matchedBy: ["explicit_id"], cite: citation("diary", entry.id) } satisfies ContextDiary));

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
      const slice = this.graph.getNeighbors(seed, depth, q.graph?.relationAllowlist);
      for (const n of slice.nodes) nodeMap.set(n.id, n);
      for (const e of slice.edges) edgeMap.set(e.id, e);
    }
    const nodes = [...nodeMap.values()].slice(0, budget.maxNodes);
    const edges = [...edgeMap.values()].slice(0, budget.maxEdges);
    const graph: ContextGraphSlice = {
      nodes, edges,
      policy: seedNodes.length ? "neighborhood" : "none",
      depth
    };

    let usedChars = 0;
    if (budget.maxChars !== undefined) {
      for (const item of notes) {
        const remaining = Math.max(0, budget.maxChars - usedChars);
        if (item.note.content.length > remaining) {
          item.excerpt = remaining > 0 ? item.note.content.slice(0, Math.max(0, remaining - 3)) + "..." : "";
          usedChars += item.excerpt.length;
        } else {
          usedChars += item.note.content.length;
        }
      }
      for (const item of diaries) {
        const remaining = Math.max(0, budget.maxChars - usedChars);
        if (item.entry.content.length > remaining) {
          item.excerpt = remaining > 0 ? item.entry.content.slice(0, Math.max(0, remaining - 3)) + "..." : "";
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

    const rawTextLength = notes.reduce((s, n) => s + n.note.content.length, 0)
      + diaries.reduce((s, d) => s + d.entry.content.length, 0);
    const truncation: TruncationReport = {
      notesOmitted: Math.max(0, selected.size - notes.length),
      diaryOmitted: Math.max(0, diaryIds.length - diaries.length),
      nodesOmitted: Math.max(0, nodeMap.size - nodes.length),
      edgesOmitted: Math.max(0, edgeMap.size - edges.length),
      charsOmitted: 0,
      hitBudget: selected.size > notes.length || diaryIds.length > diaries.length || nodeMap.size > nodes.length || edgeMap.size > edges.length
    };
    if (budget.maxChars !== undefined && rawTextLength > budget.maxChars) {
      truncation.hitBudget = true;
      truncation.charsOmitted = rawTextLength - Math.min(rawTextLength, budget.maxChars);
    }

    return {
      schemaVersion: "ether.memory_context.v1",
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
