import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "../utils/result.js";
import { compareMutationIds, type ReceiptEntry, type ReceiptLedgerReader } from "./receiptLedger.js";
import { DEFAULT_MAX_INDEX_BYTES } from "./recoveryMutationIndex.js";
import { nodeDirectoryIO, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, type WalIO } from "./walIO.js";

/**
 * Tranche 7 source-aware mutation-history verification.
 *
 * Combines the two logical mutation-history namespaces:
 *   1. the cumulative historical receipt ledger (sorted, streamed);
 *   2. the current active WAL segment (sorted here through bounded external
 *      sorting, same scratch conventions as the frozen T5 index).
 *
 * Exactness rules (all failures are PERSISTENCE_CORRUPTION):
 *   - duplicate mutationId within the receipt ledger is impossible here (the
 *     ledger is verified strictly increasing before this layer) and treated
 *     as corruption if observed;
 *   - the same mutationId in receipt history AND active WAL -> corruption
 *     (the namespaces are logically disjoint by rotation construction);
 *   - the same mutationId twice in the active WAL record stream -> corruption
 *     (the frozen WAL scanner's adjacent-physical-duplicate dedup happens
 *     BEFORE this layer; frozen T5 DiskBackedMutationIndex semantics are
 *     untouched and continue to govern within-WAL exactness independently);
 *   - conflicting intent digest under the same mutationId anywhere -> corruption.
 *
 * Fixed resource envelope: the receipt side is streamed (one entry in memory),
 * the WAL side uses bounded external sorting whose scratch is bounded by the
 * active segment (itself bounded by MAX_ACTIVE_WAL_BYTES). The resource
 * count does not grow with receipt-history size.
 */

const RUN_PREFIX = "mutation-history-";
const RUN_SUFFIX = ".run";
const RECORD_FLUSH_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 8192;
const MERGE_FANIN = 8;
const READ_CHUNK_BYTES = 64 * 1024;

interface WalMutationRecord { readonly mutationId: string; readonly intentDigest: string; readonly txId: string }

const encodeRecord = (record: WalMutationRecord): Result<Uint8Array> => {
  if (typeof record.mutationId !== "string" || !record.mutationId || typeof record.intentDigest !== "string"
    || typeof record.txId !== "string") return err("PERSISTENCE_CORRUPTION", "Invalid history record.");
  const bytes = Buffer.from(JSON.stringify({ m: record.mutationId, d: record.intentDigest, t: record.txId }) + "\n", "utf8");
  if (bytes.byteLength > MAX_RECORD_BYTES) return err("PERSISTENCE_CORRUPTION", "History record exceeds its byte bound.");
  return ok(bytes);
};

const decodeRecord = (line: Uint8Array): Result<WalMutationRecord> => {
  if (line.byteLength === 0 || line[line.byteLength - 1] !== 10) return err("PERSISTENCE_CORRUPTION", "History record is truncated.");
  if (line.byteLength > MAX_RECORD_BYTES) return err("PERSISTENCE_CORRUPTION", "History record exceeds its byte bound.");
  try {
    const parsed = JSON.parse(Buffer.from(line.subarray(0, line.byteLength - 1)).toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.m !== "string" || typeof parsed.d !== "string" || typeof parsed.t !== "string"
      || Object.keys(parsed).length !== 3) return err("PERSISTENCE_CORRUPTION", "Invalid history record.");
    return ok({ mutationId: parsed.m, intentDigest: parsed.d, txId: parsed.t });
  } catch {
    return err("PERSISTENCE_CORRUPTION", "Malformed history record.");
  }
};

/** Bounded sequential line reader over one run file (one record in memory at a time). */
async function* readRunRecords(path: string, files: WalIO): AsyncGenerator<WalMutationRecord> {
  const opened = await files.open(path, false);
  const handle = opened;
  try {
    const size = (await handle.stat()).size;
    let position = 0;
    let line = Buffer.alloc(0);
    while (position < size) {
      const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, Math.max(1, size - position)));
      const bytes = await handle.read(chunk, position);
      if (bytes <= 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "History run ended early.");
      position += bytes;
      const data = chunk.subarray(0, bytes);
      let offset = 0;
      while (offset < data.length) {
        const relative = data.subarray(offset).indexOf(10);
        if (relative < 0) {
          line = Buffer.concat([line, data.subarray(offset)]);
          offset = data.length;
          if (line.byteLength > MAX_RECORD_BYTES) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "History record exceeds its byte bound.");
        } else {
          const piece = data.subarray(offset, offset + relative + 1);
          offset += relative + 1;
          const recordLine = line.byteLength === 0 ? piece : Buffer.concat([line, piece]);
          line = Buffer.alloc(0);
          const decoded = decodeRecord(recordLine);
          if (!decoded.ok) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Malformed history record.");
          yield decoded.value;
        }
      }
    }
    if (line.byteLength !== 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "History run tail is truncated.");
  } finally {
    await handle.close();
  }
}

