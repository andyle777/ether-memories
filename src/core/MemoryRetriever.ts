import type { DiaryEntry, MemoryNote, RetrievalMatch } from "../types/index.js";

export interface QueryOptions {
  includeCandidate?: boolean;
  includeArchived?: boolean;
  includeExpired?: boolean;
  tags?: string[];
  categories?: string[];
  pinnedOnly?: boolean;
  limit?: number;
}

export class MemoryRetriever {
  constructor(
    private readonly notes: () => MemoryNote[],
    private readonly diary: () => DiaryEntry[]
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
      if (options.pinnedOnly) { score += 0.5; matchedBy.push("pinned"); }
      score += note.importance * 0.2;
      score += note.confidence * 0.1;
      score += Math.max(0, 0.1 - (now - note.updatedAt.getTime()) / (1000 * 60 * 60 * 24 * 365));
      if (matchedBy.length) matches.push({ memory: note, score, matchedBy });
    }

    return matches.sort((a, b) => b.score - a.score || b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime()).slice(0, options.limit ?? 50);
  }

  searchDiary(text: string, limit = 20): DiaryEntry[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return this.diary().filter(e => `${e.content} ${e.tags.join(" ")}`.toLowerCase().includes(q)).slice(0, limit);
  }
}
