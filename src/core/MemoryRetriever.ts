import type {
  DiaryEntry, GraphEvidence, MemoryNote, RetrievalEvidence, RetrievalMatch, RetrievalMatchClass
} from "../types/index.js";
import type { MindGraphManager } from "./MindGraph.js";
import { LexicalIndex } from "./LexicalIndex.js";
import { codeUnitCompare, normalizePhrase, tokenize } from "./Tokenizer.js";

export interface QueryOptions {
  explicitIds?: string[];
  asOf?: Date | number;
  includeCandidate?: boolean;
  includeArchived?: boolean;
  includeExpired?: boolean;
  tags?: string[];
  categories?: string[];
  pinnedOnly?: boolean;
  limit?: number;
  graphRecall?: { enabled: boolean; depth?: 0 | 1 | 2; maxResults?: number; direction?: "in" | "out" | "both"; relationAllowlist?: string[] };
}

export const RETRIEVAL_CLASS_WEIGHTS: Readonly<Record<RetrievalMatchClass, number>> = {
  explicit_id: 1,
  exact_phrase: 0.9,
  full_token_match: 0.7,
  partial_token_match: 0.5,
  tag_metadata_match: 0.3,
  graph_only: 0.2
};

const CLASS_RANK: Readonly<Record<RetrievalMatchClass, number>> = {
  explicit_id: 6,
  exact_phrase: 5,
  full_token_match: 4,
  partial_token_match: 3,
  tag_metadata_match: 2,
  graph_only: 1
};

export class MemoryRetriever {
  private readonly index: LexicalIndex;

  constructor(
    private readonly notes: () => MemoryNote[],
    private readonly diary: () => DiaryEntry[],
    private readonly graph?: MindGraphManager,
    notesRevision?: () => number,
    diaryRevision?: () => number
  ) {
    this.index = new LexicalIndex(
      notes,
      diary,
      notesRevision ?? (() => 0),
      diaryRevision ?? (() => 0)
    );
  }

  rebuildIndex(): void { this.index.rebuild(); }

  query(text: string, options: QueryOptions = {}): RetrievalMatch[] {
    const phrase = normalizePhrase(text);
    const queryTokens = tokenize(text);
    const asOf = resolveAsOf(options.asOf);
    if (!phrase && !(options.explicitIds?.length)) return [];
    this.index.ensureFresh();

    const notesById = new Map(this.notes().map(note => [note.id, note]));
    const candidates = new Map<string, RetrievalMatch>();
    for (const id of options.explicitIds ?? []) {
      const note = notesById.get(id);
      if (note && passes(note, options, asOf)) {
        candidates.set(id, makeMatch(note, "explicit_id", 0, ["explicit_id"], undefined, {
          matchedTokens: [],
          tags: [],
          metadataFields: [],
          explicitId: true
        }));
      }
    }

    for (const note of notesById.values()) {
      if (!passes(note, options, asOf)) continue;
      const document = this.index.getNote(note.id);
      if (!document || !queryTokens.length) continue;
      const lexical = classifyLexical(document.tokens, document.tokenSet, document.tagTokens, document.metadataTokens, queryTokens);
      if (!lexical) continue;
      const candidate = makeMatch(note, lexical.matchClass, lexical.score, lexical.matchedBy, undefined, {
        exactPhrase: lexical.exactPhrase,
        matchedTokens: lexical.matchedTokens,
        tags: lexical.tags,
        category: note.category,
        metadataFields: lexical.metadataFields,
        explicitId: false
      });
      const existing = candidates.get(note.id);
      if (!existing || compareMatches(candidate, existing) < 0) candidates.set(note.id, candidate);
    }

    const direct = [...candidates.values()];
    const directIds = new Set(direct.map(match => match.memory.id));
    if (options.graphRecall?.enabled && this.graph) {
      const cfg = options.graphRecall;
      const depth = Math.min(cfg.depth ?? 1, 2) as 0 | 1 | 2;
      const seeds = [...direct].sort(compareMatches).slice(0, options.limit ?? 50);
      for (const seed of seeds) {
        const slice = this.graph.getRecallNeighbors(`memory:${seed.memory.id}`, depth, cfg.maxResults ?? 8, cfg.relationAllowlist, cfg.direction ?? "both");
        for (const node of slice.nodes) {
          const id = node.id.startsWith("memory:") ? node.id.slice(7) : "";
          if (!id || directIds.has(id)) continue;
          const note = notesById.get(id);
          if (!note || !passes(note, options, asOf)) continue;
          const path = slice.paths.get(node.id);
          if (!path || path.length > depth || path.length === 0) continue;
          const graphEvidence: GraphEvidence = {
            seedMemoryId: seed.memory.id,
            depth: path.length as 1 | 2,
            path: evidencePath(seed.memory.id, path, cfg.direction ?? "both")
          };
          const candidate = makeMatch(
            note,
            "graph_only",
            seed.score * (path.length === 1 ? 0.5 : 0.25),
            ["graph_neighbor"],
            graphEvidence,
            {
              matchedTokens: [],
              tags: [],
              metadataFields: [],
              explicitId: false,
              graph: {
                seedMemoryId: seed.memory.id,
                depth: graphEvidence.depth,
                edgeIds: path.map(edge => edge.id),
                path: graphEvidence.path
              }
            },
            seed.score * (path.length === 1 ? 0.5 : 0.25)
          );
          const existing = candidates.get(id);
          if (!existing || compareMatches(candidate, existing) < 0) candidates.set(id, candidate);
        }
      }
    }

    return [...candidates.values()]
      .sort(compareMatches)
      .slice(0, options.limit ?? 50);
  }

