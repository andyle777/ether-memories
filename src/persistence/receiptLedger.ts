import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import { canonicalJson, decodeCanonicalJson } from "./walJson.js";
import { WAL_LIMITS } from "./wal.js";
import type { WalOperation } from "../types/persistence.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "./walIO.js";
import { DirectoryIoError } from "./directoryIO.js";

/**
 * Tranche 7 durable mutation-receipt ledger.
 *
 * The cumulative receipt ledger preserves command-idempotency/reconciliation
 * history across WAL reclamation. It is a PERMANENT durable artifact under
 * receipts/ (never .private scratch), retained indefinitely under frozen
 * semantics, and bound to its checkpoint lineage through the rotated
 * checkpoint's checkpointId, which is exactly this file's content digest.
 *
 * Stream-framed wire (canonical JSON, LF-delimited - never one monolithic
 * JSON value):
 *   canonicalJSON(header) "\n"
 *   [ canonicalJSON(entry) "\n" ] * entryCount
 * A missing final LF is a truncated tail and fails closed. The whole-file
 * SHA-256 is the content address in the filename and in the rotated
 * checkpointId. Rotation, lookup and startup verification are all
 * streaming: the cumulative ledger is never materialized.
 *
 * Entries are sorted by mutationId under the frozen comparator below and
 * must be STRICTLY INCREASING: duplicate mutationIds in receipt history are
 * corruption (the frozen benign-duplicate rule survives only for adjacent
 * byte-identical physical WAL frames deduplicated by the WAL scanner).
 */

export const RECEIPTS_FORMAT = "ether.receipts" as const;
export const RECEIPTS_VERSION = "1" as const;
export const RECEIPTS_DIRECTORY = "receipts";
/** Header line bound; mirrors the frozen bounded-header style. */
const MAX_HEADER_BYTES = 4096;
/** Per-entry line bound: inline aggregate payload bound plus fixed overhead. */
export const MAX_RECEIPT_ENTRY_BYTES = WAL_LIMITS.aggregatePayloadBytes + 8192;
const READ_CHUNK_BYTES = 256 * 1024;
const ZERO_DIGEST = "0".repeat(64);

export interface ReceiptEntry {
  readonly mutationId: string;
  readonly intentDigest: string;
  readonly txId: string;
  readonly transactionDigest: string;
  readonly operations: readonly WalOperation[];
}

export interface ReceiptLedgerHeader {
  readonly format: typeof RECEIPTS_FORMAT;
  readonly version: typeof RECEIPTS_VERSION;
  readonly storeId: string;
  readonly epochId: string;
  /** Checkpoint digest of the WAL segment retired by the rotation that wrote this ledger generation (audit). */
  readonly retiredCheckpointDigest: string;
  /** Content digest of the previous cumulative ledger generation (audit; deleted after activation). */
  readonly predecessorLedgerDigest: string;
  readonly entryCount: number;
  readonly payloadBytes: number;
}

/** Zero digest used for the first (root) cumulative ledger generation. */
export const ROOT_PREDECESSOR_DIGEST = ZERO_DIGEST;

/**
 * MAX_ACTIVE_WAL_BYTES, derived (not assumed) from the frozen 256 MiB
 * working budget (DEFAULT_MAX_INDEX_BYTES) and frozen expansion constants,
 * all protected by a dedicated derivation test:
 *
 *   F_MIN  = minimum legal WAL frame bytes, measured with the frozen encoder
 *            at 526 (assumption floor 500, test-enforced).
 *   R_IDX  = frozen mutation-index record bound = 512 bytes.
 *   E(B)   = B / F_MIN worst-case logical transactions in a B-byte segment.
 *
 *   restart worst scratch (T5 index runs + merge output):
 *     2 x E(B) x R_IDX <= 2 x B x 512/500 = 2.048 x B
 *     -> at B = 64 MiB: 131 MiB (51% of the 256 MiB budget)
 *   rotation worst scratch (segment sort runs; entries <= frames plus a
 *   25% safety factor): 1.25 x B -> at B = 64 MiB: 80 MiB (31%).
 *
 * 64 MiB leaves >= 2x headroom for every session-owned structure a legal
 * segment of that size can expand into: any accepted segment can
 * subsequently restart AND rotate under default budgets.
 */
