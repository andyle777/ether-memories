import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import {
  CONDENSATION_RULE_VERSION,
  type CondensationAnalysis,
  type CondensationConfig
} from "../src/core/CondensationEngine.js";

const here = dirname(fileURLToPath(import.meta.url));

const deepEqualAnalysis = (a: CondensationAnalysis | undefined, b: CondensationAnalysis | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

describe("v0.5 deterministic condensation", () => {
  it("rejects empty and whitespace-only input deterministically", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    expect(e.condensation.analyze("")).toBeUndefined();
    expect(e.condensation.analyze("   \n\t  ")).toBeUndefined();
  });

  it("produces deeply equal analysis for a single sentence", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "The project shipped the release today.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts).toEqual(["The project shipped the release today."]);
    expect(a!.category).toBe("project");
    expect(a!.lifecycleStatus).toBe("candidate");
    expect(a!.provenanceKind).toBe("condensed");
  });

  it("produces deeply equal analysis for multiple sentences", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "The project shipped. The build passed overnight. We released version two.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts).toEqual([
      "The project shipped.",
      "The build passed overnight.",
      "We released version two."
    ]);
  });

  it("deduplicates repeated sentences by normalized form", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "The project shipped. The project shipped. The build passed.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts).toEqual(["The project shipped.", "The build passed."]);
  });

  it("handles punctuation deterministically and filters short fragments", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "Shipped version 1.0! Ready for release? Yes.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts).toEqual(["Shipped version 1.0!", "Ready for release?"]);
  });

  it("handles Unicode text deterministically with code-unit tag order", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "Café résumé shipped today. 你好世界 built.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts.length).toBe(2);
    // code-unit order: built < café < résumé < shipped < today < 你好世界
    expect(a!.tags).toEqual(["built", "café", "résumé", "shipped", "today", "你好世界"]);
  });

  it("deduplicates repeated keywords into ordered tags", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "project project build build library library.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.tags).toEqual(["build", "library", "project"]);
    expect(a!.category).toBe("project");
  });

  it("returns no category for text matching no documented rule", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "The sky is blue and the river flows quietly.";
    const a = e.condensation.analyze(text);
    const b = e.condensation.analyze(text);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.category).toBeUndefined();
  });

  it("preserves Diary provenance for Diary-derived input", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const diary = e.addDiaryEntry({ content: "A diary source entry." });
    expect(diary.ok).toBe(true);
    if (!diary.ok) return;
    const text = "The project shipped the release today.";
    const a = e.condensation.analyze(text, diary.value.id);
    const b = e.condensation.analyze(text, diary.value.id);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.provenanceKind).toBe("diary_extract");
    expect(a!.parentDiaryId).toBe(diary.value.id);
    expect(a!.lifecycleStatus).toBe("candidate");
    // diary linkage contributes a documented confidence contribution
    const linked = a!.confidenceContributions.find(c => c.rule === "diary_linked");
    expect(linked?.contribution).toBe(0.1);
  });

  it("derives confidence solely from inspectable rule contributions", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const a = e.condensation.analyze("The project shipped the release today.");
    expect(a).toBeDefined();
    const sum = a!.confidenceContributions.reduce((t, c) => t + c.contribution, 0);
    const clamped = Math.max(0, Math.min(1, sum));
    expect(a!.confidence).toBe(clamped);
    expect(a!.confidence).toBeGreaterThan(0);
    expect(a!.confidence).toBeLessThanOrEqual(1);
    // every contribution references a named, inspectable rule
    for (const c of a!.confidenceContributions) {
      expect(typeof c.rule).toBe("string");
      expect(c.rule.length).toBeGreaterThan(0);
      expect(c.contribution).toBeGreaterThanOrEqual(0);
    }
  });

  it("respects a custom configuration deterministically", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const config: CondensationConfig = { maxFacts: 2, maxTags: 3, summaryLength: 40 };
    const text = "First fact here. Second fact here. Third fact here. Fourth fact here.";
    const a = e.condensation.analyze(text, undefined, config);
    const b = e.condensation.analyze(text, undefined, config);
    expect(deepEqualAnalysis(a, b)).toBe(true);
    expect(a!.keyFacts.length).toBe(2);
    expect(a!.tags.length).toBeLessThanOrEqual(3);
  });

  it("stores the deterministic analysis in committed candidate metadata", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const text = "The project shipped the release today.";
    const analysis = e.condensation.analyze(text);
    expect(analysis).toBeDefined();
    const note = e.condensation.condense(text);
    expect(note).toBeTruthy();
    if (!note || !analysis) return;
    const stored = note.metadata.condensation as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored!.ruleVersion).toBe(CONDENSATION_RULE_VERSION);
    expect(stored!.keyFacts).toEqual(analysis.keyFacts);
    expect(stored!.confidenceContributions).toEqual(analysis.confidenceContributions);
    expect(note.tags).toEqual(analysis.tags);
    expect(note.category).toBe(analysis.category);
    expect(note.confidence).toBe(analysis.confidence);
    expect(note.status).toBe("candidate");
  });
});