  searchDiary(text: string, limit = 20, _asOf?: Date | number): DiaryEntry[] {
    return this.searchDiaryDetailed(text, limit, _asOf).map(r => r.entry);
  }

  searchDiaryDetailed(text: string, limit = 20, _asOf?: Date | number): Array<{ entry: DiaryEntry; matchedBy: Array<"exact_phrase" | "token"> }> {
    const queryTokens = tokenize(text);
    if (!queryTokens.length) return [];
    this.index.ensureFresh();
    const entries = new Map(this.diary().map(entry => [entry.id, entry]));
    return this.index.allDiary()
      .map(document => {
        const entry = entries.get(document.id);
        if (!entry) return undefined;
        const isExact = containsPhrase(document.tokens, queryTokens);
        const isToken = queryTokens.some(token => document.tokenSet.has(token));
        if (!isExact && !isToken) return undefined;
        return { entry, matchedBy: (isExact ? ["exact_phrase", "token"] : ["token"]) as Array<"exact_phrase" | "token"> };
      })
      .filter((r): r is { entry: DiaryEntry; matchedBy: Array<"exact_phrase" | "token"> } => !!r)
      .sort((a, b) => compareDates(b.entry.updatedAt, a.entry.updatedAt) || codeUnitCompare(a.entry.id, b.entry.id))
      .slice(0, limit);
  }
}

