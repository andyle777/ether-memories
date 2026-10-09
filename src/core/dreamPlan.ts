import { createHash } from "node:crypto";
import type { DreamCyclePreviewOptions, DreamPlan, DreamSelector } from "../types/dreamPlan.js";
import { err, ok, type Result } from "../utils/result.js";
import { DreamInputError, normalizeDreamRequest } from "./dreamRequest.js";
import { dreamBytes, selectDreamNotes } from "./dreamSelection.js";

/** Internal pure preparation only; public facade owns authoritative-state precedence. */
export function previewDreamCycle(notesOwner: object, _graphOwner: object, selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> {
  try {
    const request = normalizeDreamRequest(selector, options), selection = selectDreamNotes(notesOwner, request);
    const selectedSourceIds = selection.notes.map(note => note.id);
    const coverage = { selectedSourceIds, selectedCount: selectedSourceIds.length, knownCount: selection.knownCount,
      selectionTruncated: selection.selectionTruncated, truncationReasons: selection.selectionTruncated ? ["source-limit" as const] : [] };
    const algorithm = "ether.dream.v1" as const;
    const dependencyDigest = createHash("sha256").update(dreamBytes({ domain: "ether.dream.dependencies.v1", algorithm,
      ...request, coverage, notes: selection.notes, relationships: [] }, request.budgets.maxDependencyBytes)).digest("hex");
    const fields = { algorithm, asOf: request.asOf, selector: request.selector, ...coverage, dependencyDigest,
      budgets: request.budgets, graph: { relationshipCount: 0 } };
    const planId = createHash("sha256").update(dreamBytes({ domain: "ether.dream.plan.v1", ...fields }, request.budgets.maxPlanBytes)).digest("hex");
    const plan = { ...fields, planId }; dreamBytes(plan, request.budgets.maxPlanBytes);
    return ok(plan);
  } catch (error) {
    return err(error instanceof DreamInputError ? error.code : "INVALID_INPUT", error instanceof DreamInputError ? error.message : "Invalid Dream dependency or request.");
  }
}
