import type { WalOperation } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { canonicalJson, decodeCanonicalJson, freezeJson, isRecord, walCorruption, type JsonObject } from "./walJson.js";

export const operationType = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[a-z]/.test(value) && !/[^a-z0-9_.-]/.test(value);
export const operationVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 16 && /^[1-9]/.test(value) && !/[^0-9]/.test(value);

/**
 * Trusted, immutable type/version semantics, not user callbacks or dynamically loaded code.
 * Validators/reducers must be pure and synchronous: no clock, UUID, I/O, inferred
 * links, notifications, receipts, or additional operations. All values come from payload.
 */
export interface ReplayOperationDefinition {
  readonly type: string;
  readonly version: string;
  readonly validate: (payload: JsonObject) => Result<void>;
  readonly reduce: (state: JsonObject, payload: JsonObject) => Result<JsonObject>;
}

export interface ReplayRegistry {
  validate(operation: WalOperation): Result<void>;
  reduce(state: JsonObject, operation: WalOperation): Result<JsonObject>;
}

/** Detached replay harness bound, not a checkpoint or live StateRoot format limit. */
export const REPLAY_STATE_BOUNDS = Object.freeze({ bytes: 1024 * 1024, depth: 32, nodes: 65536 });

export function detachedState(state: unknown): Result<JsonObject> {
  const bytes = canonicalJson(state, REPLAY_STATE_BOUNDS);
  if (!bytes.ok) return bytes;
  const cloned = decodeCanonicalJson(bytes.value, REPLAY_STATE_BOUNDS);
  if (!cloned.ok) return cloned;
  if (!isRecord(cloned.value)) return walCorruption("Detached replay state must be an object.");
  return ok(freezeJson(cloned.value as JsonObject));
}

/** No production operation definitions are installed by default. Test operations live only in tests. */
export function createReplayRegistry(definitions: readonly ReplayOperationDefinition[] = []): Result<ReplayRegistry> {
  const entries = new Map<string, ReplayOperationDefinition>();
  for (const definition of definitions) {
    if (!operationType(definition.type) || !operationVersion(definition.version)
      || typeof definition.validate !== "function" || typeof definition.reduce !== "function") {
      return err("INVALID_INPUT", "Invalid replay operation definition.");
    }
    const key = definition.type + ":" + definition.version;
    if (entries.has(key)) return err("INVALID_INPUT", "Duplicate replay operation definition.");
    entries.set(key, Object.freeze({ ...definition }));
  }
  const lookup = (operation: WalOperation) => entries.get(operation.type + ":" + operation.version);
  return ok(Object.freeze({
    validate(operation: WalOperation): Result<void> {
      const definition = lookup(operation);
      if (!definition) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unknown committed operation type/version.");
      try {
        const result = definition.validate(operation.payload as JsonObject);
        if (!result || typeof result.ok !== "boolean") return walCorruption("Operation validator violated its synchronous contract.");
        return result;
      } catch { return walCorruption("Operation payload validation failed."); }
    },
    reduce(state: JsonObject, operation: WalOperation): Result<JsonObject> {
      const definition = lookup(operation);
      if (!definition) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unknown committed operation type/version.");
      try {
        const result = definition.reduce(state, operation.payload as JsonObject);
        if (!result || typeof result.ok !== "boolean") return walCorruption("Reducer violated its synchronous contract.");
        return result.ok ? detachedState(result.value) : result;
      } catch { return walCorruption("Deterministic reducer failed."); }
    }
  }));
}
