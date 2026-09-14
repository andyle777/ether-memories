import type { MemoryNote, MemoryStatus, ProvenanceKind } from "../types/index.js";
import type { AddNoteInput } from "./MemoryNotes.js";
import { codeUnitCompare, normalizePhrase, tokenize } from "./Tokenizer.js";

/**
 * Deterministic Condensation v2.
 *
 * Condensation is a processing layer, not a fourth memory foundation. It never
 * requires an LLM, model provider, API call, embedding, or probabilistic
 * inference. The analysis phase is a pure function of (input text, config) and
 * produces an identical {@link CondensationAnalysis} for identical inputs. The
 * commit phase turns an analysis into a candidate note and may legitimately
 * produce a non-deterministic memory ID and creation timestamp; only the
 * analysis result is required to be reproducible.
 */

export interface CondensationConfig {
  /** Maximum number of extracted key facts. Default: 5. */
  maxFacts?: number;
  /** Minimum sentence char length to qualify as a key fact. Default: 8. */
  minFactLength?: number;
  /** Maximum sentence char length to qualify as a key fact. Default: 240. */
  maxFactLength?: number;
  /** Maximum summary length before deterministic truncation. Default: 200. */
  summaryLength?: number;
  /** Maximum number of derived tags. Default: 8. */
  maxTags?: number;
}

export interface CondensationConfidenceContribution {
  /** Name of the deterministic rule that fired. */
  rule: string;
  /** Non-negative contribution added to the confidence sum. */
  contribution: number;
}

export interface CondensationAnalysis {
  /** Sentences selected as key facts, in input order, deduplicated by normalized form. */
  keyFacts: string[];
  /** Deterministic truncated representation of the input text. */
  summary: string;
  /** Derived tags (canonical tokenizer, code-unit order, capped). */
  tags: string[];
  /** Inferred category from the documented rule table, or undefined when no rule matches. */
  category?: string;
  /** Confidence in [0, 1], the clamped sum of {@link confidenceContributions}. */
  confidence: number;
  /** Inspectable per-rule contributions that sum to the (pre-clamp) confidence. */
  confidenceContributions: CondensationConfidenceContribution[];
  /** Existing provenance classification: "condensed" or "diary_extract". */
  provenanceKind: ProvenanceKind;
  /** Source Diary entry identifier, preserved only for Diary-derived condensation. */
  parentDiaryId?: string;
  /** Always "candidate"; condensed memories never become active automatically. */
  lifecycleStatus: MemoryStatus;
}

/**
 * Bumped when the deterministic rule set changes so committed analyses remain
 * self-describing across releases.
 */
export const CONDENSATION_RULE_VERSION = 2;

interface ResolvedConfig {
  maxFacts: number;
  minFactLength: number;
  maxFactLength: number;
  summaryLength: number;
  maxTags: number;
}

const DEFAULTS: ResolvedConfig = {
  maxFacts: 5,
  minFactLength: 8,
  maxFactLength: 240,
  summaryLength: 200,
  maxTags: 8,
};

/**
 * Category inference uses a fixed, ordered keyword table. The first rule whose
 * keyword set intersects the input token set wins. Categories are limited to the
 * documented set below; if no rule matches, no category is assigned. No category
 * is ever inferred probabilistically.
 */
const CATEGORY_RULES: ReadonlyArray<{ category: string; keywords: ReadonlyArray<string> }> = [
  { category: "project", keywords: ["project", "build", "built", "shipped", "release", "version", "code", "library", "app", "deploy", "feature", "refactor"] },
  { category: "preference", keywords: ["prefer", "like", "favourite", "favorite", "want", "love", "hate", "dislike", "wish", "rather"] },
  { category: "task", keywords: ["task", "todo", "plan", "need", "must", "schedule", "deadline", "assign", "follow"] },
  { category: "learning", keywords: ["learned", "learnt", "study", "studied", "read", "tutorial", "course", "lesson", "research", "figured"] },
  { category: "event", keywords: ["meeting", "met", "call", "happened", "event", "attended", "visited", "trip"] },
];

const resolveConfig = (config?: CondensationConfig): ResolvedConfig => ({
  maxFacts: config?.maxFacts ?? DEFAULTS.maxFacts,
  minFactLength: config?.minFactLength ?? DEFAULTS.minFactLength,
  maxFactLength: config?.maxFactLength ?? DEFAULTS.maxFactLength,
  summaryLength: config?.summaryLength ?? DEFAULTS.summaryLength,
  maxTags: config?.maxTags ?? DEFAULTS.maxTags,
});

