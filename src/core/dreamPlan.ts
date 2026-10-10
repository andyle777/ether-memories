import { createHash } from "node:crypto";
import type { DreamCyclePreviewOptions, DreamPlan, DreamSelector } from "../types/dreamPlan.js";
import { err, ok, type Result } from "../utils/result.js";
import { DreamInputError, dreamScalar, normalizeDreamRequest, type DreamRequest } from "./dreamRequest.js";
import { dreamBytes, selectDreamNotes, type DreamNoteDependency } from "./dreamSelection.js";
import { inspectionGraph } from "./inspectionSources.js";
import { codeUnitCompare } from "./Tokenizer.js";

export interface DreamRelationship { id: string; source: string; target: string; relationship: string }
/** Analysis owns only selected projections, never the selector/population scan. */
export interface DreamAnalysisSnapshot { notes: DreamNoteDependency[]; relationships: DreamRelationship[] }
export interface DreamCapturedDependencies extends DreamAnalysisSnapshot {
  request: DreamRequest;
  coverage: Pick<DreamPlan, "selectedSourceIds" | "selectedCount" | "knownCount" | "selectionTruncated" | "truncationReasons">;
}
const copySelector = (selector: DreamSelector): DreamSelector => selector.kind === "ids" ? { kind: "ids", ids: [...selector.ids] }
  : selector.kind === "tags" ? { kind: "tags", tags: [...selector.tags] } : { ...selector };
const inducedRelationships = (owner: object, ids: string[], request: DreamRequest, sourceBytes: number): DreamRelationship[] => {
  const graph = inspectionGraph(owner), result: DreamRelationship[] = [];
  let dependencyBytes = sourceBytes;
  // At most128² constant-time directed pair lookups. No incident edge/neighbor
  // enumeration, foreign endpoint, node label or arbitrary edge data is read.
  for (const source of ids) for (const target of ids) {
    const from = `memory:${source}`, to = `memory:${target}`;
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue;
    const edge = graph.directedEdge(from, to);
    if (edge === undefined) continue;
    if (result.length >= request.budgets.maxRelationships) throw new DreamInputError("Dream induced relationship ceiling exceeded.");
    const relationship = { id: dreamScalar(edge), source, target, relationship: dreamScalar(graph.getEdgeAttribute(edge, "relationship")) };
    dependencyBytes += dreamBytes(relationship, request.budgets.maxDependencyBytes).byteLength;
    if (dependencyBytes > request.budgets.maxDependencyBytes) throw new DreamInputError("Dream aggregate relationship dependency byte ceiling exceeded.");
    result.push(relationship);
  }
  return result.sort((a, b) => codeUnitCompare(a.id, b.id) || codeUnitCompare(a.source, b.source)
    || codeUnitCompare(a.target, b.target) || codeUnitCompare(a.relationship, b.relationship));
};

/** One bounded observation; retain no nonselected source projections. */
export function captureDreamDependencies(notesOwner: object, graphOwner: object, input: DreamRequest): DreamCapturedDependencies {
  const request: DreamRequest = { selector: copySelector(input.selector), asOf: input.asOf, budgets: { ...input.budgets } };
  const selection = selectDreamNotes(notesOwner, request), selectedSourceIds = selection.notes.map(note => note.id);
  const relationships = inducedRelationships(graphOwner, selectedSourceIds, request, selection.dependencyBytes);
  return { request, notes: selection.notes, relationships, coverage: { selectedSourceIds, selectedCount: selectedSourceIds.length,
    knownCount: selection.knownCount, selectionTruncated: selection.selectionTruncated,
    truncationReasons: selection.selectionTruncated ? ["source-limit"] : [] } };
}

/** Exact frozen T3 preimages; public returns never alias the private capture. */
export function buildDreamPlan(capture: DreamCapturedDependencies): DreamPlan {
  const { request, coverage, notes, relationships } = capture, algorithm = "ether.dream.v1" as const;
  const dependencyDigest = createHash("sha256").update(dreamBytes({ domain: "ether.dream.dependencies.v1", algorithm,
    ...request, coverage, notes, relationships }, request.budgets.maxDependencyBytes)).digest("hex");
  const fields = { algorithm, asOf: request.asOf, selector: copySelector(request.selector),
    ...coverage, selectedSourceIds: [...coverage.selectedSourceIds], truncationReasons: [...coverage.truncationReasons], dependencyDigest,
    budgets: { ...request.budgets }, graph: { relationshipCount: relationships.length } };
  const planId = createHash("sha256").update(dreamBytes({ domain: "ether.dream.plan.v1", ...fields }, request.budgets.maxPlanBytes)).digest("hex");
  const plan = { ...fields, planId }; dreamBytes(plan, request.budgets.maxPlanBytes);
  return plan;
}

/** Internal pure preparation only; public facade owns authoritative-state precedence. */
export function previewDreamCycle(notesOwner: object, graphOwner: object, selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> {
  try {
    return ok(buildDreamPlan(captureDreamDependencies(notesOwner, graphOwner, normalizeDreamRequest(selector, options))));
  } catch (error) {
    return err(error instanceof DreamInputError ? error.code : "INVALID_INPUT", error instanceof DreamInputError ? error.message : "Invalid Dream dependency or request.");
  }
}
