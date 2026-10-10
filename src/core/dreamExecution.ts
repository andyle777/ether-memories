import type { DreamCycleResult } from "../types/dreamAnalysis.js";
import { err, ok, type Result } from "../utils/result.js";
import { DreamInputError } from "./dreamRequest.js";
import { dreamBytes } from "./dreamSelection.js";
import { buildDreamPlan, captureDreamDependencies } from "./dreamPlan.js";
import { validateDreamPlan } from "./dreamValidation.js";
import { analyzeDreamSnapshot } from "./dreamAnalysis.js";

const stale = () => err("CONFLICT", "Dream plan is stale or does not match authoritative dependencies; preview again.");
const unexpected = () => err("UNKNOWN_ERROR", "Dream execution could not complete.");

/** Public runtime owns authority precedence; this pipeline has no write path. */
export function runDreamCycle(notesOwner: object, graphOwner: object, input: unknown): Result<DreamCycleResult> {
  const checked = validateDreamPlan(input);
  if (!checked.ok) return checked;
  const caller = checked.value;
  let capture, plan;
  try {
    capture = captureDreamDependencies(notesOwner, graphOwner, { selector: caller.selector, asOf: caller.asOf, budgets: caller.budgets });
    plan = buildDreamPlan(capture);
    // Caller digests are comparisons, never proof. Bind every recognized field
    // to the same bounded capture rather than comparing only hash strings.
    if (!Buffer.from(dreamBytes(caller, caller.budgets.maxPlanBytes)).equals(dreamBytes(plan, caller.budgets.maxPlanBytes))) return stale();
  } catch (error) {
    return error instanceof DreamInputError ? stale() : unexpected();
  }
  try {
    // No selector, requested-but-unselected IDs, population coverage, owner,
    // generation handle or live callback crosses the successful comparison.
    return ok(analyzeDreamSnapshot({ notes: capture.notes, relationships: capture.relationships },
      { algorithm: plan.algorithm, planId: plan.planId, dependencyDigest: plan.dependencyDigest, asOf: plan.asOf }));
  } catch {
    return unexpected();
  }
}
