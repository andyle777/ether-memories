import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MutationId } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { DirectoryIoError, type DirectoryIO } from "./directoryIO.js";
import type { WalFileHandle, WalIO } from "./walIO.js";

/**
 * Exact recovery mutation index.
 *
 * Required invariant: exact duplicate-mutation detection across the ENTIRE
 * active WAL lineage, with bounded RAM. Disk usage may scale with active WAL
 * history; no fixed logical-mutation-count ceiling may exist below the maximum
 * recoverable WAL history.
 *
 * Architecture (external merge sort):
 * - every replayed transaction appends one record `mutationId|digest|txId`
 *   to a small in-memory buffer;
 * - when the buffer crosses RUN_FLUSH_BYTES it is sorted and flushed as a
 *   sorted on-disk run file (writeExclusive + directory barrier);
 * - verifyExact() streams the runs through bounded-fan-in k-way merges
 *   (chunked positional reads; RAM stays at FANIN * CHUNK_BYTES + one output
 *   buffer regardless of history length) and finally scans one globally sorted
 *   stream, so every mutation ID in the entire lineage is compared exactly;
 * - exceeding the explicit disk bound fails as a resource limitation; the
 *   index never silently forgets earlier mutation IDs. maxDiskBytes is the
 *   maximum aggregate bytes occupied AT ANY INSTANT by this session index
 *   artifacts (sorted runs, merge inputs and the merge output being written);
 *   the cap is enforced BEFORE every growth, never detected afterward.
 *
 * All files live under the store's `.private` directory with deterministic
 * names (`recovery-mutation-index-<n>.idx`). A session sweeps stale files from
 * an interrupted session first; only one recovery session can be active per
 * store because recovery holds the exclusive writer authority. Cleanup removes
 * exactly the files this session created and never touches foreign artifacts
 * (for example payload-object install temporaries).
 */

const INDEX_FILE_PREFIX = "recovery-mutation-index-";
const INDEX_FILE_SUFFIX = ".idx";
const MANIFEST_FILE_NAME = "recovery-mutation-index-manifest.v1";
const MANIFEST_PROFILE = "ether.recovery-mutation-index.v1";
const RUN_FLUSH_BYTES = 256 * 1024;
const RUN_READ_MARGIN_BYTES = 2048;
const MERGE_FANIN = 8;
const MERGE_CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 512;
export const DEFAULT_MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_INDEX_FILES = 1024;

export interface RecordedMutation {
  readonly digest: string;
  readonly txId: string;
}

export interface RecoveryMutationIndex {
  /** Record one replayed transaction's mutation identity. */
  record(mutationId: MutationId, entry: RecordedMutation): Promise<Result<void>>;
  /** Exact duplicate verification across every recorded transaction. */
  verifyExact(): Promise<Result<void>>;
  /** Remove all index artifacts and forget all records. */
  reset(): Promise<Result<void>>;
}

const validMutationId = (value: string): boolean =>
  typeof value === "string" && value.length >= 1 && value.length <= 128
  && /^[a-z0-9]/.test(value) && !/[^a-z0-9_-]/.test(value);
const validDigest = (value: string): boolean =>
  typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const validTxId = (value: string): boolean =>
  typeof value === "string" && value.length >= 1 && value.length <= 128 && /^\d+$/.test(value);

const encodeRecord = (mutationId: string, entry: RecordedMutation): string =>
  `${mutationId}|${entry.digest}|${entry.txId}`;

interface DecodedRecord { readonly mutationId: string; readonly digest: string; readonly txId: string }

function decodeRecord(line: string): DecodedRecord | undefined {
  const parts = line.split("|");
  if (parts.length !== 3 || !validMutationId(parts[0]!) || !validDigest(parts[1]!) || !validTxId(parts[2]!)) return undefined;
  return { mutationId: parts[0]!, digest: parts[1]!, txId: parts[2]! };
}

/** Streaming bounded-memory sorted-run reader (chunked positional reads). */
class RunReader {
  private readonly handle: WalFileHandle;
  private readonly size: number;
  private offset = 0;
  private window = Buffer.alloc(0);
  private windowOffset = 0;
  private carry = Buffer.alloc(0);
  current?: DecodedRecord;

