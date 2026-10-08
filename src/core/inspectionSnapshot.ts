import type { MemoryExplanation, MemoryHealthReport, MemoryInspectionOptions, MemoryNote, MemoryProvenance } from "../types/index.js";
import { cloneValue } from "../utils/clone.js";
import { codeUnitCompare } from "./Tokenizer.js";
import { inspectionGraph, inspectionNotes } from "./inspectionSources.js";

// Fixed internal caps; callers cannot increase work or output via options.
export const INSPECTION_LIMITS = Object.freeze({ population: 4096, notes: 256, edges: 4096,
  returnedEdges: 32, tags: 256, returnedTags: 32, scalar: 256, selectionBytes: 1048576,
  snapshotBytes: 262144, findings: 128 });

export const inspectionTime = (options?: MemoryInspectionOptions): number => {
  // Capture once on facade entry, even for a later invalid-input failure.
  const requestedTime = options?.asOf;
  const asOf = requestedTime === undefined ? Date.now() : requestedTime;
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) throw new Error("Invalid inspection options.");
  if (typeof asOf !== "number" || !Number.isFinite(asOf) || Math.abs(asOf) > 8640000000000000) throw new Error("asOf must be a valid epoch millisecond number.");
  return asOf;
};
const scalar = (s: string): string => {
  if (typeof s !== "string" || s.length > INSPECTION_LIMITS.scalar) throw new Error("Inspection scalar exceeds the 256 code-unit bound or is invalid.");
  return s;
};
const time = (d: Date): number | null => d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
const degree = (graph: ReturnType<typeof inspectionGraph>, id: string): number => graph.degree(id) - (graph.hasDirectedEdge(id, id) ? 1 : 0);

export function explanationSnapshot(notesOwner: object, graphOwner: object, id: string, asOf: number): MemoryExplanation | undefined {
  if (typeof id !== "string" || !id.trim()) throw new Error("A nonempty Memory Note ID is required.");
  scalar(id);
  const n = inspectionNotes(notesOwner).get(id);
  if (!n) return undefined;
  const unavailableEvidence: string[] = [];
  let tags: string[] = [];
  if (n.tags.length <= INSPECTION_LIMITS.tags) tags = n.tags.map(scalar).sort(codeUnitCompare).slice(0, INSPECTION_LIMITS.returnedTags);
  else unavailableEvidence.push("tags-work-limit");
  let provenance: Omit<MemoryProvenance, "detail"> | null = null;
  if (n.provenance && typeof n.provenance.kind === "string") {
    provenance = { kind: scalar(n.provenance.kind) as MemoryProvenance["kind"] };
    for (const key of ["parentNoteId", "parentDiaryId", "parentEdgeId", "importBatchId", "lastEditKind"] as const) {
      const s = n.provenance[key];
      if (s !== undefined) Object.assign(provenance, { [key]: scalar(s) });
    }
  } else unavailableEvidence.push("provenance");
  if (n.category === undefined) unavailableEvidence.push("category");
  const graph = inspectionGraph(graphOwner), nodeId = `memory:${id}`, present = graph.hasNode(nodeId);
  const count = present ? degree(graph, nodeId) : 0;
  const relationships: MemoryExplanation["relationships"] = { entries: [], knownCount: count, returnedCount: 0, truncated: false, reasons: [] };
  if (!present) unavailableEvidence.push("graph-node");
  if (count > INSPECTION_LIMITS.edges) relationships.reasons.push("relationship-work-limit");
  else if (present) {
    const ids = graph.edges(nodeId);
    let bytes = 0;
    for (const edge of ids) { scalar(edge); bytes += Buffer.byteLength(edge, "utf8"); }
    if (bytes > INSPECTION_LIMITS.selectionBytes) relationships.reasons.push("relationship-selection-byte-limit");
    else relationships.entries = ids.sort(codeUnitCompare).slice(0, INSPECTION_LIMITS.returnedEdges).map(edge => {
      const [source, target] = graph.extremities(edge);
      return { id: edge, relationship: scalar(graph.getEdgeAttribute(edge, "relationship")) as MemoryExplanation["relationships"]["entries"][number]["relationship"],
        direction: source === target ? "self" : source === nodeId ? "out" : "in",
        adjacentId: scalar(source === nodeId ? target : source) };
    });
  }
  relationships.returnedCount = relationships.entries.length;
  relationships.truncated = count > relationships.returnedCount;
  if (relationships.truncated && !relationships.reasons.length) relationships.reasons.push("relationship-output-limit");
  const report: MemoryExplanation = { asOf, note: { id, status: scalar(n.status) as MemoryNote["status"], source: scalar(n.source) as MemoryNote["source"],
    category: n.category === undefined ? null : scalar(n.category), tags, tagsKnownCount: n.tags.length, tagsTruncated: n.tags.length > tags.length,
    confidence: Number.isFinite(n.confidence) ? n.confidence : null,
    createdAt: time(n.createdAt), updatedAt: time(n.updatedAt), expiresAt: n.expiresAt === undefined ? null : time(n.expiresAt),
    expired: n.expiresAt !== undefined && time(n.expiresAt) === null ? null : false, provenance }, graphNodePresent: present, relationships, unavailableEvidence };
  if (report.note.createdAt === null || report.note.updatedAt === null || report.note.expired === null) unavailableEvidence.push("invalid-timestamp");
  if (report.note.confidence === null) unavailableEvidence.push("invalid-confidence");
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > INSPECTION_LIMITS.snapshotBytes) throw new Error("Inspection snapshot byte limit exceeded.");
  return cloneValue(report);
}