const classifyLexical = (
  tokens: string[],
  tokenSet: Set<string>,
  tagTokens: Set<string>,
  metadataTokens: Set<string>,
  queryTokens: string[]
): {
  matchClass: RetrievalMatchClass;
  score: number;
  matchedBy: RetrievalMatch["matchedBy"];
  exactPhrase?: string;
  matchedTokens: string[];
  tags: string[];
  metadataFields: string[];
} | undefined => {
  const hits = queryTokens.filter(token => tokenSet.has(token)).length;
  const matchedTokens = queryTokens.filter(token => tokenSet.has(token));
  const tagHits = queryTokens.filter(token => tagTokens.has(token)).length;
  const metadataHits = queryTokens.filter(token => metadataTokens.has(token)).length;
  if (containsPhrase(tokens, queryTokens)) {
    return { matchClass: "exact_phrase", score: RETRIEVAL_CLASS_WEIGHTS.exact_phrase + hits * 0.02, exactPhrase: queryTokens.join(" "), matchedTokens, tags: queryTokens.filter(token => tagTokens.has(token)), metadataFields: queryTokens.filter(token => metadataTokens.has(token)), matchedBy: ["exact_phrase", "token"] };
  }
  if (hits === queryTokens.length) {
    return { matchClass: "full_token_match", score: RETRIEVAL_CLASS_WEIGHTS.full_token_match + hits * 0.02, matchedTokens, tags: queryTokens.filter(token => tagTokens.has(token)), metadataFields: queryTokens.filter(token => metadataTokens.has(token)), matchedBy: ["full_token_match", "token"] };
  }
  if (hits > 0) {
    return { matchClass: "partial_token_match", score: RETRIEVAL_CLASS_WEIGHTS.partial_token_match + hits * 0.02, matchedTokens, tags: queryTokens.filter(token => tagTokens.has(token)), metadataFields: queryTokens.filter(token => metadataTokens.has(token)), matchedBy: ["partial_token_match", "token"] };
  }
  if (tagHits || metadataHits) {
    const matchedBy: RetrievalMatch["matchedBy"] = [];
    if (tagHits) matchedBy.push("tag");
    if (metadataHits) matchedBy.push("metadata");
    return { matchClass: "tag_metadata_match", score: RETRIEVAL_CLASS_WEIGHTS.tag_metadata_match + (tagHits + metadataHits) * 0.02, matchedTokens, tags: queryTokens.filter(token => tagTokens.has(token)), metadataFields: queryTokens.filter(token => metadataTokens.has(token)), matchedBy };
  }
  return undefined;
};

const containsPhrase = (tokens: string[], phraseTokens: string[]): boolean => {
  if (!phraseTokens.length || phraseTokens.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - phraseTokens.length; i++) {
    if (phraseTokens.every((token, offset) => tokens[i + offset] === token)) return true;
  }
  return false;
};

const makeMatch = (
  memory: MemoryNote,
  matchClass: RetrievalMatchClass,
  score: number,
  matchedBy: RetrievalMatch["matchedBy"],
  graphEvidence?: GraphEvidence,
  details: Partial<Omit<RetrievalEvidence, "matchClass" | "score" | "contributions">> = {},
  graphContribution = 0
): RetrievalMatch => ({
  memory,
  matchClass,
  score: score + memory.importance * 0.05 + memory.confidence * 0.025,
  matchedBy,
  evidence: {
    matchClass,
    score: score + memory.importance * 0.05 + memory.confidence * 0.025,
    matchedTokens: details.matchedTokens ?? [],
    tags: details.tags ?? [],
    category: details.category,
    metadataFields: details.metadataFields ?? [],
    explicitId: details.explicitId ?? false,
    exactPhrase: details.exactPhrase,
    graph: details.graph,
    contributions: {
      lexical: score,
      graph: graphContribution,
      importance: memory.importance * 0.05,
      confidence: memory.confidence * 0.025
    }
  },
  graphEvidence
});

const passes = (note: MemoryNote, options: QueryOptions, asOf: number): boolean =>
  (options.includeCandidate || note.status !== "candidate") &&
  (options.includeArchived || note.status !== "archived") &&
  (options.includeExpired || !note.expiresAt || note.expiresAt.getTime() > asOf) &&
  (!options.pinnedOnly || note.pinned) &&
  (!options.tags?.length || options.tags.every(tag => note.tags.includes(tag))) &&
  (!options.categories?.length || (!!note.category && options.categories.includes(note.category)));

const resolveAsOf = (value: Date | number | undefined): number => {
  if (value === undefined) return Date.now();
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) throw new RangeError("asOf must be a valid Date or timestamp.");
  return timestamp;
};

const compareMatches = (a: RetrievalMatch, b: RetrievalMatch): number =>
  CLASS_RANK[b.matchClass] - CLASS_RANK[a.matchClass] ||
  b.score - a.score ||
  compareDates(effectiveTimestamp(b.memory), effectiveTimestamp(a.memory)) ||
  codeUnitCompare(a.memory.id, b.memory.id) ||
  codeUnitCompare(a.graphEvidence?.seedMemoryId ?? "", b.graphEvidence?.seedMemoryId ?? "");

const compareDates = (a: Date, b: Date): number => a.getTime() - b.getTime();
const effectiveTimestamp = (memory: MemoryNote): Date => memory.updatedAt ?? memory.createdAt;

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
