/** An explicit boundary over canonical Memory Notes, never a graph seed. */
export type DreamSelector =
  | { kind: "ids"; ids: string[] }
  | { kind: "tags"; tags: string[] }
  | { kind: "query"; query: string }
  | { kind: "date-window"; from: number; to: number }
  | { kind: "all_active" };

/** Callers may lower these positive integer ceilings, never raise them. */
export interface DreamBudgets {
  maxPopulation: number;
  maxSources: number;
  maxTags: number;
  maxContentBytes: number;
  maxNoteDependencyBytes: number;
  maxSelectionBytes: number;
  maxDependencyBytes: number;
  maxRelationships: number;
  maxPlanBytes: number;
}

export interface DreamCyclePreviewOptions {
  /** Integer epoch milliseconds; captured once when omitted. */
  asOf?: number;
  budgets?: Partial<DreamBudgets>;
}

/** Ephemeral detached work plan. No source bodies, analysis or proposals. */
export interface DreamPlan {
  algorithm: "ether.dream.v1";
  planId: string;
  asOf: number;
  selector: DreamSelector;
  selectedSourceIds: string[];
  selectedCount: number;
  knownCount: number;
  selectionTruncated: boolean;
  truncationReasons: Array<"source-limit">;
  dependencyDigest: string;
  budgets: DreamBudgets;
  graph: { relationshipCount: number };
}