describe("v0.5 condensation candidate isolation", () => {
  it("creates, hides, includes, promotes, and does not duplicate graph entities", () => {
    const e = new EtherMemoriesCore({ userId: "u1" });
    const diary = e.addDiaryEntry({ content: "Source diary entry for condensation." });
    expect(diary.ok).toBe(true);
    if (!diary.ok) return;

    // 1. condensed candidate is created as candidate with Diary provenance
    const candidate = e.condensation.condense("The project shipped the release today.", diary.value.id);
    expect(candidate).toBeTruthy();
    if (!candidate) return;
    const memoryId = candidate.id;
    expect(candidate.status).toBe("candidate");
    expect(candidate.provenance.kind).toBe("diary_extract");
    expect(candidate.provenance.parentDiaryId).toBe(diary.value.id);

    // 2. ordinary retrieval excludes the candidate
    const hidden = e.queryMemories("project shipped release");
    expect(hidden.ok).toBe(true);
    if (hidden.ok) expect(hidden.value).toHaveLength(0);

    // 3. explicit candidate-inclusive retrieval can see it
    const visible = e.queryMemories("project shipped release", { includeCandidate: true });
    expect(visible.ok).toBe(true);
    if (visible.ok) {
      expect(visible.value).toHaveLength(1);
      expect(visible.value[0].id).toBe(memoryId);
    }

    // 4. explicit promotion makes it active, and default retrieval now returns it
    const promoted = e.promoteCandidate(memoryId);
    expect(promoted.ok).toBe(true);
    expect(promoted.ok && promoted.value.status).toBe("active");
    const after = e.queryMemories("project shipped release");
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value).toHaveLength(1);
      expect(after.value[0].id).toBe(memoryId);
    }

    // 5. promotion creates no duplicate graph entities and leaves no stale lifecycle
    const memoryNodes = e.graph.getAllNodes().filter(n => n.id === `memory:${memoryId}`);
    expect(memoryNodes).toHaveLength(1);
    expect(memoryNodes[0].data.status).toBe("active");
    const derivedEdges = e.graph.getAllEdges().filter(
      ed => ed.source === `memory:${memoryId}` &&
        ed.target === `diary:${diary.value.id}` &&
        ed.relationship === "derived_from"
    );
    expect(derivedEdges).toHaveLength(1);
  });
});

describe("v0.5 condensation dependency gate", () => {
  it("adds no LLM, model, provider, or embedding dependency", async () => {
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["graphology", "graphology-types"]);
    const source = await readFile(join(here, "..", "src", "core", "CondensationEngine.ts"), "utf8");
    const importLines = source.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      const from = line.match(/from\s+["']([^"']+)["']/);
      expect(from).toBeTruthy();
      const spec = from![1];
      // Condensation must not import an external model/provider/embedding package.
      expect(spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("node:")).toBe(true);
    }
  });
});