export class MutationHistoryVerifier {
  private readonly runPaths: string[] = [];
  private readonly buffer: WalMutationRecord[] = [];
  private bufferBytes = 0;
  private accountedBytes = 0;
  private nextRun = 0;

  constructor(private readonly directory: string, private readonly io: DirectoryIO = nodeDirectoryIO,
    private readonly files: WalIO = nodeWalIO, private readonly maxDiskBytes: number = DEFAULT_MAX_INDEX_BYTES) {}

  /** Record one active-WAL logical transaction (post-scanner; physical duplicates never reach here). */
  async recordWal(record: WalMutationRecord): Promise<Result<undefined>> {
    const encoded = encodeRecord(record);
    if (!encoded.ok) return encoded;
    this.buffer.push(record);
    this.bufferBytes += encoded.value.byteLength;
    if (this.bufferBytes >= RECORD_FLUSH_BYTES) return this.flushRun();
    return ok(undefined);
  }

  private async flushRun(): Promise<Result<undefined>> {
    if (this.buffer.length === 0) return ok(undefined);
    const sorted = [...this.buffer].sort((a, b) => compareMutationIds(a.mutationId, b.mutationId));
    let bytes = 0;
    const encoded: Uint8Array[] = [];
    for (const record of sorted) {
      const line = encodeRecord(record);
      if (!line.ok) return line;
      bytes += line.value.byteLength;
      encoded.push(line.value);
    }
    if (this.accountedBytes + bytes > this.maxDiskBytes) {
      return err("RECOVERY_REQUIRED", "Mutation-history verification exceeds its disk budget.", { reason: "resource-limit" });
    }
    const runPath = join(this.directory, ".private", `${RUN_PREFIX}${String(this.nextRun++).padStart(6, "0")}${RUN_SUFFIX}`);
    try {
      const handle = await this.files.open(runPath, true);
      try {
        let position = 0;
        for (const line of encoded) {
          await handle.write(line, position);
          position += line.byteLength;
        }
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED", "History verification run write failed.");
    }
    this.accountedBytes += bytes;
    this.runPaths.push(runPath);
    this.buffer.length = 0;
    this.bufferBytes = 0;
    return ok(undefined);
  }

  /**
   * Exact source-aware verification of active-WAL records against the
   * authoritative cumulative receipt history. Every rule violation is
   * corruption; nothing is silently tolerated.
   */
  async verify(receipts?: ReceiptLedgerReader): Promise<Result<undefined>> {
    const flushed = await this.flushRun();
    if (!flushed.ok) return flushed;
    try {
      if (this.runPaths.length === 0) {
        // No active-WAL records: the receipt ledger alone must be internally
        // exact; duplicates cannot appear (strictly increasing by verification).
        return ok(undefined);
      }
      // Merge the sorted runs into one ordered stream with bounded fan-in
      // (multi-pass when runs exceed the fan-in), then two-pointer walk
      // against the receipt stream.
      let currentRuns = [...this.runPaths];
      let pass = 0;
      while (currentRuns.length > 1) {
        const merged: string[] = [];
        for (let start = 0; start < currentRuns.length; start += MERGE_FANIN) {
          const group = currentRuns.slice(start, start + MERGE_FANIN);
          if (group.length === 1) { merged.push(group[0]!); continue; }
          const mergedPath = join(this.directory, ".private", `${RUN_PREFIX}m${pass}-${merged.length}-${randomUUID()}${RUN_SUFFIX}`);
          const mergeResult = await this.mergeRuns(group, mergedPath);
          if (!mergeResult.ok) return mergeResult;
          merged.push(mergedPath);
        }
        currentRuns = merged;
        pass++;
      }
      // NOTE: await before return - the finally-block cleanup must not race the verification.
      return await this.verifyOrdered(currentRuns[0]!, receipts);
    } finally {
      await this.cleanup();
    }
  }

  /** k-way merge of sorted run files into one sorted run file (bounded RAM). */
  private async mergeRuns(paths: string[], destination: string): Promise<Result<undefined>> {
    type Cursor = { record: WalMutationRecord; done: boolean };
    const cursors: Cursor[] = [];
    const generators = paths.map(path => readRunRecords(path, this.files));
    try {
      for (const generator of generators) cursors.push({ record: (await generator.next()).value!, done: false });
      let bytes = 0;
      const handle = await this.files.open(destination, true);
      try {
        let position = 0;
        for (;;) {
          let best = -1;
          for (let i = 0; i < cursors.length; i++) {
            if (cursors[i]!.done) continue;
            if (best < 0 || compareMutationIds(cursors[i]!.record.mutationId, cursors[best]!.record.mutationId) < 0) best = i;
          }
          if (best < 0) break;
          const line = encodeRecord(cursors[best]!.record);
          if (!line.ok) return line;
          await handle.write(line.value, position);
          position += line.value.byteLength;
          bytes += line.value.byteLength;
          if (this.accountedBytes + bytes > this.maxDiskBytes) {
            return err("RECOVERY_REQUIRED", "Mutation-history verification exceeds its disk budget.", { reason: "resource-limit" });
          }
          const next = await generators[best]!.next();
          cursors[best] = { record: next.value as WalMutationRecord, done: !!next.done };
        }
        await handle.sync();
      } finally { await handle.close(); }
      this.accountedBytes += bytes;
      return ok(undefined);
    } catch (error) {
      if (error instanceof DirectoryIoError) return err(error.code, error.message);
      return err("PERSISTENCE_CORRUPTION", "History verification merge failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      for (const generator of generators) await generator.return?.(undefined as never).catch(() => undefined);
    }
  }

  /** Exact verification of one sorted WAL stream against the receipt stream. */
  private async verifyOrdered(walRunPath: string, receipts?: ReceiptLedgerReader): Promise<Result<undefined>> {
    const walStream = readRunRecords(walRunPath, this.files);
    const receiptIterator = receipts ? receipts.entries()[Symbol.asyncIterator]() : undefined;
    try {
      let wal = await walStream.next();
      let receipt: IteratorResult<ReceiptEntry> | undefined = receiptIterator ? await receiptIterator.next() : undefined;
      let lastWal: WalMutationRecord | undefined;
      while (!wal.done) {
        const record = wal.value;
        // Within-WAL duplicates are corruption at this layer (physical
        // duplicates were already deduplicated by the frozen scanner).
        if (lastWal && compareMutationIds(record.mutationId, lastWal.mutationId) <= 0) {
          return err("PERSISTENCE_CORRUPTION", "Duplicate mutation identity in the active WAL record stream.");
        }
        if (lastWal && lastWal.mutationId === record.mutationId && lastWal.intentDigest !== record.intentDigest) {
          return err("PERSISTENCE_CORRUPTION", "Conflicting mutation identity reuse.");
        }
        lastWal = record;
        while (receipt && !receipt.done && compareMutationIds(receipt.value.mutationId, record.mutationId) < 0) {
          receipt = await receiptIterator!.next();
        }
        if (receipt && !receipt.done && receipt.value.mutationId === record.mutationId) {
          return err("PERSISTENCE_CORRUPTION", "Mutation identity appears in both receipt history and the active WAL.");
        }
        wal = await walStream.next();
      }
      return ok(undefined);
    } catch (error) {
      if (error instanceof DirectoryIoError) return err(error.code, error.message);
      return err("PERSISTENCE_CORRUPTION", "Mutation-history verification failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      await walStream.return?.(undefined as never).catch(() => undefined);
      if (receiptIterator) await receiptIterator.return?.(undefined as never).catch(() => undefined);
    }
  }

  /** Idempotent scratch sweep, tolerating ENOENT (same cleanup philosophy as the frozen index). */
  async cleanup(): Promise<void> {
    for (const path of this.runPaths) {
      try { await this.io.removeOwnedFile(path); } catch { /* swept later */ }
    }
    this.runPaths.length = 0;
    this.accountedBytes = 0;
    this.nextRun = 0;
  }
}
