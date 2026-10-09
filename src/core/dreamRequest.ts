import type { DreamBudgets, DreamSelector } from "../types/dreamPlan.js";
import { types } from "node:util";
import { codeUnitCompare, tokenize } from "./Tokenizer.js";

export const DREAM_BUDGETS: Readonly<DreamBudgets> = Object.freeze({
  maxPopulation: 4096, maxSources: 128, maxTags: 64, maxContentBytes: 65536,
  maxNoteDependencyBytes: 131072, maxSelectionBytes: 4194304,
  maxDependencyBytes: 1048576, maxRelationships: 1024, maxPlanBytes: 65536
});
export const DREAM_INPUT_LIMITS = Object.freeze({ selectorCount: 256, scalar: 256, query: 4096 });
export class DreamInputError extends Error {
  constructor(message: string, readonly code: "INVALID_INPUT" | "NOT_FOUND" = "INVALID_INPUT") { super(message); }
}
export interface DreamRequest { selector: DreamSelector; asOf: number; budgets: DreamBudgets }
export function dreamEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) throw new DreamInputError("Expected integer epoch milliseconds within the Date range.");
  return Object.is(value, -0) ? 0 : value;
}
export function dreamScalar(value: unknown, limit: number = DREAM_INPUT_LIMITS.scalar): string {
  if (typeof value !== "string" || value.length > limit) throw new DreamInputError("Dream scalar type or length exceeds its bound.");
  if (!value.trim()) throw new DreamInputError("Dream scalar must be nonempty.");
  return value;
}
// Read only own data properties: caller accessors are never invoked.
const record = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (types.isProxy(value)) throw new DreamInputError("Proxy Dream request containers are not supported.");
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new DreamInputError("Expected plain Dream request data.");
  const result: Record<string, unknown> = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key) || !fields.includes(key)) throw new DreamInputError("Unexpected Dream request field.");
  }
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new DreamInputError("Dream request accessors or hidden fields are not supported.");
    result[key] = descriptor.value;
  }
  return result;
};
const selectorList = (value: unknown): string[] => {
  if (types.isProxy(value)) throw new DreamInputError("Proxy Dream selector arrays are not supported.");
  if (!Array.isArray(value) || value.length === 0 || value.length > DREAM_INPUT_LIMITS.selectorCount) throw new DreamInputError("Dream selector needs 1..256 raw IDs or tags.");
  const list: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) throw new DreamInputError("Dream selector arrays must contain data elements.");
    list.push(dreamScalar(descriptor.value));
  }
  return [...new Set(list)].sort(codeUnitCompare);
};
export function normalizeDreamRequest(selectorInput: unknown, optionsInput: unknown): DreamRequest {
  const options = optionsInput === undefined ? {} : record(optionsInput, ["asOf", "budgets"]);
  // Exactly one clock observation, shared by eligibility, selection and identity.
  const asOf = dreamEpoch(options.asOf === undefined ? Date.now() : options.asOf);
  const budgets = { ...DREAM_BUDGETS };
  if (options.budgets !== undefined) {
    const requested = record(options.budgets, Object.keys(DREAM_BUDGETS));
    for (const key of Object.keys(DREAM_BUDGETS) as Array<keyof DreamBudgets>) {
      const value = requested[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > DREAM_BUDGETS[key]) throw new DreamInputError(`Dream budget ${key} may only lower its positive integer ceiling.`);
      budgets[key] = value;
    }
  }
  const raw = record(selectorInput, ["kind", "ids", "tags", "query", "from", "to"]);
  let selector: DreamSelector;
  const only = (...fields: string[]) => { if (Object.keys(raw).some(key => !fields.includes(key))) throw new DreamInputError("Dream selector modes cannot be combined."); };
  switch (raw.kind) {
    case "ids": only("kind", "ids"); selector = { kind: "ids", ids: selectorList(raw.ids) }; break;
    case "tags": only("kind", "tags"); selector = { kind: "tags", tags: selectorList(raw.tags) }; break;
    case "query": {
      only("kind", "query"); const query = tokenize(dreamScalar(raw.query, DREAM_INPUT_LIMITS.query)).join(" ");
      if (!query) throw new DreamInputError("Dream query needs lexical tokens.");
      selector = { kind: "query", query }; break;
    }
    case "date-window": {
      only("kind", "from", "to"); const from = dreamEpoch(raw.from), to = dreamEpoch(raw.to);
      if (from > to) throw new DreamInputError("Dream date window is reversed.");
      selector = { kind: "date-window", from, to }; break;
    }
    case "all_active": only("kind"); selector = { kind: "all_active" }; break;
    default: throw new DreamInputError("An explicit supported Dream selector is required.");
  }
  return { selector, asOf, budgets };
}
