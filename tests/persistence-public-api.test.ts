import { expect, it } from "vitest";
import * as publicApi from "../src/index.js";

// @ts-expect-error Wire types are internal, not package-root exports.
type Head = import("../src/index.js").PersistedStoreHead;
// @ts-expect-error Wire types are internal, not package-root exports.
type Limits = import("../src/index.js").PersistenceLimits;
// @ts-expect-error Wire types are internal, not package-root exports.
type LimitOptions = import("../src/index.js").PersistenceLimitOptions;
// @ts-expect-error Wire types are internal, not package-root exports.
type Checkpoint = import("../src/index.js").CheckpointMetadata;
// @ts-expect-error Layout types are internal, not package-root exports.
type Options = import("../src/index.js").FsDurableStoreOptions;
// @ts-expect-error Layout types are internal, not package-root exports.
type Inspection = import("../src/index.js").DurableStoreInspection;
// @ts-expect-error Layout types are internal, not package-root exports.
type Receipt = import("../src/index.js").HeadActivationReceipt;

it("does not publish internal persistence wire or layout operations at the package root", () => {
  for (const name of ["HEAD_FORMAT", "CHECKPOINT_FORMAT", "PERSISTENCE_VERSION", "WAL_FORMAT", "DIGEST_ALGORITHM",
    "PERSISTENCE_LIMITS", "persistenceLimits", "encodeStoreHead", "decodeStoreHead", "encodeCheckpoint",
    "verifyCheckpoint", "FsDurableStore", "HEAD_VERSION", "CHECKPOINT_VERSION", "WAL_VERSION"]) {
    expect(Object.hasOwn(publicApi, name), name).toBe(false);
  }
  expect(publicApi.parseTransactionSequenceId("1").ok).toBe(true);
  expect(typeof publicApi.getDurableOperations).toBe("function");
});
