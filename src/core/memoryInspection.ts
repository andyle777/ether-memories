import type { MemoryExplanation, MemoryHealthReport, MemoryInspectionOptions } from "../types/index.js";
import { err, ok, type Result } from "../utils/result.js";
import { explanationSnapshot, healthSnapshot, inspectionTime, INSPECTION_LIMITS, type HealthSnapshot } from "./inspectionSnapshot.js";

/** Analyze only the detached, bounded plain-data snapshot. */
export function analyzeExplanation(snapshot: MemoryExplanation): MemoryExplanation {
  return { ...snapshot, note: { ...snapshot.note, expired: snapshot.note.expired === null ? null
    : snapshot.note.expiresAt !== null && snapshot.note.expiresAt <= snapshot.asOf } };
}

/** Pure logical analysis: no clock, owned objects, graph traversal, or I/O. */
export function analyzeHealth(snapshot: HealthSnapshot): MemoryHealthReport {
  const report: MemoryHealthReport = { asOf: snapshot.asOf, coverage: { ...snapshot.coverage, reasons: [...snapshot.coverage.reasons] },
    counts: { active: 0, candidate: 0, archived: 0, rejected: 0, expired: 0 },
    invariantFailures: [], observations: [], suggestions: [], findingsTruncated: false };
  let missing = 0, isolated = 0;
  const failure = (code: string, noteId: string): void => {
    if (report.invariantFailures.length < INSPECTION_LIMITS.findings) report.invariantFailures.push({ code, noteId });
    else report.findingsTruncated = true;
  };
  for (const n of snapshot.notes) {
    if (["active", "candidate", "archived", "rejected"].includes(n.status)) report.counts[n.status as "active" | "candidate" | "archived" | "rejected"]++;
    else failure("invalid-status", n.id);
    if (n.confidence === null || n.confidence < 0 || n.confidence > 1) failure("invalid-confidence", n.id);
    if (n.createdAt === null || n.updatedAt === null || n.expiryInvalid) failure("invalid-timestamp", n.id);
    if (n.expiresAt !== null && n.expiresAt <= snapshot.asOf) report.counts.expired++;
    if (!n.graphNodePresent) missing++;
    else if (n.directRelationships === 0) isolated++;
  }
  if (report.counts.expired) {
    report.observations.push({ code: "expired-notes", count: report.counts.expired });
    report.suggestions.push({ code: "review-expired-notes", count: report.counts.expired, authoritative: false });
  }
  if (missing) report.observations.push({ code: "missing-graph-nodes", count: missing });
  if (isolated) report.observations.push({ code: "isolated-notes", count: isolated });
  if (missing + isolated) report.suggestions.push({ code: "consider-note-links", count: missing + isolated, authoritative: false });
  return report;
}

export function explainMemory(notes: object, graph: object, id: string, options?: MemoryInspectionOptions): Result<MemoryExplanation> {
  try {
    const snapshot = explanationSnapshot(notes, graph, id, inspectionTime(options));
    return snapshot ? ok(analyzeExplanation(snapshot)) : err("NOT_FOUND", "Memory Note not found.");
  } catch (e) { return err("INVALID_INPUT", e instanceof Error ? e.message : "Unable to inspect Memory Note."); }
}
export function inspectMemoryHealth(notes: object, graph: object, options?: MemoryInspectionOptions): Result<MemoryHealthReport> {
  try { return ok(analyzeHealth(healthSnapshot(notes, graph, inspectionTime(options)))); }
  catch (e) { return err("INVALID_INPUT", e instanceof Error ? e.message : "Unable to inspect logical memory health."); }
}