export const MIN_LEGAL_WAL_FRAME_BYTES = 500;
export const MAX_ACTIVE_WAL_BYTES = 64 * 1024 * 1024;

const isHex = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);

/**
 * The single frozen mutationId comparator, used identically by the
 * active-segment external sort, ledger construction, the cumulative merge,
 * lookup early termination and source-aware verification: unsigned
 * lexicographic order over canonical UTF-8 bytes.
 */
export function compareMutationIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const entryJsonBounds = { bytes: MAX_RECEIPT_ENTRY_BYTES, depth: WAL_LIMITS.metadataDepth, nodes: WAL_LIMITS.jsonNodes };
const headerJsonBounds = { bytes: MAX_HEADER_BYTES, depth: WAL_LIMITS.metadataDepth, nodes: WAL_LIMITS.jsonNodes };

/** Encode one canonical receipt entry line (including its LF). */
export function encodeReceiptEntryLine(entry: ReceiptEntry): Result<Uint8Array> {
  if (typeof entry.mutationId !== "string" || !entry.mutationId) return err("PERSISTENCE_CORRUPTION", "Receipt entry requires a mutationId.");
  if (!isHex(entry.intentDigest, 64) || !isHex(entry.transactionDigest, 64) || typeof entry.txId !== "string") {
    return err("PERSISTENCE_CORRUPTION", "Receipt entry requires exact identity fields.");
  }
  if (!Array.isArray(entry.operations) || entry.operations.length === 0 || entry.operations.length > WAL_LIMITS.operations) {
    return err("PERSISTENCE_CORRUPTION", "Receipt entry requires a bounded operation set.");
  }
  const encoded = canonicalJson(entry, entryJsonBounds);
  if (!encoded.ok) return err("PERSISTENCE_CORRUPTION", "Receipt entry exceeds its byte bound.");
  const line = new Uint8Array(encoded.value.byteLength + 1);
  line.set(encoded.value, 0);
  line[encoded.value.byteLength] = 10;
  return ok(line);
}

/** Encode the canonical header line (including its LF). */
export function encodeReceiptHeaderLine(header: ReceiptLedgerHeader): Result<Uint8Array> {
  const encoded = canonicalJson(header, headerJsonBounds);
  if (!encoded.ok) return err("PERSISTENCE_CORRUPTION", "Receipt header exceeds its byte bound.");
  const line = new Uint8Array(encoded.value.byteLength + 1);
  line.set(encoded.value, 0);
  line[encoded.value.byteLength] = 10;
  return ok(line);
}

export function decodeReceiptHeaderLine(bytes: Uint8Array): Result<ReceiptLedgerHeader> {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 10) {
    return err("PERSISTENCE_CORRUPTION", "Receipt header line is truncated.");
  }
  const value = decodeCanonicalJson(bytes.subarray(0, bytes.byteLength - 1), headerJsonBounds);
  if (!value.ok) return err("PERSISTENCE_CORRUPTION", "Malformed receipt header.");
  const header = value.value as Record<string, unknown>;
  const keys = Object.keys(header).sort().join(",");
  if (keys !== "entryCount,epochId,format,payloadBytes,predecessorLedgerDigest,retiredCheckpointDigest,storeId,version"
    || header.format !== RECEIPTS_FORMAT || header.version !== RECEIPTS_VERSION
    || typeof header.storeId !== "string" || !header.storeId || typeof header.epochId !== "string" || !header.epochId
    || !isHex(header.retiredCheckpointDigest, 64) || !isHex(header.predecessorLedgerDigest, 64)
    || typeof header.entryCount !== "number" || !Number.isSafeInteger(header.entryCount) || header.entryCount < 0
    || typeof header.payloadBytes !== "number" || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0) {
    return err("PERSISTENCE_CORRUPTION", "Invalid receipt header.");
  }
  return ok({ format: RECEIPTS_FORMAT, version: RECEIPTS_VERSION, storeId: header.storeId, epochId: header.epochId,
    retiredCheckpointDigest: header.retiredCheckpointDigest, predecessorLedgerDigest: header.predecessorLedgerDigest,
    entryCount: header.entryCount, payloadBytes: header.payloadBytes });
}

