import type { DreamCycleResult } from "../types/dreamAnalysis.js";
import type { DreamAnalysisSnapshot } from "./dreamPlan.js";
import { buildDreamResult, type DreamAnalysisBinding, type DreamAnalysisOutput } from "./dreamProposals.js";
import { CondensationEngine } from "./CondensationEngine.js";
import { DreamInputError } from "./dreamRequest.js";

const CONFIG = Object.freeze({ maxFacts: 5, minFactLength: 8, maxFactLength: 240, summaryLength: 200, maxTags: 8 });
export function analyzeDreamContent(content: string): DreamAnalysisOutput | undefined {
  if (typeof content !== "string" || content.length > 65536 || Buffer.byteLength(content, "utf8") > 65536) {
    throw new DreamInputError("Dream source exceeds its analysis bound.");
  }
  const engine = new CondensationEngine(() => { throw new Error("Dream analysis has no candidate authority."); });
  const analysis = engine.analyze(content, undefined, CONFIG);
  if (!analysis) return undefined;
  let summary = analysis.summary;
  if (content.trim().length > 200) {
    const last = summary.charCodeAt(summary.length - 4);
    if (last >= 0xd800 && last <= 0xdbff) summary = summary.slice(0, -4) + "...";
  }
  return { content: summary, keyFacts: [...analysis.keyFacts] };
}

/** No owners, selector, population data or live authoritative callbacks. */
export function analyzeDreamSnapshot(snapshot: DreamAnalysisSnapshot, binding: DreamAnalysisBinding): DreamCycleResult {
  if (snapshot.notes.length > 128 || snapshot.relationships.length > 1024) throw new DreamInputError("Dream snapshot exceeds its analysis bound.");
  const outputs: Array<{ sourceId: string; analysis: DreamAnalysisOutput }> = [];
  for (const note of snapshot.notes) {
    const analysis = analyzeDreamContent(note.content);
    if (analysis) outputs.push({ sourceId: note.id, analysis });
  }
  return buildDreamResult(snapshot, binding, outputs);
}
