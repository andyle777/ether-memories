import type { DiaryEntry, MemoryNote, RetrievalMatch } from "../types/index.js";
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
      const seeds = matches.slice(0, options.limit ?? 50);
      for (const seed of seeds) {
        if (matches.filter(m => m.matchedBy.includes("graph_neighbor")).length >= (cfg.maxResults ?? 8)) break;
        const slice = this.graph.getNeighbors(`memory:${seed.memory.id}`, depth, cfg.relationAllowlist, cfg.direction ?? "both");
        for (const node of slice.nodes) {
          const id = node.id.startsWith("memory:") ? node.id.slice(7) : "";
          if (!id || directIds.has(id) || matches.some(m => m.memory.id === id)) continue;
          const note = this.notes().find(n => n.id === id);
          if (!note || !passes(note, options, now)) continue;
          const path = findPath(`memory:${seed.memory.id}`, node.id, slice.edges, cfg.direction ?? "both");
          matches.push({
            memory: note, score: seed.score * (depth === 2 ? 0.25 : 0.5), matchedBy: ["graph_neighbor"],
            graphEvidence: path ? {
              seedMemoryId: seed.memory.id, depth: path.length as 1 | 2,
              path: evidencePath(seed.memory.id, path, cfg.direction ?? "both")
            } : undefined
          });
          if (matches.filter(m => m.matchedBy.includes("graph_neighbor")).length >= (cfg.maxResults ?? 8)) break;
        }
      }
    }
    return matches.sort((a, b) => {
      const at = a.matchedBy.includes("graph_neighbor") ? 1 : 0;
      const bt = b.matchedBy.includes("graph_neighbor") ? 1 : 0;
      return at - bt || b.score - a.score || b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime();
    }).slice(0, options.limit ?? 50);
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
