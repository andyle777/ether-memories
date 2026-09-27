import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FsDurableStore } from "../dist/persistence/FsDurableStore.js";
import { FsWalStore } from "../dist/persistence/FsWalStore.js";
import { WalFileScan } from "../dist/persistence/walFileScan.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";
import { createReplayRegistry } from "../dist/persistence/walOperations.js";
import { encodeWalFrame, scanWal } from "../dist/persistence/wal.js";
import { encodeCheckpoint, HEAD_FORMAT, HEAD_VERSION, DIGEST_ALGORITHM } from "../dist/persistence/codecs.js";
import { STORE_SCHEMA_VERSION, parseTransactionSequenceId } from "../dist/index.js";

const value = result => { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; };
const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
const directoryIO = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;
const registry = value(createReplayRegistry([{ type: "probe.set", version: "1",
  validate: p => typeof p.text === "string" ? { ok: true, value: undefined } : { ok: false, error: { code: "PERSISTENCE_CORRUPTION", message: "text required" } },
  reduce: (_state, payload) => ({ ok: true, value: payload }) }]));
const anchor = { epochId: "epoch-probe", txId: value(parseTransactionSequenceId("9007199254740993")), digest: "a".repeat(64) };
const checkpoint = value(encodeCheckpoint({ storeId: "store-probe", checkpointId: "checkpoint-probe", tip: anchor }, Buffer.from('{"schemaVersion":"ether.memory_store.v0.3"}')));
const head = { format: HEAD_FORMAT, version: HEAD_VERSION, storeId: "store-probe", epochId: anchor.epochId,
  schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM, checkpoint: checkpoint.identity, walFormat: { format: "ether.wal", version: "1" } };
const input = (base, id, text = "X".repeat(4400)) => ({ expectedBase: base,
  mutation: { mutationId: id, digest: createHash("sha256").update(text).digest("hex") }, operations: [{ type: "probe.set", version: "1", payload: { text } }] });
const frame = request => value(encodeWalFrame({ ...request, storeId: head.storeId, format: head.walFormat, audit: null,
  identity: { epochId: request.expectedBase.epochId, txId: value(parseTransactionSequenceId((BigInt(request.expectedBase.txId) + 1n).toString())) } }, registry));
const parent = await fs.mkdtemp(join(tmpdir(), "ether-wal4-probe-"));
try {
  const directory = join(parent, "store");
  value(await new FsDurableStore({ directory }, directoryIO).initialize({ head, checkpointBytes: checkpoint.bytes }));
  const path = join(directory, "wal", `wal-${checkpoint.identity.digest}.bin`);
  let loseAck = false;
  const io = { ...nodeWalIO, open: async (p, c) => {
    const handle = await nodeWalIO.open(p, c);
    return { ...handle, sync: async () => { await handle.sync(); if (loseAck) { loseAck = false; throw new Error("lost acknowledgment after file sync"); } } };
  } };
  const store = new FsWalStore({ directory, registry }, directoryIO, io);
  let tip = anchor;
  let ambiguousRetries = 0;
  let staleAttempts = 0;
  for (let i = 0; i < 2200; i++) {
    const request = input(tip, `mutation-${i}`);
    if (i > 0 && i % 400 === 0) {
      const stale = await store.commit(input(anchor, `stale-${i}`));
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "STALE_TRANSACTION_BASE");
      staleAttempts++;
    }
    if (i > 0 && i % 500 === 0) loseAck = true;
    let result = await store.commit(request);
    if (!result.ok) {
      assert.equal(result.error.code, "RECOVERY_REQUIRED");
      assert.equal(result.error.details.outcome, "reconciliation-required");
      result = await store.commit(request);
      assert.equal(value(result).status, "already-committed");
      ambiguousRetries++;
    }
    const receipt = value(result);
    assert.equal(receipt.identity.txId, (BigInt(tip.txId) + 1n).toString());
    tip = receipt.identity;
    if ((i + 1) % 500 === 0) console.log(`Committed ${i + 1} exact successors`);
  }
  const size = (await fs.stat(path)).size;
  assert.ok(size > 8 * 1024 * 1024);
  const scans = [];
  for (const chunkBytes of [4096, 65536, 8 * 1024 * 1024]) {
    const handle = await nodeWalIO.open(path, false);
    try {
      const scan = value(await WalFileScan.open(path, handle, head, registry, nodeWalIO, { mode: "advisory" }, chunkBytes));
      let cursor = scan.cursor();
      let calls = 0;
      let transactions = 0;
      while (!cursor.ended) {
        const batch = value(await scan.next(cursor));
        cursor = batch.continuation;
        transactions += batch.transactions.length;
        calls++;
      }
      assert.equal(transactions, 2200);
      assert.equal(cursor.completeBytes, size);
      assert.deepEqual(cursor.tip, tip);
      scans.push({ chunkBytes, calls, transactions });
    } finally { await handle.close(); }
  }
  assert.deepEqual(value(await new FsWalStore({ directory, registry }, directoryIO).readTip()), tip);
  let seed = 0x12345678;
  for (let i = 0; i < 16; i++) {
    const dir = join(parent, `tail-${i}`);
    value(await new FsDurableStore({ directory: dir }, directoryIO).initialize({ head, checkpointBytes: checkpoint.bytes }));
    const first = frame(input(anchor, "first", "A"));
    const next = frame(input(first.transaction.identity, "second", "B"));
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const cut = 1 + seed % (next.bytes.length - 1);
    const bytes = Buffer.concat([first.bytes, next.bytes.subarray(0, cut)]);
    const wal = join(dir, "wal", `wal-${checkpoint.identity.digest}.bin`);
    await fs.writeFile(wal, bytes);
    const scan = value(scanWal(bytes, head, registry));
    assert.equal(scan.tail, "incomplete");
    assert.deepEqual(scan.tip, first.transaction.identity);
    const refused = await new FsWalStore({ directory: dir, registry }, directoryIO).commit(input(first.transaction.identity, "new", "C"));
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "RECOVERY_REQUIRED");
    assert.deepEqual(await fs.readFile(wal), bytes);
  }
  console.log(JSON.stringify({ sequentialCommits: 2200, walBytes: size, finalTxId: tip.txId, staleAttempts,
    ambiguousRetries, randomPartialTailsRefused: 16, reopenScans: scans, simulatedDirectoryBarriers: simulate,
    nativePowerLossClaim: false }, null, 2));
} finally {
  if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-wal4-probe-")) throw new Error("Unsafe cleanup path");
  await fs.rm(parent, { recursive: true, force: true });
}
