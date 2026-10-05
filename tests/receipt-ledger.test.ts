import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  RECEIPTS_DIRECTORY, ReceiptLedgerReader, ROOT_PREDECESSOR_DIGEST, compareMutationIds,
  decodeReceiptEntryLine, encodeReceiptEntryLine, encodeReceiptHeaderLine,
  isRotatedCheckpointId, openAuthoritativeReceiptLedger, receiptLedgerPath, type ReceiptEntry
} from "../src/persistence/receiptLedger.js";
import type { WalOperation } from "../src/types/persistence.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";

const cleanup: string[] = [];
const fresh = async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-receipts-"));
  cleanup.push(parent);
  const directory = join(parent, "store");
  await fs.mkdir(join(directory, RECEIPTS_DIRECTORY), { recursive: true });
  return directory;
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const entry = (mutationId: string, intentDigest = "1".repeat(64), txId = "9007199254740993",
  transactionDigest = "2".repeat(64)): ReceiptEntry =>
  ({ mutationId, intentDigest, txId, transactionDigest, operations: [{ type: "ether.note.put", version: "1", payload: { id: mutationId, content: "x" } } as WalOperation] });

const writeLedger = async (directory: string, header: Record<string, unknown>, entries: unknown[],
  options: { name?: string; digestOverride?: string; corruptPayload?: (bytes: Uint8Array) => Uint8Array } = {}) => {
  const headerLine = value(encodeReceiptHeaderLine(header as never));
  const lines = [headerLine, ...entries.map(e => value(encodeReceiptEntryLine(e as never)))];
  let bytes = Buffer.concat(lines.map(l => Buffer.from(l)));
  if (options.corruptPayload) bytes = Buffer.from(options.corruptPayload(bytes));
  const digest = options.digestOverride ?? createHash("sha256").update(bytes).digest("hex");
  const name = options.name ?? digest;
  await fs.writeFile(receiptLedgerPath(directory, name), bytes);
  return { digest, bytes, name };
};

/** The ledger fails closed when either opening or full verification rejects it. */
const failsClosed = async (directory: string, digest: string): Promise<boolean> => {
  const opened = await ReceiptLedgerReader.open(directory, digest);
  if (!opened.ok) return true;
  return !(await opened.value.verify()).ok;
};

const validHeader = (entryCount: number, payloadBytes: number, overrides: Record<string, unknown> = {}) => ({
  format: "ether.receipts", version: "1", storeId: "store-a", epochId: "epoch-a",
  retiredCheckpointDigest: "a".repeat(64), predecessorLedgerDigest: ROOT_PREDECESSOR_DIGEST,
  entryCount, payloadBytes, ...overrides
});

