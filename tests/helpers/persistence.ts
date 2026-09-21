import { DIGEST_ALGORITHM, HEAD_FORMAT, PERSISTENCE_VERSION, STORE_SCHEMA_VERSION,
  WAL_FORMAT, encodeCheckpoint, parseTransactionSequenceId, type PersistedStoreHead, type Result } from "../../src/index.js";

export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export function fixture(txId = "9007199254740993") {
  const payload = Buffer.from('{ "schemaVersion": "ether.memory_store.v0.3" }\n', "utf8");
  const tip = { epochId: "epoch-a", txId: value(parseTransactionSequenceId(txId)), digest: "a".repeat(64) };
  const checkpoint = value(encodeCheckpoint({ storeId: "store-a", checkpointId: "checkpoint-a", tip }, payload));
  const head: PersistedStoreHead = { format: HEAD_FORMAT, version: PERSISTENCE_VERSION, storeId: "store-a", epochId: tip.epochId,
    schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM, checkpoint: checkpoint.identity,
    walFormat: { format: WAL_FORMAT, version: PERSISTENCE_VERSION } };
  return { head, checkpointBytes: checkpoint.bytes, payload };
}
