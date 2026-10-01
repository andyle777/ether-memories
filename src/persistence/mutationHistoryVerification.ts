import { join } from "node:path";
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
 * Scratch lifecycle (T5 recovery-index precedent; Codex AMBER repair):
 *   - ONE bounded deterministic namespace (HISTORY_NAMESPACE_SIZE slots,
 *     mutation-history-{NNNNNN}.run) covers EVERY session artifact: initial
 *     sorted runs AND every intermediate/final merge output. A session sweeps
 *     the entire namespace before creating its first artifact, so stale files
 *     from crashed sessions are reclaimed; ENOENT is idempotent and every
 *     other failure fails closed before any artifact is created.
 *   - Every artifact is created through the single slot allocator and is
 *     added to session ownership with its byte accounting BEFORE creation
 *     (a partial write never becomes unaccounted debris).
 *   - Ownership and accounting survive until a SUCCESSFUL unlink; a failed
 *     unlink retains both and propagates. No imaginary reclaimed capacity.
 *   - A successful verification leaves ZERO session-owned artifacts; the
 *     .private directory barrier is taken after full successful removal.
 * Fixed resource envelope: the receipt side is streamed (one entry in memory),
 * the WAL side uses bounded external sorting whose scratch is bounded by the
 * active segment (itself bounded by MAX_ACTIVE_WAL_BYTES). The resource count
 * does not grow with receipt-history size.
 */

const RUN_PREFIX = "mutation-history-";
const RUN_SUFFIX = ".run";
/**
 * Bounded deterministic namespace for every verifier artifact. Worst case at
 * the admission envelope: ~63k records at ~100 B flush to well under 100
 * initial runs plus fewer merge outputs - far below 1,024 slots; exhaustion
 * fails closed as a resource limit before any unaccounted artifact exists.
 */
const HISTORY_NAMESPACE_SIZE = 1024;
const RECORD_FLUSH_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 8192;
const MERGE_FANIN = 8;
const READ_CHUNK_BYTES = 64 * 1024;

interface WalMutationRecord { readonly mutationId: string; readonly intentDigest: string; readonly txId: string }