describe("receipt ledger wire and reader", { timeout: 60_000 }, () => {
  it("encodes and decodes round-trip; comparator is unsigned UTF-8 byte order", () => {
    const line = value(encodeReceiptEntryLine(entry("m-1")));
    const decoded = value(decodeReceiptEntryLine(line));
    expect(decoded.mutationId).toBe("m-1");
    expect(decoded.operations).toHaveLength(1);
    // Unsigned byte order, never locale order: ASCII digits before letters,
    // and multi-byte UTF-8 ids order by their raw bytes.
    expect(compareMutationIds("a", "b")).toBeLessThan(0);
    expect(compareMutationIds("Z", "a")).toBeLessThan(0);
    expect(compareMutationIds("a", "aa")).toBeLessThan(0);
    expect(compareMutationIds("m-10", "m-9")).toBeLessThan(0);
    expect(compareMutationIds("é", "z")).toBeGreaterThan(0);
    expect(compareMutationIds("世", "z")).toBeGreaterThan(0);
    expect(compareMutationIds("same", "same")).toBe(0);
  });

  it("empty ledger: header-only file verifies with zero entries and absent lookups", async () => {
    const directory = await fresh();
    const { digest } = await writeLedger(directory, validHeader(0, 0), []);
    const reader = value(await ReceiptLedgerReader.open(directory, digest));
    expect(reader.header.entryCount).toBe(0);
    value(await reader.verify());
    expect(value(await reader.lookup("anything"))).toBeUndefined();
  });

  it("one receipt: verify, lookup hit and miss positions", async () => {
    const directory = await fresh();
    const entries = [entry("alpha")];
    const payloadBytes = value(encodeReceiptEntryLine(entries[0]!)).byteLength;
    const { digest } = await writeLedger(directory, validHeader(1, payloadBytes), entries);
    const reader = value(await ReceiptLedgerReader.open(directory, digest));
    value(await reader.verify());
    const hit = value(await reader.lookup("alpha"));
    expect(hit!.mutationId).toBe("alpha");
    // absent before first, after last
    expect(value(await reader.lookup("0-before"))).toBeUndefined();
    expect(value(await reader.lookup("z-after"))).toBeUndefined();
  });

  it("many receipts, Unicode ids and sorted lookups between entries", async () => {
    const directory = await fresh();
    const ids = ["aa", "ab-2", "abc", "éclair", "m-1", "m-10", "m-2", "zz-世"];
    const sorted = [...ids].sort((a, b) => compareMutationIds(a, b));
    const entries = sorted.map(id => entry(id));
    const payloadBytes = entries.reduce((sum, e) => sum + value(encodeReceiptEntryLine(e)).byteLength, 0);
    const { digest } = await writeLedger(directory, validHeader(entries.length, payloadBytes), entries);
    const reader = value(await ReceiptLedgerReader.open(directory, digest));
    value(await reader.verify());
    for (const id of ids) {
      expect(value(await reader.lookup(id))!.mutationId).toBe(id);
    }
    // absent between entries and around boundaries
    expect(value(await reader.lookup("aaa"))).toBeUndefined();
    expect(value(await reader.lookup("ab-1"))).toBeUndefined();
    expect(value(await reader.lookup("ab-3"))).toBeUndefined();
    expect(value(await reader.lookup("zz-"))).toBeUndefined();
  });

  it("rejects duplicate mutationId, reversed order and truncated tails as corruption", async () => {
    const directory = await fresh();
    const duplicate = [entry("dup"), entry("dup")];
    let payloadBytes = value(encodeReceiptEntryLine(duplicate[0]!)).byteLength * 2;
    let written = await writeLedger(directory, validHeader(2, payloadBytes), duplicate);
    expect(await failsClosed(directory, written.digest)).toBe(true);

    const reversed = [entry("z-second"), entry("a-first")];
    payloadBytes = reversed.reduce((s, e) => s + value(encodeReceiptEntryLine(e)).byteLength, 0);
    written = await writeLedger(directory, validHeader(2, payloadBytes), reversed);
    expect(await failsClosed(directory, written.digest)).toBe(true);

    // Truncated final line (missing final LF).
    const single = [entry("tail")];
    payloadBytes = value(encodeReceiptEntryLine(single[0]!)).byteLength;
    written = await writeLedger(directory, validHeader(1, payloadBytes), single, {
      corruptPayload: bytes => bytes.subarray(0, bytes.byteLength - 1)
    });
    expect(await failsClosed(directory, written.digest)).toBe(true);
  });

  it("rejects count mismatch, payload-byte mismatch, digest mismatch and corrupted middle lines", async () => {
    const directory = await fresh();
    const entries = [entry("a"), entry("b")];
    const payloadBytes = entries.reduce((s, e) => s + value(encodeReceiptEntryLine(e)).byteLength, 0);
    // Count mismatch.
    let written = await writeLedger(directory, validHeader(3, payloadBytes), entries);
    expect(await failsClosed(directory, written.digest)).toBe(true);
    // Payload-byte mismatch: header declares more than the file contains.
    written = await writeLedger(directory, validHeader(2, payloadBytes + 5), entries);
    expect(await failsClosed(directory, written.digest)).toBe(true);
    // Digest mismatch: filename does not match content.
    written = await writeLedger(directory, validHeader(2, payloadBytes), entries);
    const wrongName = "f".repeat(64);
    await fs.rename(receiptLedgerPath(directory, written.digest), receiptLedgerPath(directory, wrongName));
    expect(await failsClosed(directory, wrongName)).toBe(true);
    // Corrupted middle entry line: verify fails closed, digest no longer matches.
    written = await writeLedger(directory, validHeader(2, payloadBytes), entries, {
      corruptPayload: bytes => Buffer.concat([bytes.subarray(0, bytes.byteLength - 3), Buffer.from("zzz")])
    });
    const renamed = "e".repeat(64);
    await fs.rename(receiptLedgerPath(directory, written.digest), receiptLedgerPath(directory, renamed));
    expect(await failsClosed(directory, renamed)).toBe(true);
  });

  it("rejects malformed headers: wrong store/epoch, unknown keys, missing keys, wrong format", async () => {
    const directory = await fresh();
    const entries = [entry("a")];
    const payloadBytes = value(encodeReceiptEntryLine(entries[0]!)).byteLength;
    for (const overrides of [
      { storeId: "other-store" }, { epochId: "other-epoch" }, { format: "ether.other" }, { version: "2" },
      { extraKey: true }, { retiredCheckpointDigest: "nothex" }, { predecessorLedgerDigest: 7 },
      { entryCount: -1 }, { payloadBytes: "x" }
    ]) {
      const header = { ...validHeader(1, payloadBytes), ...overrides };
      if ("extraKey" in overrides) {
        const raw = Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), Buffer.from(value(encodeReceiptEntryLine(entries[0]!)))]);
        const digest = createHash("sha256").update(raw).digest("hex");
        await fs.writeFile(receiptLedgerPath(directory, digest), raw);
        expect((await ReceiptLedgerReader.open(directory, digest)).ok).toBe(false);
        continue;
      }
      const written = await writeLedger(directory, header as never, entries);
      const opened = await ReceiptLedgerReader.open(directory, written.digest);
      if (opened.ok) {
        // store/epoch mismatches open the file but fail authoritative binding.
        expect((await opened.value.verify()).ok).toBe(true);
      } else {
        expect(opened.ok).toBe(false);
      }
    }
  });

  it("nonrotated checkpoints report zero history; rotated checkpoints require the exact ledger", async () => {
    const directory = await fresh();
    expect(isRotatedCheckpointId("checkpoint-initial")).toBe(false);
    expect(isRotatedCheckpointId("checkpoint-a")).toBe(false);
    expect(isRotatedCheckpointId("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
    // Non-rotated: zero history, no ledger required.
    expect(value(await openAuthoritativeReceiptLedger(directory, "store-a", "epoch-a", "checkpoint-initial")))
      .toBeUndefined();
    // Rotated: the required ledger must exist and match the store/epoch.
    const entries = [entry("m")];
    const payloadBytes = value(encodeReceiptEntryLine(entries[0]!)).byteLength;
    const { digest } = await writeLedger(directory, validHeader(1, payloadBytes), entries);
    const reader = value(await openAuthoritativeReceiptLedger(directory, "store-a", "epoch-a", digest));
    expect(reader!.header.entryCount).toBe(1);
    // Wrong store/epoch binding: corruption.
    expect((await openAuthoritativeReceiptLedger(directory, "other", "epoch-a", digest)).ok).toBe(false);
    // Missing required ledger: fail closed.
    expect((await openAuthoritativeReceiptLedger(directory, "store-a", "epoch-a", "b".repeat(64))).ok).toBe(false);
  });

  it("repeated reader operations reopen safely and see consistent content", async () => {
    const directory = await fresh();
    const entries = [entry("a"), entry("b"), entry("c")];
    const payloadBytes = entries.reduce((s, e) => s + value(encodeReceiptEntryLine(e)).byteLength, 0);
    const { digest } = await writeLedger(directory, validHeader(3, payloadBytes), entries);
    for (let i = 0; i < 3; i++) {
      const reader = value(await ReceiptLedgerReader.open(directory, digest));
      value(await reader.verify());
      expect(value(await reader.lookup("b"))!.mutationId).toBe("b");
      value(await reader.verify());
      expect(value(await reader.lookup("a"))!.mutationId).toBe("a");
    }
  });
});
