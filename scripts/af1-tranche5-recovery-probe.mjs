import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
// Compiled production modules only; never tests/ or src/ development imports.
import * as publicApi from "../dist/index.js";
import { FsDurableStore } from "../dist/persistence/FsDurableStore.js";
import { ProductionWalStore } from "../dist/persistence/productionOperations.js";
import { StartupRecovery } from "../dist/persistence/StartupRecovery.js";
import { hydrateSnapshot, encodeSnapshotPayload } from "../dist/persistence/snapshotPayload.js";
import { encodeCheckpoint } from "../dist/persistence/codecs.js";
import { nodeDirectoryIO } from "../dist/persistence/directoryIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Native Windows directory durability is unavailable; explicitly select --simulate-directory-barriers for protocol testing.");
const io = simulate ? { ...nodeDirectoryIO, syncDirectory: async () => {},
  activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } } : nodeDirectoryIO;

// Package public-surface gate: internal helpers must not leak into the root.
for (const name of ["prepareSnapshot", "commitSnapshot", "hydrateSnapshot", "encodeSnapshotPayload",
  "reduceProduction", "StartupRecovery", "ProductionWalStore", "DiskBackedMutationIndex"]) {
  assert.equal(name in publicApi, false, `package root must not export ${name}`);
}

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/store-v0.3.json", import.meta.url), "utf8"));
const numericArgument = process.argv.slice(2).find(a => /^\d+$/.test(a));
const transactionCount = Number(numericArgument ?? 1050);
assert.ok(Number.isSafeInteger(transactionCount) && transactionCount > 1024 && transactionCount <= 2048);
const parent = await fs.mkdtemp(join(tmpdir(), "ether-t5-probe-"));
try {
  const directory = join(parent, "store");
  const anchor = { epochId: "probe-epoch", txId: "9007199254740993", digest: "0".repeat(64) };
  const snapshot = value(hydrateSnapshot(fixture, fixture.identity.userId));
  const checkpoint = value(encodeCheckpoint({ storeId: "probe-store", checkpointId: "checkpoint-a", tip: anchor },
    value(encodeSnapshotPayload(snapshot))));
  const head = { format: "ether.store_head", version: "1", storeId: "probe-store", epochId: anchor.epochId,
    schemaVersion: snapshot.schemaVersion, digestAlgorithm: "sha256", checkpoint: checkpoint.identity,
    walFormat: { format: "ether.wal", version: "1" } };
  value(await new FsDurableStore({ directory }, io).initialize({ head, checkpointBytes: checkpoint.bytes }));
  const writer = new ProductionWalStore(directory, io);
  let tip = anchor;
  const startCommit = performance.now();
  for (let i = 0; i < transactionCount; i++) {
    // First mutation is external-object-backed; the rest stay inline-bounded.
    const content = i === 0 ? "O".repeat(80000) : "W".repeat(8200) + String(i).padStart(4, "0");
    const note = { ...structuredClone(fixture.memoryNotes[0]), content, metadata: { sequence: i } };
    const receipt = value(await writer.commit(tip, "probe-mutation-" + i,
      [{ type: "ether.note.put", version: "1", payload: note }]));
    assert.equal(receipt.status, "committed");
    tip = receipt.identity;
  }
  const walPath = join(directory, "wal", "wal-" + checkpoint.identity.digest + ".bin");
  const walBefore = await fs.readFile(walPath);
  const objects = await fs.readdir(join(directory, "objects"));
  let objectBytes = 0;
  for (const name of objects) objectBytes += (await fs.stat(join(directory, "objects", name))).size;
  assert.ok(walBefore.length > 8 * 1024 * 1024, "WAL must exceed one streaming batch");
  assert.ok(objects.length > 0, "At least one external payload object must exist");

  const results = [];
  let baseline;
  for (let restart = 0; restart < 3; restart++) {
    let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
    const sample = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
    }, 20);
    const runtime = new StartupRecovery(directory, fixture.identity.userId, io);
    const start = performance.now();
    let receipt;
    try { receipt = value(await runtime.recover()); } finally { clearInterval(sample); }
    const state = value(runtime.read());
    const bytes = value(encodeSnapshotPayload(state.snapshot));
    assert.equal(receipt.transactions, transactionCount);
    assert.deepEqual(state.tip, tip);
    assert.deepEqual(receipt.tip, tip);
    assert.equal(state.snapshot.memoryNotes.find(x => x.id === "alpha").content,
      "W".repeat(8200) + String(transactionCount - 1).padStart(4, "0"));
    if (!baseline) baseline = bytes; else assert.deepEqual(bytes, baseline);
    assert.deepEqual(await fs.readFile(walPath), walBefore);
    results.push({ restart: restart + 1, recoveryMs: Math.round(performance.now() - start),
      peakRss, peakHeap, snapshotBytes: bytes.length, tip: state.tip.txId });
  }
  console.log(JSON.stringify({ transactions: transactionCount, walBytes: walBefore.length,
    objectCount: objects.length, objectBytes, commitSeconds: +((performance.now() - startCommit) / 1000).toFixed(1),
    restarts: results }, null, 2));
  console.log("TRANCHE5 PRODUCTION RECOVERY PROBE: PASS");
} finally { await fs.rm(parent, { recursive: true, force: true }); }
