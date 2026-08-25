import type { MemoryContext } from "../types/index.js";

export const toAgentToolResult = (ctx: MemoryContext) => ({
  ok: true as const,
  context: ctx,
  citations: ctx.citations,
  partial: ctx.truncation.hitBudget
});