export function decodeReceiptEntryLine(bytes: Uint8Array): Result<ReceiptEntry> {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 10) {
    return err("PERSISTENCE_CORRUPTION", "Receipt entry line is truncated.");
  }
  if (bytes.byteLength > MAX_RECEIPT_ENTRY_BYTES) {
    return err("PERSISTENCE_CORRUPTION", "Receipt entry exceeds its byte bound.");
  }
  const value = decodeCanonicalJson(bytes.subarray(0, bytes.byteLength - 1), entryJsonBounds);
  if (!value.ok) return err("PERSISTENCE_CORRUPTION", "Malformed receipt entry.");
  const entry = value.value as Record<string, unknown>;
  const keys = Object.keys(entry).sort().join(",");
  if (keys !== "intentDigest,mutationId,operations,transactionDigest,txId"
    || typeof entry.mutationId !== "string" || !entry.mutationId
    || !isHex(entry.intentDigest, 64) || !isHex(entry.transactionDigest, 64)
    || typeof entry.txId !== "string" || !entry.txId
    || !Array.isArray(entry.operations) || entry.operations.length === 0 || entry.operations.length > WAL_LIMITS.operations) {
    return err("PERSISTENCE_CORRUPTION", "Invalid receipt entry.");
  }
  return ok({ mutationId: entry.mutationId, intentDigest: entry.intentDigest, txId: entry.txId,
    transactionDigest: entry.transactionDigest, operations: entry.operations as WalOperation[] });
}

export const receiptLedgerPath = (directory: string, ledgerDigest: string): string =>
  join(directory, RECEIPTS_DIRECTORY, `receipts-${ledgerDigest}.bin`);
export const receiptLedgerCandidatePath = (directory: string, ledgerDigest: string): string =>
  join(directory, RECEIPTS_DIRECTORY, `.receipts-${ledgerDigest}.candidate`);

/**
 * True when a checkpoint's checkpointId is a rotated anchor (the content
 * digest of the required cumulative receipt ledger). By construction only
 * rotation emits 64-hex checkpointIds: every pre-T7 creator uses fixed
 * non-hex ids (T6 bootstrap: "checkpoint-initial"), so a hex id
 * deterministically means "receipts REQUIRED for this lineage".
 */
export const isRotatedCheckpointId = (checkpointId: string): boolean => /^[0-9a-f]{64}$/.test(checkpointId);

const reopen = async (files: WalIO, path: string): Promise<Result<{ handle: WalFileHandle; size: number }>> => {
  try {
    const handle = await files.open(path, false);
    return ok({ handle, size: (await handle.stat()).size });
  } catch (error) {
    if (error instanceof DirectoryIoError) return err(error.code, error.message);
    return err("PERSISTENCE_CORRUPTION", "Receipt ledger is unreadable.");
  }
};

/**
 * Stateless streaming reader over one immutable receipt ledger: every
 * operation opens a fresh handle; nothing is retained between operations.
 * Never materializes the file - bounded chunked positional reads with one
 * entry line in memory at a time.
 */
export class ReceiptLedgerReader {
  private constructor(readonly ledgerDigest: string, readonly header: ReceiptLedgerHeader,
    readonly path: string, readonly payloadStart: number, readonly payloadBytes: number,
    private readonly files: WalIO) {}

  /** Open and parse the bounded header; verify declared payload length against the file size. */
  static async open(directory: string, ledgerDigest: string, files: WalIO = nodeWalIO): Promise<Result<ReceiptLedgerReader>> {
    const path = receiptLedgerPath(directory, ledgerDigest);
    const opened = await reopen(files, path);
    if (!opened.ok) return err(opened.error.code, opened.error.code === "RECOVERY_REQUIRED"
      ? opened.error.message : "Required receipt history is missing or unreadable.");
    const { handle, size } = opened.value;
    try {
      const head = new Uint8Array(Math.min(size, MAX_HEADER_BYTES));
      let read = 0;
      while (read < head.byteLength) {
        const bytes = await handle.read(head.subarray(read), read);
        if (bytes <= 0) break;
        read += bytes;
      }
      const consumed = head.subarray(0, read);
      const separator = consumed.indexOf(10);
      if (separator < 0) return err("PERSISTENCE_CORRUPTION", "Receipt header line is truncated.");
      const decoded = decodeReceiptHeaderLine(consumed.subarray(0, separator + 1));
      if (!decoded.ok) return decoded;
      const header = decoded.value;
      if (size - (separator + 1) !== header.payloadBytes) {
        return err("PERSISTENCE_CORRUPTION", "Receipt payload length differs from its header.");
      }
      return ok(new ReceiptLedgerReader(ledgerDigest, header, path, separator + 1, header.payloadBytes, files));
    } finally {
      await handle.close();
    }
  }