  private constructor(handle: WalFileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  static async open(path: string, files: WalIO): Promise<Result<RunReader>> {
    try {
      const handle = await files.open(path, false);
      const stamp = await handle.stat();
      if (stamp.size > Number.MAX_SAFE_INTEGER) throw new Error("run too large");
      return ok(new RunReader(handle, stamp.size));
    } catch { return err("RECOVERY_REQUIRED", "Cannot read recovery mutation index run."); }
  }

  /** Loads the next record; returns false at end of run. */
  async advance(): Promise<Result<boolean>> {
    this.current = undefined;
    while (true) {
      const newline = this.window.indexOf(10, this.windowOffset);
      if (newline >= 0) {
        const line = Buffer.concat([this.carry, this.window.subarray(this.windowOffset, newline)]).toString("utf8");
        this.windowOffset = newline + 1;
        this.carry = Buffer.alloc(0);
        const record = decodeRecord(line);
        if (!record) return err("PERSISTENCE_CORRUPTION", "Invalid recovery mutation index record.");
        this.current = record;
        return ok(true);
      }
      this.carry = Buffer.concat([this.carry, this.window.subarray(this.windowOffset)]);
      this.windowOffset = 0;
      if (this.carry.byteLength > MAX_RECORD_BYTES) return err("PERSISTENCE_CORRUPTION", "Oversized recovery mutation index record.");
      if (this.offset >= this.size) {
        if (this.carry.byteLength === 0) return ok(false);
        return err("PERSISTENCE_CORRUPTION", "Truncated recovery mutation index record.");
      }
      const chunk = Buffer.alloc(Math.min(MERGE_CHUNK_BYTES, this.size - this.offset));
      let read = 0;
      while (read < chunk.byteLength) {
        const count = await this.handle.read(chunk.subarray(read), this.offset + read);
        if (!Number.isSafeInteger(count) || count <= 0) return err("RECOVERY_REQUIRED", "Short read from recovery mutation index run.");
        read += count;
      }
      this.offset += chunk.byteLength;
      this.window = chunk;
    }
  }

  async close(): Promise<void> { await this.handle.close(); }
}

/** Streaming bounded-memory sorted-run writer. */
class RunWriter {
  private readonly handle: WalFileHandle;
  private parts: Buffer[] = [];
  private buffered = 0;
  private position = 0;
  bytesWritten = 0;

  private constructor(handle: WalFileHandle) { this.handle = handle; }

  static async open(path: string, files: WalIO): Promise<Result<RunWriter>> {
    try { return ok(new RunWriter(await files.open(path, true))); }
    catch { return err("RECOVERY_REQUIRED", "Cannot create recovery mutation index run."); }
  }

  async write(record: DecodedRecord): Promise<Result<void>> {
    this.parts.push(Buffer.from(encodeRecord(record.mutationId, { digest: record.digest, txId: record.txId }) + "\n", "utf8"));
    this.buffered += this.parts[this.parts.length - 1]!.byteLength;
    return this.flush(false);
  }

  async flush(force: boolean): Promise<Result<void>> {
    if (this.parts.length === 0) return ok(undefined);
    if (!force && this.buffered < RUN_FLUSH_BYTES) return ok(undefined);
    const bytes = Buffer.concat(this.parts);
    this.parts = [];
    this.buffered = 0;
    let written = 0;
    while (written < bytes.byteLength) {
      const count = await this.handle.write(bytes.subarray(written), this.position + written);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - written) {
        return err("RECOVERY_REQUIRED", "Invalid partial write to recovery mutation index run.");
      }
      written += count;
    }
    this.position += bytes.byteLength;
    this.bytesWritten += bytes.byteLength;
    return ok(undefined);
  }

  async close(): Promise<Result<void>> {
    try {
      const flushed = await this.flush(true);
      if (!flushed.ok) return flushed;
      await this.handle.sync();
      await this.handle.close();
      return ok(undefined);
    } catch {
      try { await this.handle.close(); } catch { /* already failed */ }
      return err("RECOVERY_REQUIRED", "Cannot finalize recovery mutation index run.");
    }
  }
}

