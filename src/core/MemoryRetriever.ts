import type { DiaryEntry, GraphEvidence, MemoryNote, RetrievalMatch } from "../types/index.js";
import type { MindGraphManager } from "./MindGraph.js";

export interface QueryOptions {
  includeCandidate?: boolean;
  includeArchived?: boolean;
  includeExpired?: boolean;
  tags?: string[];
  categories?: string[];
  pinnedOnly?: boolean;
  limit?: number;
  graphRecall?: { enabled: boolean; depth?: 0 | 1 | 2; maxResults?: number; direction?: "in" | "out" | "both"; relationAllowlist?: string[] };
}

export class MemoryRetriever {
  constructor(
    private readonly notes: () => MemoryNote[],
    private readonly diary: () => DiaryEntry[],
    private readonly graph?: MindGraphManager
  ) {}

  query(text: string, options: QueryOptions = {}): RetrievalMatch[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const tokens = new Set(q.split(/\s+/).filter(Boolean));
    const now = Date.now();
    const matches: RetrievalMatch[] = [];

    for (const note of this.notes()) {
      if (!options.includeCandidate && note.status === "candidate") continue;
      if (!options.includeArchived && note.status === "archived") continue;
      if (!options.includeExpired && note.expiresAt && note.expiresAt.getTime() <= now) continue;
      if (options.pinnedOnly && !note.pinned) continue;
      if (options.tags?.length && !options.tags.every(t => note.tags.includes(t))) continue;
      if (options.categories?.length && (!note.category || !options.categories.includes(note.category))) continue;

      const hay = `${note.content} ${note.summary ?? ""}`.toLowerCase();
      const matchedBy: RetrievalMatch["matchedBy"] = [];
      let score = 0;
      if (q && hay.includes(q)) { score += 1; matchedBy.push("exact_phrase"); }
      let tokenHits = 0;
      for (const token of tokens) if (token && hay.includes(token)) tokenHits++;
      if (tokenHits) { score += tokenHits * 0.2; matchedBy.push("token"); }
      if (options.tags?.some(t => note.tags.includes(t))) { score += 0.3; matchedBy.push("tag"); }
      if (options.categories?.some(c => note.category === c)) { score += 0.3; matchedBy.push("category"); }
      if (options.pinnedOnly) score += 0.5;
      score += note.importance * 0.2;
      score += note.confidence * 0.1;
      score += Math.max(0, 0.1 - (now - note.updatedAt.getTime()) / (1000 * 60 * 60 * 24 * 365));
      if (matchedBy.length) matches.push({ memory: note, score, matchedBy });
    }

    const directIds = new Set(matches.map(m => m.memory.id));
    if (options.graphRecall?.enabled && this.graph) {
      const cfg = options.graphRecall, depth = Math.min(cfg.depth ?? 1, 2) as 0 | 1 | 2;
      const seeds = [...matches].sort(compareMatches).slice(0, options.limit ?? 50);
      const graphMatches = new Map<string, RetrievalMatch>();
      for (const seed of seeds) {
        const slice = this.graph.getRecallNeighbors(`memory:${seed.memory.id}`, depth, cfg.maxResults ?? 8, cfg.relationAllowlist, cfg.direction ?? "both");
        for (const node of slice.nodes) {
          const id = node.id.startsWith("memory:") ? node.id.slice(7) : "";
          if (!id || directIds.has(id)) continue;
          const note = this.notes().find(n => n.id === id);
          if (!note || !passes(note, options, now)) continue;
          const path = slice.paths.get(node.id);
          if (!path || path.length > depth || path.length === 0) continue;
          const evidence: GraphEvidence = { seedMemoryId: seed.memory.id, depth: path.length as 1 | 2, path: evidencePath(seed.memory.id, path, cfg.direction ?? "both") };
          const candidate: RetrievalMatch = { memory: note, score: seed.score * (path.length === 1 ? 0.5 : 0.25), matchedBy: ["graph_neighbor"], graphEvidence: evidence };
          const existing = graphMatches.get(id);
          if (!existing || compareGraphCandidates(candidate, existing) < 0) graphMatches.set(id, candidate);
        }
      }
      const neighbors = [...graphMatches.values()].sort(compareMatches).slice(0, cfg.maxResults ?? 8);
      matches.push(...neighbors);
    }
    return matches.sort(compareMatches).slice(0, options.limit ?? 50);
  }

  searchDiary(text: string, limit = 20): DiaryEntry[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return this.diary().filter(e => `${e.content} ${e.tags.join(" ")}`.toLowerCase().includes(q)).slice(0, limit);
  }
}

const passes = (note: MemoryNote, options: QueryOptions, now: number): boolean =>
  (options.includeCandidate || note.status !== "candidate") &&
  (options.includeArchived || note.status !== "archived") &&
  (options.includeExpired || !note.expiresAt || note.expiresAt.getTime() > now) &&
  (!options.pinnedOnly || note.pinned) &&
  (!options.tags?.length || options.tags.every(t => note.tags.includes(t))) &&
  (!options.categories?.length || (!!note.category && options.categories.includes(note.category)));

const findPath = (
  seed: string,
  target: string,
  edges: Array<{ id: string; source: string; target: string; relationship: string }>,
  direction: "in" | "out" | "both"
): Array<{ id: string; source: string; target: string; relationship: string }> | undefined => {
  const queue: Array<{ node: string; path: typeof edges }> = [{ node: seed, path: [] }];
  const seen = new Set([seed]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.node === target) return current.path;
    for (const edge of edges) {
      const next = direction === "out" && edge.source === current.node ? edge.target
        : direction === "in" && edge.target === current.node ? edge.source
        : direction === "both" && edge.source === current.node ? edge.target
        : direction === "both" && edge.target === current.node ? edge.source
        : undefined;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push({ node: next, path: [...current.path, edge] });
      }
    }
  }
  return undefined;
};

const evidencePath = (
  seedId: string,
  path: Array<{ id: string; source: string; target: string; relationship: string }>,
  direction: "in" | "out" | "both"
) => {
  let current = `memory:${seedId}`;
  return path.map(edge => {
    const outgoing = edge.source === current;
    const item = {
      edgeId: edge.id,
      relationship: edge.relationship,
      direction: outgoing ? "out" as const : "in" as const,
      from: edge.source,
      to: edge.target
    };

    current = direction === "in" ? edge.source : outgoing ? edge.target : edge.source;
    return item;
  });
};

const compareMatches = (a: RetrievalMatch, b: RetrievalMatch): number => {
  const ag = a.matchedBy.includes("graph_neighbor") ? 1 : 0;
  const bg = b.matchedBy.includes("graph_neighbor") ? 1 : 0;
  return ag - bg || b.score - a.score ||
    b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime() ||
    a.memory.id.localeCompare(b.memory.id) ||
    (a.graphEvidence?.seedMemoryId ?? "").localeCompare(b.graphEvidence?.seedMemoryId ?? "");
};

const compareGraphCandidates = (a: RetrievalMatch, b: RetrievalMatch): number =>
  b.score - a.score ||
  (a.graphEvidence?.depth ?? 0) - (b.graphEvidence?.depth ?? 0) ||
  (a.graphEvidence?.seedMemoryId ?? "").localeCompare(b.graphEvidence?.seedMemoryId ?? "") ||
  a.memory.id.localeCompare(b.memory.id);
