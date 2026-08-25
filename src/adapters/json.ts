import type { MemoryContext } from "../types/index.js";

export const toPlainJson = (ctx: MemoryContext): string => JSON.stringify(ctx, null, 2);