const slotPath = (directory: string, slot: number): string =>
  join(directory, ".private", `${RUN_PREFIX}${String(slot).padStart(6, "0")}${RUN_SUFFIX}`);

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
  /**
   * Session ownership and exact byte accounting for EVERY artifact this
   * session created (initial runs and all merge outputs). An entry survives
   * until a successful unlink removes both the file and its accounting;
   * a failed unlink retains both (no imaginary reclaimed capacity).
   */
  private readonly owned = new Map<string, number>();
  /** Ordered merge inputs of the current pass. */
  private runPaths: string[] = [];
  private readonly buffer: WalMutationRecord[] = [];
  private bufferBytes = 0;
  private nextSlot = 0;
  private swept = false;

  constructor(private readonly directory: string, private readonly io: DirectoryIO = nodeDirectoryIO,
    private readonly files: WalIO = nodeWalIO, private readonly maxDiskBytes: number = DEFAULT_MAX_INDEX_BYTES) {}

  private get accountedBytes(): number {
    let sum = 0;
    for (const bytes of this.owned.values()) sum += bytes;
    return sum;
  }

  /** Reserve the next deterministic namespace slot (bounded; fail-closed). */
  private allocateSlot(): Result<string> {
    if (this.nextSlot >= HISTORY_NAMESPACE_SIZE) {
      return err("RECOVERY_REQUIRED", "Mutation-history scratch namespace exhausted.", { reason: "resource-limit" });
    }
    return ok(slotPath(this.directory, this.nextSlot++));
  }

  /**
   * Session-start sweep of the entire bounded namespace (T5 convention):
   * reclaims stale artifacts from crashed sessions. ENOENT is idempotent
   * success; every other failure fails closed before any artifact is created.
   */
  private async ensureSwept(): Promise<Result<undefined>> {
    if (this.swept) return ok(undefined);
    for (let slot = 0; slot < HISTORY_NAMESPACE_SIZE; slot++) {
      const path = slotPath(this.directory, slot);
      try { await this.io.removeOwnedFile(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED", "Mutation-history scratch sweep failed.");
      }
    }
    this.swept = true;
    return ok(undefined);
  }

  /** Record one active-WAL logical transaction (post-scanner; physical duplicates never reach here). */
  async recordWal(record: WalMutationRecord): Promise<Result<undefined>> {
    const swept = await this.ensureSwept();
    if (!swept.ok) return swept;
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
    // Within-chunk duplicate mutationIds are logical corruption.
    for (let index = 1; index < sorted.length; index++) {
      if (compareMutationIds(sorted[index]!.mutationId, sorted[index - 1]!.mutationId) === 0) {
        return err("PERSISTENCE_CORRUPTION", "Duplicate mutation identity in the active WAL record stream.");
      }
    }
    const lines: Uint8Array[] = [];
    let bytes = 0;
    for (const record of sorted) {
      const line = encodeRecord(record);
      if (!line.ok) return line;
      lines.push(line.value);
      bytes += line.value.byteLength;
    }
    if (this.accountedBytes + bytes > this.maxDiskBytes) {
      return err("RECOVERY_REQUIRED", "Mutation-history verification exceeds its disk budget.", { reason: "resource-limit" });
    }
    const slot = this.allocateSlot();
    if (!slot.ok) return slot;
    // Ownership and accounting BEFORE creation: a partial write never
    // becomes unaccounted debris.
    this.owned.set(slot.value, bytes);
    try {
      const handle = await this.files.open(slot.value, true);
      try {
        let position = 0;
        for (const line of lines) {
          await handle.write(line, position);
          position += line.byteLength;
        }
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "History verification run write failed.");
    }
    this.runPaths.push(slot.value);
    this.buffer.length = 0;
    this.bufferBytes = 0;
    return ok(undefined);
  }

  /**
   * Exact source-aware verification of active-WAL records against the
   * authoritative cumulative receipt history. Every rule violation is
   * corruption; nothing is silently tolerated. A SUCCESSFUL verification
   * must leave zero session-owned scratch: a cleanup failure is propagated,
   * never hidden behind a success.
   */
  async verify(receipts?: ReceiptLedgerReader): Promise<Result<undefined>> {
    const swept = await this.ensureSwept();
    if (!swept.ok) return swept;
    const flushed = await this.flushRun();
    const outcome = flushed.ok ? await this.mergeAndVerify(receipts) : flushed;
    const cleaned = await this.cleanup();
    return outcome.ok ? (cleaned.ok ? outcome : cleaned) : outcome;
  }

  /** Multi-pass bounded-fan-in merge of the sorted runs, then exact verification. */
  private async mergeAndVerify(receipts?: ReceiptLedgerReader): Promise<Result<undefined>> {
    if (this.runPaths.length === 0) {
      // No active-WAL records: the receipt ledger alone must be internally
      // exact; duplicates cannot appear (strictly increasing by verification).
      return ok(undefined);
    }
    try {
      let currentRuns = [...this.runPaths];
      while (currentRuns.length > 1) {
        const merged: string[] = [];
        for (let start = 0; start < currentRuns.length; start += MERGE_FANIN) {
          const group = currentRuns.slice(start, start + MERGE_FANIN);
          if (group.length === 1) { merged.push(group[0]!); continue; }
          // The merged output carries exactly the group's records: reserve its
          // bytes (the sum of the owned inputs) BEFORE creating the file.
          const reserved = group.reduce((sum, path) => sum + (this.owned.get(path) ?? 0), 0);
          if (this.accountedBytes + reserved > this.maxDiskBytes) {
            return err("RECOVERY_REQUIRED", "Mutation-history verification exceeds its disk budget.", { reason: "resource-limit" });
          }
          const slot = this.allocateSlot();
          if (!slot.ok) return slot;
          this.owned.set(slot.value, reserved);
          const written = await this.mergeRuns(group, slot.value);
          if (!written.ok) return written;
          merged.push(slot.value);
        }
        currentRuns = merged;
      }
      // NOTE: await before return - cleanup must not race the verification.
      return await this.verifyOrdered(currentRuns[0]!, receipts);
    } catch (error) {
      if (error instanceof DirectoryIoError) return err(error.code, error.message);
      return err("PERSISTENCE_CORRUPTION", "Mutation-history verification failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  /** k-way merge of sorted run files into one sorted run file (bounded RAM); returns the bytes written. */
  private async mergeRuns(paths: string[], destination: string): Promise<Result<number>> {
    type Cursor = { record: WalMutationRecord; done: boolean };
    const cursors: Cursor[] = [];
    const generators = paths.map(path => readRunRecords(path, this.files));
    try {
      for (const generator of generators) cursors.push({ record: (await generator.next()).value!, done: false });
      let written = 0;
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
          written += line.value.byteLength;
          const next = await generators[best]!.next();
          cursors[best] = { record: next.value as WalMutationRecord, done: !!next.done };
        }
        await handle.sync();
      } finally { await handle.close(); }
      // The reservation assumed the exact re-encoded byte count; a mismatch
      // would silently break the disk accounting and is corruption.
      if (written !== (this.owned.get(destination) ?? -1)) {
        return err("PERSISTENCE_CORRUPTION", "Merged history run byte accounting mismatch.");
      }
      return ok(written);
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

  /**
   * Sweep every session-owned artifact. ENOENT is idempotent success (the
   * artifact is physically gone; its accounting is removed). A non-ENOENT
   * unlink failure retains ownership AND accounting and makes the failure
   * observable - there is no false successful cleanup and no imaginary
   * reclaimed capacity. After a fully successful sweep the .private
   * directory barrier is taken and the session resets for reuse
   * (StartupRecovery tail-repair pass 1 re-records after cleanup).
   */
  async cleanup(): Promise<Result<undefined>> {
    let failed = false;
    for (const [path] of this.owned) {
      try {
        await this.io.removeOwnedFile(path);
        this.owned.delete(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") { this.owned.delete(path); continue; }
        failed = true;
      }
    }
    if (failed) {
      return err("RECOVERY_REQUIRED", "Mutation-history scratch cleanup failed; artifacts remain owned and accounted.");
    }
    if (this.owned.size === 0) {
      try { await this.io.syncDirectory(join(this.directory, ".private")); }
      catch (error) {
        return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
          "Mutation-history scratch cleanup barrier failed.");
      }
      this.runPaths.length = 0;
      this.buffer.length = 0;
      this.bufferBytes = 0;
      this.nextSlot = 0;
    }
    return ok(undefined);
  }
}