/** Exact disk-backed recovery mutation index (external merge sort). */
export class DiskBackedMutationIndex implements RecoveryMutationIndex {
  private readonly basePath: string;
  private readonly buffer: string[] = [];
  private bufferBytes = 0;
  private readonly runPaths: string[] = [];
  /** Exact session-owned byte ledger: every index artifact currently on disk. */
  private readonly ownedFiles = new Map<string, number>();
  /** Bytes written by the most recent merge outputs (for exact accounting). */
  private readonly mergeOutputBytes = new Map<string, number>();
  private nextFile = 0;
  private opened = false;
  /** Private session identity for the allocation manifest (diagnostic only). */
  private readonly sessionId = randomUUID();
  /** Highest durably reserved run number in this session's manifest. */
  private watermark = 0;
  private manifestExists = false;

  constructor(private readonly directory: string, private readonly io: DirectoryIO, private readonly files: WalIO,
    private readonly maxDiskBytes: number = DEFAULT_MAX_INDEX_BYTES,
    /** Internal tuning: sorted-run flush threshold. Does not change semantics. */
    private readonly flushBytes: number = RUN_FLUSH_BYTES) {
    if (!Number.isSafeInteger(flushBytes) || flushBytes < 1) {
      throw new TypeError("Invalid recovery mutation index flush threshold.");
    }
    this.basePath = join(directory, ".private");
  }

  private get runFlushBytes(): number {
    return this.flushBytes;
  }

  /** Aggregate bytes occupied right now by this session's index artifacts. */
  private get ownedBytes(): number {
    let total = 0;
    for (const bytes of this.ownedFiles.values()) total += bytes;
    return total;
  }

  /**
   * Enforce the disk cap BEFORE any growth. `proposed` bytes of new artifacts
   * (run files, merge outputs) are checked against the current session-owned
   * total; merge preflights count output growth on top of still-present inputs.
   */
  private checkCap(proposed: number): Result<void> {
    if (this.ownedBytes + proposed > this.maxDiskBytes) {
      return err("RECOVERY_REQUIRED", "Recovery mutation index disk bound exceeded.", { reason: "resource-limit" });
    }
    return ok(undefined);
  }

  private fileName(index: number): string {
    return join(this.basePath, `${INDEX_FILE_PREFIX}${String(index).padStart(6, "0")}${INDEX_FILE_SUFFIX}`);
  }

  /**
   * Crash-safe allocation manifest.
   *
   * The manifest durably records the highest allocated run number BEFORE the
   * corresponding file can exist, so cleanup never relies on directory
   * contiguity. Merges legitimately delete lower-numbered runs and leave
   * holes; a sweep that stopped at the first missing file would strand the
   * store (Codex RED: runs 000008/000009 surviving restart cleanup).
   *
   * Fixed-width in-place updates keep the crash window safe: a torn manifest
   * fails strict validation and cleanup falls back to the full bounded range
   * (every possible file number is < MAX_INDEX_FILES), so a valid store can
   * never remain stranded by private index debris.
   */
  private get manifestPath(): string {
    return join(this.basePath, MANIFEST_FILE_NAME);
  }

  private manifestBytes(watermark: number): Buffer {
    return Buffer.from(`${MANIFEST_PROFILE}|${this.sessionId}|${String(watermark).padStart(6, "0")}`, "utf8");
  }

