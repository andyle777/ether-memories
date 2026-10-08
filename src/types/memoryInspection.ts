import type { GraphRelation, MemorySource, MemoryStatus, MemoryProvenance } from "./index.js";

/** Epoch milliseconds. Omit to capture the facade clock exactly once. */
export interface MemoryInspectionOptions { asOf?: number }
export interface InspectionCoverage {
  complete: boolean;
  knownCount: number;
  inspectedCount: number;
  reasons: string[];
}
export interface MemoryRelationshipEvidence {
  id: string;
  relationship: GraphRelation;
  direction: "in" | "out" | "self";
  /** Canonical graph identifier, without adjacent content or attributes. */
  adjacentId: string;
}
export interface MemoryExplanation {
  asOf: number;
  note: {
    id: string; status: MemoryStatus; source: MemorySource; category: string | null;
    tags: string[]; tagsKnownCount: number; tagsTruncated: boolean;
    confidence: number | null;
    createdAt: number | null; updatedAt: number | null; expiresAt: number | null;
    /** null means expiry cannot be assessed because the stored date is invalid. */
    expired: boolean | null;
    provenance: Omit<MemoryProvenance, "detail"> | null;
  };
  graphNodePresent: boolean;
  relationships: {
    entries: MemoryRelationshipEvidence[];
    knownCount: number; returnedCount: number; truncated: boolean; reasons: string[];
  };
  /** Evidence absent from canonical fields, or unavailable within a fixed bound. */
  unavailableEvidence: string[];
}
export interface MemoryHealthFinding { code: string; noteId?: string; count?: number }
export interface MemoryHealthSuggestion { code: string; count: number; authoritative: false }
export interface MemoryHealthReport {
  asOf: number;
  coverage: InspectionCoverage;
  /** These counts describe only the inspected notes. */
  counts: { active: number; candidate: number; archived: number; rejected: number; expired: number };
  invariantFailures: MemoryHealthFinding[];
  observations: MemoryHealthFinding[];
  suggestions: MemoryHealthSuggestion[];
  findingsTruncated: boolean;
}