/** Split text into sentences on `[.!?]` followed by whitespace, or on newlines. */
const splitSentences = (text: string): string[] =>
  text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/u)
    .map(part => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** Conservative deterministic key-fact extraction. */
const extractKeyFacts = (text: string, cfg: ResolvedConfig): string[] => {
  const sentences = splitSentences(text);
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length < cfg.minFactLength || sentence.length > cfg.maxFactLength) continue;
    const key = normalizePhrase(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    facts.push(sentence);
    if (facts.length >= cfg.maxFacts) break;
  }
  return facts;
};

/** Tags derived from the canonical v0.5 tokenizer, deduplicated in code-unit order. */
const deriveTags = (text: string, maxTags: number): string[] => {
  const seen = new Set<string>();
  for (const token of tokenize(text)) seen.add(token);
  return [...seen].sort(codeUnitCompare).slice(0, maxTags);
};

/** First documented category rule whose keywords intersect the input token set. */
const inferCategory = (text: string): string | undefined => {
  const tokenSet = new Set(tokenize(text));
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(keyword => tokenSet.has(keyword))) return rule.category;
  }
  return undefined;
};

/** Deterministic truncated summary preserving the existing "..." truncation shape. */
const buildSummary = (text: string, summaryLength: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= summaryLength) return trimmed;
  const cap = Math.max(0, summaryLength - 3);
  return `${trimmed.slice(0, cap)}...`;
};

/** Confidence is solely the clamped sum of inspectable, deterministic rule contributions. */
const computeConfidence = (input: {
  keyFacts: string[];
  category?: string;
  tags: string[];
  parentDiaryId?: string;
  maxFacts: number;
}): { confidence: number; confidenceContributions: CondensationConfidenceContribution[] } => {
  const confidenceContributions: CondensationConfidenceContribution[] = [
    { rule: "base_condensed", contribution: 0.4 },
    { rule: "has_key_facts", contribution: input.keyFacts.length > 0 ? 0.1 : 0 },
    { rule: "key_fact_count", contribution: 0.02 * Math.min(input.keyFacts.length, input.maxFacts) },
    { rule: "has_category", contribution: input.category ? 0.1 : 0 },
    { rule: "has_tags", contribution: input.tags.length > 0 ? 0.05 : 0 },
    { rule: "diary_linked", contribution: input.parentDiaryId ? 0.1 : 0 },
  ];
  const sum = confidenceContributions.reduce((total, item) => total + item.contribution, 0);
  return { confidence: clamp(sum), confidenceContributions };
};

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

export class CondensationEngine {
  constructor(private readonly createCandidate: (input: AddNoteInput) => MemoryNote | undefined) {}

  /**
   * Deterministic, side-effect free analysis phase. Given the same input text
   * and configuration, the returned analysis is deeply equal. Returns undefined
   * for empty/whitespace input.
   */
  analyze(input: string, parentDiaryId?: string, config?: CondensationConfig): CondensationAnalysis | undefined {
    if (!input?.trim()) return undefined;
    const cfg = resolveConfig(config);
    const keyFacts = extractKeyFacts(input, cfg);
    const summary = buildSummary(input, cfg.summaryLength);
    const tags = deriveTags(input, cfg.maxTags);
    const category = inferCategory(input);
    const provenanceKind: ProvenanceKind = parentDiaryId ? "diary_extract" : "condensed";
    const { confidence, confidenceContributions } = computeConfidence({
      keyFacts, category, tags, parentDiaryId, maxFacts: cfg.maxFacts
    });
    return {
      keyFacts,
      summary,
      tags,
      category,
      confidence,
      confidenceContributions,
      provenanceKind,
      parentDiaryId,
      lifecycleStatus: "candidate",
    };
  }

  /**
   * Commit phase: materializes a deterministic analysis into a candidate note.
   * This phase may produce a non-deterministic memory ID and creation timestamp;
   * only the analysis result is required to be reproducible.
   */
  commitAnalysis(analysis: CondensationAnalysis): MemoryNote | undefined {
    return this.createCandidate({
      content: analysis.summary,
      summary: analysis.summary,
      category: analysis.category,
      tags: analysis.tags,
      source: "ai",
      status: analysis.lifecycleStatus,
      provenance: {
        kind: analysis.provenanceKind,
        parentDiaryId: analysis.parentDiaryId,
        lastEditKind: "system",
      },
      confidence: analysis.confidence,
      metadata: {
        condensation: {
          ruleVersion: CONDENSATION_RULE_VERSION,
          keyFacts: analysis.keyFacts,
          confidenceContributions: analysis.confidenceContributions,
        },
      },
    });
  }

  /** Backward-compatible analyze + commit. */
  condense(input: string, parentDiaryId?: string, config?: CondensationConfig): MemoryNote | undefined {
    const analysis = this.analyze(input, parentDiaryId, config);
    return analysis ? this.commitAnalysis(analysis) : undefined;
  }
}