  private async writeManifest(watermark: number): Promise<Result<void>> {
    const bytes = this.manifestBytes(watermark);
    // Cap preflight BEFORE any manifest artifact exists or changes:
    // the manifest is a session-owned artifact and counts against maxDiskBytes.
    // Creation adds its exact size; the fixed-width in-place update replaces
    // same-length content, so no second physical file ever exists and the
    // replacement peak equals max(old, new) bytes.
    const oldBytes = this.manifestExists ? (this.ownedFiles.get(this.manifestPath) ?? 0) : 0;
    if (this.ownedBytes - oldBytes + bytes.byteLength > this.maxDiskBytes) {
      return err("RECOVERY_REQUIRED", "Recovery mutation index disk bound exceeded.", { reason: "resource-limit" });
    }
    try {
      if (this.manifestExists) {
        const handle = await this.files.open(this.manifestPath, false);
        try {
          const before = await handle.stat();
          if (before.size !== bytes.byteLength) throw new Error("manifest length changed");
          let written = 0;
          while (written < bytes.byteLength) {
            const count = await handle.write(bytes.subarray(written), written);
            if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - written) throw new Error("short manifest write");
            written += count;
          }
          await handle.sync();
        } finally { await handle.close(); }
        this.ownedFiles.set(this.manifestPath, bytes.byteLength);
        return ok(undefined);
      }
      await this.io.writeExclusive(this.manifestPath, bytes);
      await this.io.syncDirectory(this.basePath);
      this.manifestExists = true;
      this.ownedFiles.set(this.manifestPath, bytes.byteLength);
      return ok(undefined);
    } catch { return err("RECOVERY_REQUIRED", "Cannot persist recovery mutation index manifest."); }
  }

  /**
   * Durable reservation before creating any index file: the manifest high
   * watermark must cover the new file's number, and the manifest update must
   * cross its durability barrier BEFORE the file is created. The run-number
   * namespace bound (0..MAX_INDEX_FILES-1) is enforced here, before any
   * reservation or file creation can succeed.
   */
  private async reserve(index: number): Promise<Result<void>> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_INDEX_FILES) {
      return err("RECOVERY_REQUIRED", "Recovery mutation index file count bound exceeded.", { reason: "resource-limit" });
    }
    if (index <= this.watermark) return ok(undefined);
    const reserved = await this.writeManifest(index);
    if (!reserved.ok) return reserved;
    this.watermark = index;
    return ok(undefined);
  }

  /**
   * Centralized artifact removal with exact accounting semantics.
   * Disk bytes are released from the ledger ONLY after physical removal is
   * established: a failed unlink (other than ENOENT) retains the file's full
   * accounted bytes and its owned-file entry, and propagates the failure.
   * Accounting is never decremented optimistically or in a finally block.
   */
  private async removeOwnedArtifact(path: string): Promise<Result<"removed" | "absent">> {
    try {
      const kind = await this.io.kind(path);
      if (kind === "missing") {
        // Positively established already absent: reconcile the ledger.
        this.ownedFiles.delete(path);
        return ok("absent");
      }
      try {
        await this.io.removeOwnedFile(path);
        this.ownedFiles.delete(path);
        return ok("removed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          this.ownedFiles.delete(path);
          return ok("absent");
        }
        // Any other unlink failure: retain full accounted bytes and entry.
        throw error;
      }
    } catch {
      return err("RECOVERY_REQUIRED", "Cannot remove a recovery mutation index artifact.");
    }
  }

  /**
   * Remove every index-owned artifact. The complete enforced run-number
   * namespace (0..MAX_INDEX_FILES-1) is attempted EVERY time, regardless of
   * the manifest watermark: a syntactically valid manifest can carry a stale
   * LOWER watermark than files actually present (torn in-place update), so the
   * manifest is never the sole cleanup authority. ENOENT is harmless; merge
   * deletion holes and stale high runs are swept. The manifest is removed
   * LAST, after the directory durability barrier.
   */
  private async cleanupArtifacts(): Promise<Result<void>> {
    try {
      const names = Array.from({ length: MAX_INDEX_FILES }, (_, index) => this.fileName(index));
      // Chunked parallel existence checks keep the full-namespace sweep fast.
      const CHUNK = 128;
      for (let start = 0; start < names.length; start += CHUNK) {
        const kinds = await Promise.all(names.slice(start, start + CHUNK)
          .map(path => this.io.kind(path).catch(error => { throw error; })));
        for (let offset = 0; offset < kinds.length; offset++) {
          if (kinds[offset] === "missing") continue;
          const path = names[start + offset]!;
          try { await this.io.removeOwnedFile(path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
            throw error;
          }
          this.ownedFiles.delete(path);
        }
      }
      await this.io.syncDirectory(this.basePath);
      if (await this.io.kind(this.manifestPath) !== "missing") {
        try { await this.io.removeOwnedFile(this.manifestPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        await this.io.syncDirectory(this.basePath);
      }
      this.manifestExists = false;
      return ok(undefined);
    } catch {
      return err("RECOVERY_REQUIRED", "Cannot establish a clean private recovery mutation index namespace.");
    }
  }

  private async ensureOpen(): Promise<Result<void>> {
    if (this.opened) return ok(undefined);
    const kind = await this.io.kind(this.basePath);
    if (kind !== "directory") return err("RECOVERY_REQUIRED", "Store private directory is unavailable.");
    // Sweep any debris from an interrupted session (writer authority is held
    // exclusively by this recovery, so no other session can be active), then
    // reserve a fresh manifest before any run can be created.
    const swept = await this.cleanupArtifacts();
    if (!swept.ok) return swept;
    const manifest = await this.writeManifest(0);
    if (!manifest.ok) return manifest;
    this.watermark = 0;
    this.opened = true;
    return ok(undefined);
  }

  private async flushBuffer(): Promise<Result<void>> {
    if (this.buffer.length === 0) return ok(undefined);
    if (this.nextFile >= MAX_INDEX_FILES) {
      return err("RECOVERY_REQUIRED", "Recovery mutation index file count bound exceeded.", { reason: "resource-limit" });
    }
    // Durable reservation precedes any file creation.
    const reserved = await this.reserve(this.nextFile);
    if (!reserved.ok) return reserved;
    const path = this.fileName(this.nextFile++);
    const sorted = [...this.buffer].sort();
    const bytes = Buffer.from(sorted.join("\n") + "\n", "utf8");
    // Cap check precedes the write: the session never exceeds the configured
    // bound and only detects it afterward.
    const cap = this.checkCap(bytes.byteLength);
    if (!cap.ok) return cap;
    try {
      await this.io.writeExclusive(path, bytes);
      await this.io.syncDirectory(this.basePath);
    } catch { return err("RECOVERY_REQUIRED", "Cannot persist recovery mutation index run."); }
    this.ownedFiles.set(path, bytes.byteLength);
    this.runPaths.push(path);
    this.buffer.length = 0;
    this.bufferBytes = 0;
    return ok(undefined);
  }

  async record(mutationId: MutationId, entry: RecordedMutation): Promise<Result<void>> {
    if (!validMutationId(mutationId) || !validDigest(entry.digest) || !validTxId(entry.txId)) {
      return err("PERSISTENCE_CORRUPTION", "Invalid mutation identity for recovery indexing.");
    }
    const open = await this.ensureOpen();
    if (!open.ok) return open;
    const line = encodeRecord(mutationId, entry);
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      return err("PERSISTENCE_CORRUPTION", "Oversized mutation identity for recovery indexing.");
    }
    this.buffer.push(line);
    this.bufferBytes += Buffer.byteLength(line, "utf8") + 1;
    return this.bufferBytes >= this.runFlushBytes ? this.flushBuffer() : ok(undefined);
  }

  /** Streams the group through a k-way merge, writing one sorted output run. */
  private async mergeRuns(inputs: readonly string[], output: string): Promise<Result<void>> {
    const readers: RunReader[] = [];
    try {
      for (const path of inputs) {
        const reader = await RunReader.open(path, this.files);
        if (!reader.ok) return reader;
        readers.push(reader.value);
        const advanced = await reader.value.advance();
        if (!advanced.ok) return advanced;
      }
      const writer = await RunWriter.open(output, this.files);
      if (!writer.ok) return writer;
      const out = writer.value;
      while (true) {
        let lead = -1;
        for (let index = 0; index < readers.length; index++) {
          const reader = readers[index]!;
          if (!reader.current) continue;
          if (lead < 0) { lead = index; continue; }
          const a = encodeRecord(reader.current.mutationId, reader.current);
          const b = encodeRecord(readers[lead]!.current!.mutationId, readers[lead]!.current!);
          if (a < b) lead = index;
        }
        if (lead < 0) break;
        const written = await out.write(readers[lead]!.current!);
        if (!written.ok) return written;
        const advanced = await readers[lead]!.advance();
        if (!advanced.ok) return advanced;
      }
      const closed = await out.close();
      if (closed.ok) this.mergeOutputBytes.set(output, out.bytesWritten);
      return closed;
    } finally {
      for (const reader of readers) await reader.close().catch(() => undefined);
    }
  }

  /** Final streaming duplicate scan over one sorted, merged group. */
  private async scanGroup(inputs: readonly string[]): Promise<Result<void>> {
    const readers: RunReader[] = [];
    try {
      for (const path of inputs) {
        const reader = await RunReader.open(path, this.files);
        if (!reader.ok) return reader;
        readers.push(reader.value);
        const advanced = await reader.value.advance();
        if (!advanced.ok) return advanced;
      }
      let previous: DecodedRecord | undefined;
      while (true) {
        let lead = -1;
        for (let index = 0; index < readers.length; index++) {
          const reader = readers[index]!;
          if (!reader.current) continue;
          if (lead < 0) { lead = index; continue; }
          const a = encodeRecord(reader.current.mutationId, reader.current);
          const b = encodeRecord(readers[lead]!.current!.mutationId, readers[lead]!.current!);
          if (a < b) lead = index;
        }
        if (lead < 0) return ok(undefined);
        const record = readers[lead]!.current!;
        if (previous && previous.mutationId === record.mutationId
          && (previous.digest !== record.digest || previous.txId !== record.txId)) {
          // Distinct transaction identities (or digests) reused one logical
          // mutation: this is never the harmless physical duplicate case.
          return err("PERSISTENCE_CORRUPTION",
            `Logical mutation repeated under another transaction: ${record.mutationId}`);
        }
        // An identical (mutationId, digest, txId) triple is the same physical
        // transaction frame; frozen WAL semantics replay it exactly once.
        previous = record;
        const advanced = await readers[lead]!.advance();
        if (!advanced.ok) return advanced;
      }
    } finally {
      for (const reader of readers) await reader.close().catch(() => undefined);
    }
  }

  async verifyExact(): Promise<Result<void>> {
    const open = await this.ensureOpen();
    if (!open.ok) return open;
    const flushed = await this.flushBuffer();
    if (!flushed.ok) return flushed;
    let generation = [...this.runPaths];
    while (generation.length > MERGE_FANIN) {
      const merged: string[] = [];
      for (let start = 0; start < generation.length; start += MERGE_FANIN) {
        const group = generation.slice(start, start + MERGE_FANIN);
        if (group.length === 1) { merged.push(group[0]!); continue; }
        if (this.nextFile >= MAX_INDEX_FILES) {
          return err("RECOVERY_REQUIRED", "Recovery mutation index file count bound exceeded.", { reason: "resource-limit" });
        }
        // Conservative merge preflight. Input runs remain on disk until the
        // merge completes, so the merge output's growth is counted ON TOP of
        // the inputs. The bound is exact: the output is a byte-for-byte
        // reordering of the input records.
        let inputBytes = 0;
        for (const path of group) inputBytes += this.ownedFiles.get(path) ?? 0;
        const cap = this.checkCap(inputBytes);
        if (!cap.ok) return cap;
        // Durable reservation precedes merge output creation.
        const reserved = await this.reserve(this.nextFile);
        if (!reserved.ok) return reserved;
        const output = this.fileName(this.nextFile++);
        this.runPaths.push(output);
        const result = await this.mergeRuns(group, output);
        if (!result.ok) return result;
        const written = this.mergeOutputBytes.get(output);
        if (written === undefined) return err("RECOVERY_REQUIRED", "Recovery mutation index accounting failed.");
        this.ownedFiles.set(output, written);
        merged.push(output);
        // Consumed input runs must be physically removed before their bytes
        // are released from the ledger. A failed unlink retains accounted
        // bytes; continuing would write more merge output against imaginary
        // free space, so verification aborts. Canonical storage is untouched;
        // the remaining private artifacts are swept by the next attempt.
        for (const path of group) {
          const removed = await this.removeOwnedArtifact(path);
          if (!removed.ok) return removed;
        }
      }
      generation = merged;
    }
    return this.scanGroup(generation);
  }

  private async removeRun(path: string): Promise<Result<"removed" | "absent">> {
    return this.removeOwnedArtifact(path);
  }

  async reset(): Promise<Result<void>> {
    // Manifest-guided cleanup: every allocated name through the durable high
    // watermark is attempted (ENOENT tolerated), then the barrier, then the
    // manifest is removed last. A crash here is safe: the next session's
    // ensureOpen repeats exactly this protocol.
    const cleaned = await this.cleanupArtifacts();
    if (!cleaned.ok) return cleaned;
    this.runPaths.length = 0;
    this.buffer.length = 0;
    this.bufferBytes = 0;
    this.ownedFiles.clear();
    this.mergeOutputBytes.clear();
    this.nextFile = 0;
    this.watermark = 0;
    this.manifestExists = false;
    this.opened = false;
    return ok(undefined);
  }
}
