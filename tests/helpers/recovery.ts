import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsDurableStore } from "../../src/persistence/FsDurableStore.js";
import { encodeCheckpoint, type PersistedStoreHead } from "../../src/persistence/codecs.js";
import { encodeSnapshotPayload, hydrateSnapshot } from "../../src/persistence/snapshotPayload.js";
import { encodeEtherData, ETHER_DATA_PROFILE } from "../../src/persistence/etherData.js";
import { encodeWalFrame } from "../../src/persistence/wal.js";
import { productionRegistry, type SemanticOperation } from "../../src/persistence/productionOperations.js";
import { parseTransactionSequenceId } from "../../src/utils/durablePersistence.js";
import type { CommittedTip, MutationId } from "../../src/types/persistence.js";
import { value } from "./persistence.js";
import { simulatedDirectoryIO } from "./wal.js";

export const sourceSnapshot = () => JSON.parse(readFileSync(new URL("../fixtures/store-v0.3.json", import.meta.url), "utf8"));
export const semanticNote = (content = "Termux recovered") => ({ ...sourceSnapshot().memoryNotes[0], content, metadata: {} });
export const notePut = (content?: string): SemanticOperation => ({ type: "ether.note.put", version: "1", payload: semanticNote(content) });
export const mutationId = (id: string) => id as MutationId;
export async function bootstrap(raw = sourceSnapshot()) {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-recovery-"));
  const directory = join(parent, "store");
  const io = simulatedDirectoryIO();
  const tip = { epochId: "epoch-a", txId: value(parseTransactionSequenceId("9007199254740993")), digest: "0".repeat(64) };
  const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
  const payload = value(encodeSnapshotPayload(snapshot));
  const checkpoint = value(encodeCheckpoint({ storeId: "store-a", checkpointId: "checkpoint-a", tip }, payload));
  const head: PersistedStoreHead = { format: "ether.store_head", version: "1", storeId: "store-a", epochId: tip.epochId,
    schemaVersion: raw.schemaVersion, digestAlgorithm: "sha256", checkpoint: checkpoint.identity, walFormat: { format: "ether.wal", version: "1" } };
  value(await new FsDurableStore({ directory }, io).initialize({ head, checkpointBytes: checkpoint.bytes }));
  return { parent, directory, io, head, tip, snapshot, walPath: join(directory, "wal", "wal-" + checkpoint.identity.digest + ".bin") };
}
export function semanticFrame(base: CommittedTip, operations: SemanticOperation[] = [notePut()], id = "mutation-a",
  mutationDigest = "1".repeat(64)) {
  return value(encodeWalFrame({ storeId: "store-a", format: { format: "ether.wal", version: "1" },
    expectedBase: base, identity: { epochId: base.epochId, txId: value(parseTransactionSequenceId((BigInt(base.txId) + 1n).toString())) },
    mutation: { mutationId: mutationId(id), digest: mutationDigest }, audit: null,
    operations: operations.map(op => ({ type: op.type, version: op.version, payload: {
      encoding: ETHER_DATA_PROFILE, data: Buffer.from(value(encodeEtherData(op.payload))).toString("utf8") } }))
  }, productionRegistry));
}

/** Identity replacement keeps the candidate small for long WAL histories. */
export function identityPut(): SemanticOperation {
  return { type: "ether.identity.put", version: "1",
    payload: { userId: "fixture-user", createdAt: "2020-01-01T00:00:00.000Z", lastActive: "2020-01-02T00:00:00.000Z" } };
}