export interface HealthNote {
  id: string; status: string; confidence: number | null; createdAt: number | null; updatedAt: number | null;
  expiryInvalid: boolean; expiresAt: number | null; graphNodePresent: boolean; directRelationships: number;
}
export interface HealthSnapshot { asOf: number; notes: HealthNote[]; coverage: MemoryHealthReport["coverage"] }
export function healthSnapshot(notesOwner: object, graphOwner: object, asOf: number): HealthSnapshot {
  const source = inspectionNotes(notesOwner), graph = inspectionGraph(graphOwner);
  const snapshot: HealthSnapshot = { asOf, notes: [], coverage: { complete: false, knownCount: source.size, inspectedCount: 0, reasons: [] } };
  if (source.size > INSPECTION_LIMITS.population) snapshot.coverage.reasons.push("population-work-limit");
  else {
    const ids: string[] = [];
    let bytes = 0;
    let oversized = false;
    for (const id of source.keys()) {
      if (id.length > INSPECTION_LIMITS.scalar) { oversized = true; continue; }
      bytes += Buffer.byteLength(id, "utf8");
      ids.push(id);
    }
    // Finish the bounded identifier scan so simultaneous limit reasons do not
    // depend on Map insertion order. Never scan bytes of an oversized scalar.
    if (oversized) snapshot.coverage.reasons.push("identifier-scalar-limit");
    if (bytes > INSPECTION_LIMITS.selectionBytes) snapshot.coverage.reasons.push("population-selection-byte-limit");
    if (!snapshot.coverage.reasons.length) {
      bytes = 0;
      for (const id of ids.sort(codeUnitCompare).slice(0, INSPECTION_LIMITS.notes)) {
        const n = source.get(id)!, nodeId = `memory:${id}`, present = graph.hasNode(nodeId);
        const note: HealthNote = { id, status: n.status, confidence: Number.isFinite(n.confidence) ? n.confidence : null,
          createdAt: time(n.createdAt), updatedAt: time(n.updatedAt), expiryInvalid: n.expiresAt !== undefined && time(n.expiresAt) === null,
          expiresAt: n.expiresAt === undefined ? null : time(n.expiresAt), graphNodePresent: present, directRelationships: present ? degree(graph, nodeId) : 0 };
        // No raw scalar except bounded identifier and the canonical status enum.
        note.status = typeof n.status === "string" && n.status.length <= INSPECTION_LIMITS.scalar ? n.status : "invalid";
        bytes += Buffer.byteLength(JSON.stringify(note), "utf8");
        if (bytes > INSPECTION_LIMITS.snapshotBytes - 1024) { snapshot.coverage.reasons.push("snapshot-byte-limit"); break; }
        snapshot.notes.push(note);
      }
      if (source.size > INSPECTION_LIMITS.notes) snapshot.coverage.reasons.push("note-output-limit");
    }
  }
  snapshot.coverage.inspectedCount = snapshot.notes.length;
  snapshot.coverage.complete = snapshot.notes.length === source.size;
  return cloneValue(snapshot);
}
