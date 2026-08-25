import type { MemoryContext, RetrievalTrace } from "../types/index.js";

export interface RlmMemoryEnv {
  schemaVersion: "ether.rlm_env.v1";
  context: MemoryContext;
  handles: {
    userId: string;
    noteIds: string[];
    diaryIds: string[];
    nodeIds: string[];
    edgeIds: string[];
  };
  open: {
    conflicts: RetrievalTrace["conflictFlags"];
    truncated: boolean;
    suggestedNextQueries: string[];
  };
}

export const toRlmEnv = (ctx: MemoryContext): RlmMemoryEnv => ({
  schemaVersion: "ether.rlm_env.v1",
  context: ctx,
  handles: {
    userId: ctx.userId,
    noteIds: ctx.notes.map(x => x.note.id),
    diaryIds: ctx.diary.map(x => x.entry.id),
    nodeIds: ctx.graph.nodes.map(x => x.id),
    edgeIds: ctx.graph.edges.map(x => x.id)
  },
  open: {
    conflicts: ctx.retrieval.conflictFlags,
    truncated: ctx.truncation.hitBudget,
    suggestedNextQueries: []
  }
});
