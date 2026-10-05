import { ok, type Result } from "../utils/result.js";
import type { CommittedTip } from "../types/persistence.js";
import type { PersistedStoreHead } from "./codecs.js";
import { scanWal } from "./wal.js";
import { detachedState, type ReplayRegistry } from "./walOperations.js";
import type { JsonObject } from "./walJson.js";

export interface DetachedReplay {
  readonly state: JsonObject;
  readonly tip: CommittedTip;
  readonly tail: "none" | "incomplete";
  readonly duplicates: number;
}

/**
 * Validate the entire bounded batch before invoking any trusted reducer. Work only
 * on detached, frozen JSON state. Failure exposes no partially reduced state.
 * No Core APIs, live publication, application hooks, generated values or receipts.
 */
export function replayWal(bytes: Uint8Array, head: PersistedStoreHead, initialState: JsonObject, registry: ReplayRegistry): Result<DetachedReplay> {
  const scanned = scanWal(bytes, head, registry);
  if (!scanned.ok) return scanned;
  const cloned = detachedState(initialState);
  if (!cloned.ok) return cloned;
  let state = cloned.value;
  for (const transaction of scanned.value.transactions) {
    for (const operation of transaction.operations) {
      const reduced = registry.reduce(state, operation);
      if (!reduced.ok) return reduced;
      state = reduced.value;
    }
  }
  return ok(Object.freeze({ state, tip: scanned.value.tip, tail: scanned.value.tail, duplicates: scanned.value.duplicates }));
}
