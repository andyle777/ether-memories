import { types } from "node:util";
import type { DreamBudgets, DreamPlan } from "../types/dreamPlan.js";
import { err, ok, type Result } from "../utils/result.js";
import { DREAM_BUDGETS, DreamInputError, dreamEpoch, dreamScalar, normalizeDreamRequest } from "./dreamRequest.js";
import { dreamBytes } from "./dreamSelection.js";
import { codeUnitCompare } from "./Tokenizer.js";

const reject = (): never => { throw new DreamInputError("Invalid Dream plan."); };
const plain = (input: unknown): object => {
  if (types.isProxy(input)) return reject();
  if (typeof input !== "object" || input === null || Array.isArray(input)) return reject();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return reject();
  return input;
};
const own = (input: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return reject();
  return descriptor.value;
};
const project = (input: unknown, keys: readonly string[], required = true): Record<string, unknown> => {
  const source = plain(input), result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor && !required) continue;
    result[key] = own(source, key);
  }
  return result;
};
const list = (input: unknown, cap: number): string[] => {
  if (types.isProxy(input) || !Array.isArray(input)) return reject();
  const length = Object.getOwnPropertyDescriptor(input, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > cap) return reject();
  if (Object.getPrototypeOf(input) !== Array.prototype) return reject();
  const result: string[] = [];
  for (let i = 0; i < length.value; i++) result.push(dreamScalar(own(input, String(i))));
  return result;
};
const count = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) return reject();
  return input;
};
const hash = (input: unknown): string => {
  if (typeof input !== "string" || input.length !== 64 || !/^[a-f0-9]{64}$/.test(input)) return reject();
  return input;
};
const equal = (a: unknown, b: unknown, cap: number): boolean => Buffer.from(dreamBytes(a, cap)).equals(dreamBytes(b, cap));

/** Fixed-descriptor projection only. Unknown caller keys are never enumerated. */
export function validateDreamPlan(input: unknown): Result<DreamPlan> {
  try {
    const source = plain(input), algorithm = dreamScalar(own(source, "algorithm"));
    if (algorithm !== "ether.dream.v1") return err("UNSUPPORTED_SCHEMA", "Unsupported Dream algorithm.");
    const raw = project(source, ["planId", "asOf", "selector", "selectedSourceIds", "selectedCount", "knownCount",
      "selectionTruncated", "truncationReasons", "dependencyDigest", "budgets", "graph"]);
    const planId = hash(raw.planId), dependencyDigest = hash(raw.dependencyDigest), asOf = dreamEpoch(raw.asOf);
    const budgetKeys = Object.keys(DREAM_BUDGETS) as Array<keyof DreamBudgets>;
    const budgetInput = project(raw.budgets, budgetKeys), budgets = { ...DREAM_BUDGETS };
    for (const key of budgetKeys) {
      const requested = budgetInput[key];
      if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1 || requested > DREAM_BUDGETS[key]) reject();
      budgets[key] = requested as number;
    }
    const selectedSourceIds = list(raw.selectedSourceIds, budgets.maxSources);
    for (let i = 1; i < selectedSourceIds.length; i++) if (codeUnitCompare(selectedSourceIds[i - 1], selectedSourceIds[i]) >= 0) reject();
    const selectedCount = count(raw.selectedCount), knownCount = count(raw.knownCount);
    if (typeof raw.selectionTruncated !== "boolean") reject();
    const selectionTruncated = raw.selectionTruncated as boolean, reasons = list(raw.truncationReasons, 1);
    const graphInput = project(raw.graph, ["relationshipCount"]), relationshipCount = count(graphInput.relationshipCount);
    if (selectedCount !== selectedSourceIds.length || selectedCount !== Math.min(knownCount, budgets.maxSources)
      || selectionTruncated !== (knownCount > selectedCount)
      || reasons.length !== (selectionTruncated ? 1 : 0) || (reasons.length === 1 && reasons[0] !== "source-limit")
      || relationshipCount > budgets.maxRelationships || relationshipCount > selectedCount ** 2) reject();

    // Project every recognized selector field before T3 normalization. No raw
    // caller array, prototype, iterator, accessor or unknown key reaches it.
    const selectorInput = project(raw.selector, ["kind", "ids", "tags", "query", "from", "to"], false);
    selectorInput.kind = dreamScalar(selectorInput.kind);
    for (const key of ["ids", "tags"] as const) if (Object.hasOwn(selectorInput, key)) selectorInput[key] = list(selectorInput[key], 256);
    if (Object.hasOwn(selectorInput, "query")) selectorInput.query = dreamScalar(selectorInput.query, 4096);
    for (const key of ["from", "to"] as const) if (Object.hasOwn(selectorInput, key)) selectorInput[key] = dreamEpoch(selectorInput[key]);
    const request = normalizeDreamRequest(selectorInput, { asOf, budgets });
    if (!equal(selectorInput, request.selector, budgets.maxPlanBytes)) reject();
    if (request.selector.kind === "ids") {
      if (knownCount !== request.selector.ids.length || !equal(selectedSourceIds, request.selector.ids.slice(0, budgets.maxSources), budgets.maxPlanBytes)) reject();
    } else if (knownCount > budgets.maxPopulation) reject();

    const plan: DreamPlan = { algorithm, planId, asOf, selector: request.selector, selectedSourceIds,
      selectedCount, knownCount, selectionTruncated, truncationReasons: selectionTruncated ? ["source-limit"] : [],
      dependencyDigest, budgets: request.budgets, graph: { relationshipCount } };
    dreamBytes(plan, budgets.maxPlanBytes);
    return ok(plan);
  } catch {
    return err("INVALID_INPUT", "Invalid Dream plan.");
  }
}
