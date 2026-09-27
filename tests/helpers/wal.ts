import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { CommittedTip, MutationId } from "../../src/types/persistence.js";
import { parseTransactionSequenceId } from "../../src/utils/durablePersistence.js";
import { ok, err } from "../../src/utils/result.js";
import { nodeDirectoryIO, type DirectoryIO } from "../../src/persistence/directoryIO.js";
import { encodeWalFrame } from "../../src/persistence/wal.js";
import { createReplayRegistry } from "../../src/persistence/walOperations.js";
import type { CommitRequest } from "../../src/persistence/FsWalStore.js";
import { fixture, value } from "./persistence.js";

export const registry = value(createReplayRegistry([{ type: "test.set", version: "1",
  validate: p => typeof p.text === "string" && Object.keys(p).length === 1 ? ok(undefined) : err("PERSISTENCE_CORRUPTION", "Invalid text payload"),
  reduce: (_s, p) => ok(p) }]));
export function request(base: CommittedTip = fixture().head.checkpoint.tip, id = "mutation-a", text = "A"): CommitRequest {
  return { expectedBase: base, mutation: { mutationId: id as MutationId, digest: createHash("sha256").update(text).digest("hex") },
    operations: [{ type: "test.set", version: "1", payload: { text } }] };
}
export function frame(input: CommitRequest = request()) {
  return value(encodeWalFrame({ ...input, storeId: fixture().head.storeId, format: { format: "ether.wal", version: "1" },
    identity: { epochId: input.expectedBase.epochId, txId: value(parseTransactionSequenceId((BigInt(input.expectedBase.txId) + 1n).toString())) }, audit: null }, registry));
}
export function history(count: number, text = "A") {
  let tip = fixture().head.checkpoint.tip;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const encoded = frame(request(tip, `mutation-${i}`, text));
    frames.push(encoded);
    tip = encoded.transaction.identity;
  }
  return { bytes: Buffer.concat(frames.map(f => f.bytes)), tip, frames };
}
/** Real file IO; only directory barriers/activation are simulated, never native durability evidence. */
export const simulatedDirectoryIO = (): DirectoryIO => ({ ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } });
