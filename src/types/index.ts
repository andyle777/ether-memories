import type { MEMORY_CONTEXT_SCHEMA_VERSION, PORTABLE_RECORD_SCHEMA_VERSION, STORE_SCHEMA_VERSION } from "../version.js";

export type MemorySource =
  | "user"
  | "conversation"
  | "diary"
  | "ai"
  | "imported"
  | "system";

export type ProvenanceKind =
  | "user_explicit"
  | "diary_extract"
  | "condensed"
  | "inferred"
  | "imported"
  | "system";

export interface MemoryProvenance {
  kind: ProvenanceKind;
  parentNoteId?: string;
  parentDiaryId?: string;
  parentEdgeId?: string;
  importBatchId?: string;
  detail?: string;
  lastEditKind?: "user" | "system" | "import";
}

export type MemoryStatus = "candidate" | "active" | "archived" | "rejected";

export interface MemoryNote {
  id: string;
  content: string;
  summary?: string;
  category?: string;
  tags: string[];
  source: MemorySource;
  provenance: MemoryProvenance;
  importance: number;
  confidence: number;
  pinned: boolean;
  status: MemoryStatus;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface DiaryEntry {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface MindGraphNode {
  id: string;
  type: string;
  label?: string;
  data: Record<string, unknown>;
}

export type GraphRelation =
  | "related_to"
  | "mentions"
  | "derived_from"
  | "supports"
  | "prefers"
  | "worked_on"
  | "part_of"
  | "about";

export interface MindGraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: string;
  data: Record<string, unknown>;
}

export interface UserIdentity {
  userId: string;
  displayName?: string;
  createdAt: Date;
  lastActive: Date;
  preferences: Record<string, unknown>;
}

export type EtherErrorCode =
  | "STORAGE_ERROR"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "USER_ID_MISMATCH"
  | "UNSUPPORTED_SCHEMA"
  | "UNKNOWN_ERROR";

export interface RetrievalMatch {
  memory: MemoryNote;
  score: number;
  matchedBy: Array<
    | "exact_phrase" | "token" | "tag" | "category"
    | "graph_neighbor" | "recency" | "pinned"
    | "importance" | "explicit_id"
  >;
  graphEvidence?: GraphEvidence;
}

export interface GraphEvidence {
  seedMemoryId: string;
  depth: 1 | 2;
  path: Array<{ edgeId: string; relationship: string; direction: "in" | "out"; from: string; to: string }>;
}

export type MemoryContextSchemaVersion = typeof MEMORY_CONTEXT_SCHEMA_VERSION;

export type MemoryContextPurpose =
  | "llm_turn"
  | "agent_tool"
  | "rlm_env"
  | "debug"
  | "handoff";

export interface MemoryContextBudget {
  maxNotes: number;
  maxDiary: number;
  maxNodes: number;
  maxEdges: number;
  maxChars?: number;
}

export interface MemoryContextQuery {
  text?: string;
  noteIds?: string[];
  diaryIds?: string[];
  filters?: {
    includeCandidate?: boolean;
    includeArchived?: boolean;
    includeExpired?: boolean;
    tags?: string[];
    categories?: string[];
    pinnedOnly?: boolean;
  };
  graph?: {
    enabled?: boolean;
    neighborhoodDepth?: 0 | 1 | 2;
    direction?: "in" | "out" | "both";
    maxResults?: number;
    relationAllowlist?: string[];
  };
  budget: MemoryContextBudget;
}

export interface ContextCitation {
  ref: string;
  kind: "note" | "diary" | "node" | "edge";
  id: string;
}

export interface ContextNote {
  note: MemoryNote;
  score?: number;
  matchedBy?: RetrievalMatch["matchedBy"];
  graphEvidence?: GraphEvidence;
  excerpt?: string;
  cite: ContextCitation;
}

export interface ContextDiary {
  entry: DiaryEntry;
  score?: number;
  matchedBy?: Array<"exact_phrase" | "token" | "tag" | "recency" | "explicit_id">;
  excerpt?: string;
  cite: ContextCitation;
}

export interface ContextGraphSlice {
  nodes: MindGraphNode[];
  edges: MindGraphEdge[];
  policy: "neighborhood" | "explicit_ids" | "none";
  depth: 0 | 1 | 2;
}

export interface RetrievalTrace {
  mode: "query" | "ids" | "hybrid" | "empty";
  matchedNoteCount: number;
  matchedDiaryCount: number;
  filtersApplied: string[];
  ranking: "deterministic_v1";
  conflictFlags: Array<{
    claimKey?: string;
    noteIds: string[];
    reason: "duplicate_claim_key" | "pinned_shield" | "status_mismatch";
  }>;
}

export interface TruncationReport {
  notesOmitted: number;
  diaryOmitted: number;
  nodesOmitted: number;
  edgesOmitted: number;
  charsOmitted: number;
  hitBudget: boolean;
}

export interface MemoryContext {
  schemaVersion: MemoryContextSchemaVersion;
  libraryVersion: string;
  purpose: MemoryContextPurpose;
  producedAt: string;
  userId: string;
  identity: { userId: string; displayName?: string };
  query: MemoryContextQuery;
  retrieval: RetrievalTrace;
  notes: ContextNote[];
  diary: ContextDiary[];
  graph: ContextGraphSlice;
  citations: ContextCitation[];
  truncation: TruncationReport;
  extensions?: Record<string, unknown>;
}

export interface BuildMemoryContextInput {
  purpose: MemoryContextPurpose;
  query?: Omit<MemoryContextQuery, "budget"> & {
    budget?: Partial<MemoryContextBudget>;
  };
}

export interface EtherSnapshot {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  identity: UserIdentity;
  memoryNotes: MemoryNote[];
  diary: DiaryEntry[];
  graph: {
    nodes: MindGraphNode[];
    edges: MindGraphEdge[];
  };
}

export interface StoragePort {
  load(): Promise<unknown>;
  save(snapshot: EtherSnapshot): Promise<void>;
}

export interface PortableRecord {
  schema: typeof PORTABLE_RECORD_SCHEMA_VERSION;
  id: string;
  kind: "note" | "diary";
  text: string;
  citation: ContextCitation;
  tags: string[];
  category?: string;
  source?: string;
  status?: MemoryStatus;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}
