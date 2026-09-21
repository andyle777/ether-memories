import type { CommittedTip, DurableStorageOperations, StoragePort, TransactionSequenceId } from "../types/index.js";
import { err, ok, type Result } from "./result.js";

/** Accept exact canonical text only; never coerce a potentially rounded number. */
export const parseTransactionSequenceId = (value: unknown): Result<TransactionSequenceId> => {
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/.test(value) ||
    (value.length > 1 && value[0] === "0")) {
    return err("INVALID_INPUT", "Transaction sequence ID must be canonical unsigned decimal text.");
  }
  return ok(value as TransactionSequenceId);
};

export const sameCommittedTip = (a: CommittedTip, b: CommittedTip): boolean =>
  a.epochId === b.epochId && a.txId === b.txId && a.digest === b.digest;

export const getDurableOperations = (storage: StoragePort): Result<DurableStorageOperations> =>
  storage.durable
    ? ok(storage.durable)
    : err("DURABILITY_UNAVAILABLE", "StoragePort does not provide durable operations.");
