/** Ephemeral evidence projected only from the selected authoritative snapshot. */
export interface DreamProposalEvidence {
  keyFacts: string[];
  relationships: Array<{ id: string; source: string; target: string; relationship: string }>;
  relationshipKnownCount: number;
  relationshipsTruncated: boolean;
  truncationReasons: Array<"relationship-limit" | "relationship-byte-limit">;
}

/** Detached suggestion; never a canonical MemoryNote or persisted receipt. */
export interface DreamProposal {
  proposalId: string;
  content: string;
  sourceIds: string[];
  evidence: DreamProposalEvidence;
}

/** Deterministic observation of one validated Dream plan, without write authority. */
export interface DreamCycleResult {
  algorithm: "ether.dream.v1";
  planId: string;
  dependencyDigest: string;
  asOf: number;
  sourceCount: number;
  knownProposalCount: number;
  proposalCount: number;
  proposals: DreamProposal[];
  proposalsTruncated: boolean;
  truncationReasons: Array<"proposal-limit" | "result-byte-limit">;
}
