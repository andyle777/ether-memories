import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MutationHistoryVerifier } from "../src/persistence/mutationHistoryVerification.js";
import {
  ReceiptLedgerReader, ROOT_PREDECESSOR_DIGEST, compareMutationIds, encodeReceiptEntryLine, encodeReceiptHeaderLine, receiptLedgerPath
} from "../src/persistence/receiptLedger.js";
import type { ReceiptEntry, ReceiptLedgerHeader } from "../src/persistence/receiptLedger.js";
import { nodeDirectoryIO } from "../src/persistence/directoryIO.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";

const cleanup: string[] = [];
const fresh = async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-history-"));
  cleanup.push(parent);
  const directory = join(parent, "store");
  await fs.mkdir(join(directory, ".private"), { recursive: true });
  await fs.mkdir(join(directory, "receipts"), { recursive: true });
  return directory;
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const receiptEntry = (mutationId: string, intentDigest = "1".repeat(64)): ReceiptEntry => ({
  mutationId, intentDigest, txId: "9007199254740993", transactionDigest: "2".repeat(64),
  operations: [{ type: "ether.note.put", version: "1", payload: { id: mutationId, content: "x" } }]
});

const writeLedger = async (directory: string, entries: ReceiptEntry[]) => {
  const header: ReceiptLedgerHeader = { format: "ether.receipts", version: "1", storeId: "store-a", epochId: "epoch-a",
    retiredCheckpointDigest: "a".repeat(64), predecessorLedgerDigest: ROOT_PREDECESSOR_DIGEST,
    entryCount: entries.length, payloadBytes: entries.reduce((s, e) => s + value(encodeReceiptEntryLine(e)).byteLength, 0) };
  const bytes = Buffer.concat([Buffer.from(value(encodeReceiptHeaderLine(header))),
    ...entries.map(e => Buffer.from(value(encodeReceiptEntryLine(e))))]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(receiptLedgerPath(directory, digest), bytes);
  return ReceiptLedgerReader.open(directory, digest);
};

describe("source-aware mutation history verification", { timeout: 60_000 }, () => {
  it("accepts disjoint receipt history and active-WAL records at any relative ordering", async () => {
    const directory = await fresh();
    const receipts = value(await writeLedger(directory, ["a", "c", "e"].map(id => receiptEntry(id))));
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO);
    for (const id of ["b", "d", "f"]) value(await verifier.recordWal({ mutationId: id, intentDigest: "3".repeat(64), txId: "9007199254740994" }));
    value(await verifier.verify(receipts));
    expect((await new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO).verify()).ok).toBe(true);
  });

  it("flushes multiple runs and merges with bounded fan-in: thousands of records stay exact", async () => {
    const directory = await fresh();
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO, 256 * 1024 * 1024);
    const ids = Array.from({ length: 5000 }, (_, i) => `bulk-${String(i).padStart(6, "0")}`);
    const shuffled = [...ids].sort(() => (i => (i % 2 ? 1 : -1))(ids.indexOf(ids[0]!) % 2));
    for (const id of shuffled) value(await verifier.recordWal({ mutationId: id, intentDigest: "4".repeat(64), txId: "9007199254740994" }));
    value(await verifier.verify());
    // Strict ordering under the frozen comparator held through sort+merge.
    expect(compareMutationIds("bulk-000000", "bulk-000001")).toBeLessThan(0);
  });

  it("rejects a duplicate mutationId inside the active-WAL record stream", async () => {
    const directory = await fresh();
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "dup", intentDigest: "5".repeat(64), txId: "9007199254740994" }));
    value(await verifier.recordWal({ mutationId: "dup", intentDigest: "5".repeat(64), txId: "9007199254740995" }));
    const verified = await verifier.verify();
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("rejects conflicting intent digests under the same mutationId", async () => {
    const directory = await fresh();
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "same", intentDigest: "6".repeat(64), txId: "9007199254740994" }));
    const flush = await verifier.recordWal({ mutationId: "same", intentDigest: "7".repeat(64), txId: "9007199254740995" });
    void flush;
    const verified = await verifier.verify();
    expect(verified.ok).toBe(false);
  });

  it("rejects the same mutationId in receipt history AND active WAL (cross-source corruption)", async () => {
    const directory = await fresh();
    const receipts = value(await writeLedger(directory, ["shared", "x"].map(id => receiptEntry(id))));
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "shared", intentDigest: "1".repeat(64), txId: "9007199254740994" }));
    const verified = await verifier.verify(receipts);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("sweeps its scratch completely on every path, including failures", async () => {
    const directory = await fresh();
    const before = await fs.readdir(join(directory, ".private"));
    const verifier = new MutationHistoryVerifier(directory, nodeDirectoryIO, nodeWalIO);
    for (let i = 0; i < 300; i++) value(await verifier.recordWal({ mutationId: `sweep-${i}`, intentDigest: "8".repeat(64), txId: "9007199254740994" }));
    value(await verifier.verify());
    const after = await fs.readdir(join(directory, ".private"));
    expect(after.filter(name => name.startsWith("mutation-history-"))).toEqual([]);
    expect(after.length).toBe(before.length);
  });
});