  /**
   * Full streaming verification: whole-file digest matches the content
   * address, every entry line decodes within bounds, entries are strictly
   * increasing under the frozen comparator, and counts/bytes match the
   * header. `visit` receives each entry, one at a time; history is never
   * materialized. Receipt history is authoritative: every failure fails
   * closed as corruption.
   */
  async verify(visit?: (entry: ReceiptEntry) => Promise<void> | void): Promise<Result<undefined>> {
    const opened = await reopen(this.files, this.path);
    if (!opened.ok) return opened;
    const { handle, size } = opened.value;
    try {
      const digest = createHash("sha256");
      let position = 0;
      let line = Buffer.alloc(0);
      let seen = 0;
      let payloadConsumed = 0;
      let lastMutationId: string | undefined;
      let headerConsumed = false;
      const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, Math.max(1, size)));
      while (position < size) {
        const bytes = await handle.read(chunk, position);
        if (bytes <= 0) return err("PERSISTENCE_CORRUPTION", "Receipt ledger ended early.");
        position += bytes;
        const data = chunk.subarray(0, bytes);
        digest.update(data);
        let offset = 0;
        while (offset < data.length) {
          const relative = data.subarray(offset).indexOf(10);
          if (relative < 0) {
            line = Buffer.concat([line, data.subarray(offset)]);
            offset = data.length;
            if (line.byteLength > MAX_RECEIPT_ENTRY_BYTES) return err("PERSISTENCE_CORRUPTION", "Receipt entry exceeds its byte bound.");
          } else {
            const piece = data.subarray(offset, offset + relative + 1);
            offset += relative + 1;
            line = Buffer.concat([line, piece]);
            if (!headerConsumed) {
              // The first line is the header already validated at open.
              headerConsumed = true;
              const headerDecoded = decodeReceiptHeaderLine(line);
              if (!headerDecoded.ok || headerDecoded.value.entryCount !== this.header.entryCount
                || headerDecoded.value.payloadBytes !== this.header.payloadBytes) {
                return err("PERSISTENCE_CORRUPTION", "Receipt header changed during verification.");
              }
            } else {
              const decoded = decodeReceiptEntryLine(line);
              if (!decoded.ok) return decoded;
              const entry = decoded.value;
              if (lastMutationId !== undefined && compareMutationIds(entry.mutationId, lastMutationId) <= 0) {
                return err("PERSISTENCE_CORRUPTION", "Receipt ledger entries are not strictly increasing.");
              }
              lastMutationId = entry.mutationId;
              seen++;
              payloadConsumed += line.byteLength;
              if (visit) await visit(entry);
            }
            line = Buffer.alloc(0);
          }
        }
      }
      if (line.byteLength !== 0) return err("PERSISTENCE_CORRUPTION", "Receipt ledger tail is truncated.");
      if (seen !== this.header.entryCount) return err("PERSISTENCE_CORRUPTION", "Receipt entry count differs from its header.");
      if (payloadConsumed !== this.payloadBytes) return err("PERSISTENCE_CORRUPTION", "Receipt payload bytes differ from its header.");
      if (digest.digest("hex") !== this.ledgerDigest) {
        return err("PERSISTENCE_CORRUPTION", "Receipt ledger digest differs from its content address.");
      }
      return ok(undefined);
    } finally {
      await handle.close();
    }
  }

  /**
   * Streaming ordered iteration over the payload region (header excluded).
   * Decodes and yields one entry at a time; asserts strict increase under the
   * frozen comparator while iterating. The whole-file digest is NOT recomputed
   * here: callers run verify() first when they need content-address proof.
   * History is never materialized.
   */
  async *entries(): AsyncGenerator<ReceiptEntry> {
    const opened = await reopen(this.files, this.path);
    if (!opened.ok) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Receipt ledger is unreadable.");
    const { handle } = opened.value;
    try {
      let position = this.payloadStart;
      let remaining = this.payloadBytes;
      let line = Buffer.alloc(0);
      let lastMutationId: string | undefined;
      while (remaining > 0) {
        const want = Math.min(READ_CHUNK_BYTES, remaining);
        const chunk = new Uint8Array(want);
        const bytes = await handle.read(chunk, position);
        if (bytes <= 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Receipt ledger ended early.");
        position += bytes;
        remaining -= bytes;
        const data = chunk.subarray(0, bytes);
        let offset = 0;
        while (offset < data.length) {
          const relative = data.subarray(offset).indexOf(10);
          if (relative < 0) {
            line = Buffer.concat([line, data.subarray(offset)]);
            offset = data.length;
            if (line.byteLength > MAX_RECEIPT_ENTRY_BYTES) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Receipt entry exceeds its byte bound.");
          } else {
            const piece = data.subarray(offset, offset + relative + 1);
            offset += relative + 1;
            const entryLine = line.byteLength === 0 ? piece : Buffer.concat([line, piece]);
            line = Buffer.alloc(0);
            const decoded = decodeReceiptEntryLine(entryLine);
            if (!decoded.ok) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Malformed receipt entry.");
            const entry = decoded.value;
            if (lastMutationId !== undefined && compareMutationIds(entry.mutationId, lastMutationId) <= 0) {
              throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Receipt ledger entries are not strictly increasing.");
            }
            lastMutationId = entry.mutationId;
            yield entry;
          }
        }
      }
      if (line.byteLength !== 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Receipt ledger tail is truncated.");
    } finally {
      await handle.close();
    }
  }

  /** Streaming lookup with sorted early termination; never materializes history. */
  async lookup(mutationId: string): Promise<Result<ReceiptEntry | undefined>> {
    const opened = await reopen(this.files, this.path);
    if (!opened.ok) return opened;
    const { handle } = opened.value;
    try {
      let position = this.payloadStart;
      let remaining = this.payloadBytes;
      let line = Buffer.alloc(0);
      while (remaining > 0) {
        const want = Math.min(READ_CHUNK_BYTES, remaining);
        const chunk = new Uint8Array(want);
        const bytes = await handle.read(chunk, position);
        if (bytes <= 0) return err("PERSISTENCE_CORRUPTION", "Receipt ledger ended early.");
        position += bytes;
        remaining -= bytes;
        const data = chunk.subarray(0, bytes);
        let offset = 0;
        while (offset < data.length) {
          const relative = data.subarray(offset).indexOf(10);
          if (relative < 0) {
            line = Buffer.concat([line, data.subarray(offset)]);
            offset = data.length;
            if (line.byteLength > MAX_RECEIPT_ENTRY_BYTES) return err("PERSISTENCE_CORRUPTION", "Receipt entry exceeds its byte bound.");
          } else {
            const piece = data.subarray(offset, offset + relative + 1);
            offset += relative + 1;
            const entryLine = line.byteLength === 0 ? piece : Buffer.concat([line, piece]);
            line = Buffer.alloc(0);
            const decoded = decodeReceiptEntryLine(entryLine);
            if (!decoded.ok) return decoded;
            const order = compareMutationIds(decoded.value.mutationId, mutationId);
            if (order === 0) return ok(decoded.value);
            if (order > 0) return ok(undefined);
          }
        }
      }
      if (line.byteLength !== 0) return err("PERSISTENCE_CORRUPTION", "Receipt ledger tail is truncated.");
      return ok(undefined);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Load the authoritative cumulative receipt ledger for a lineage, or report
 * zero history for a non-rotated checkpoint. Missing REQUIRED history fails
 * closed: once WAL history is reclaimed, a deleted ledger means lost
 * reconciliation authority.
 */
export async function openAuthoritativeReceiptLedger(directory: string, storeId: string, epochId: string,
  checkpointId: string, files: WalIO = nodeWalIO): Promise<Result<ReceiptLedgerReader | undefined>> {
  if (!isRotatedCheckpointId(checkpointId)) {
    // Non-rotated root: no receipt history is required for this lineage.
    return ok(undefined);
  }
  const opened = await ReceiptLedgerReader.open(directory, checkpointId, files);
  if (!opened.ok) return opened;
  const reader = opened.value;
  if (reader.header.storeId !== storeId || reader.header.epochId !== epochId) {
    return err("PERSISTENCE_CORRUPTION", "Receipt ledger does not belong to this store lineage.");
  }
  return ok(reader);
}
