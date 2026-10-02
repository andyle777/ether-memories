import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import type { CommittedTip, PersistenceErrorCode, WalOperation } from "../types/persistence.js";
import { parseTransactionSequenceId, sameCommittedTip } from "../utils/durablePersistence.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, sameWalStamp, type WalFileHandle, type WalFileStamp, type WalIO } from "./walIO.js";
import { required, withRecoveryAuthority, type RecoveryAuthority } from "./recoveryAuthority.js";
import { WalFileScan } from "./walFileScan.js";
import { productionRegistry } from "./productionOperations.js";
import { openAuthoritativeReceiptLedger } from "./receiptLedger.js";
import { OBJECT_REFERENCE, validateReference } from "./payloadObjects.js";
import { ETHER_DATA_PROFILE } from "./etherData.js";

/**
 * Tranche 8: payload-object orphan garbage collection.
 *
 * T8 collects ONLY payload objects that no authoritative durable history can
 * ever resolve again. The authoritative payload-object root set is exactly
 * the OBJECT_REFERENCEs of the active WAL plus the OBJECT_REFERENCEs of the
 * authoritative cumulative receipt ledger (checkpoints/StateRoot are inline
 * and contain no object references). Receipt history is indefinite and every
 * committed transaction becomes a receipt entry, so a payload object
 * referenced by any committed transaction is a PERMANENT root; the reclaimable
 * set is therefore provably limited to objects never referenced by committed
 * history (precommit crash orphans and injected debris).
 *
 * Terminal-authority proof: the caller MUST supply the committed tip of a
 * live published generation (expectedTip); G2 proves that the active
 * persistence representation scanned - the terminal tip of the active WAL,
 * or, with the WAL legitimately absent after rotation, the frozen checkpoint
 * tip - reaches EXACTLY that captured tip, using the same frozen precedent
 * as T7 rotation P2. Any mismatch is authoritative inconsistency: GC fails
 * before inventory/coverage/deletion and deletes nothing. The only supported
 * destructive entry point is the runtime facade, which captures the tip from
 * its own live generation; the package exports map blocks consumers from
 * reaching this module directly.
 *
 * Scratch integrity (exact-content binding): every generated scratch artifact
 * is sealed with a constant-size in-memory descriptor - record count, exact
 * canonical byte length and a SHA-256 computed from the INTENDED output while
 * it is generated. After write+fsync the artifact is read back and verified
 * (digest, count, canonical encoding, strict ordering). A sealed run may only
 * be consumed through a SealedRunReader that opens ONE handle, fully verifies
 * the content on that handle, then streams records from the SAME handle with
 * a second full-content hash assertion at end-of-stream and stamp checks
 * before reclaim unlinks. Substitution of legal, sorted, same-count digest
 * records at ANY point in the chain mark-runs -> cascade outputs ->
 * candidates -> validated -> unlink therefore fails closed: no shape-only
 * validation ever serves as deletion authority. Descriptors are in-memory
 * session state only; GC crash debris is swept, never resumed as trusted
 * state, so no new durable on-disk format exists.
 *
 * Failure dispositions: every error this module returns carries
 * details.gcDisposition - "authoritative" (corrupt history, terminal-tip
 * mismatch, a marked object missing from the physical inventory, malformed
 * persisted references) or "maintenance" (all scratch create/write/sync/
 * verify/read failures, enumeration failures, unlink/barrier failures).
 * Authority-layer uncertainty (writer-lock release failures) is marked by the
 * authority coordinator with details.authorityReleaseFailed and outranks
 * every disposition. The runtime applies that explicit precedence:
 * authority > authoritative > maintenance.
 *
 * Threat-model boundary (frozen at T1/T2, unchanged by T8): concurrent
 * external/malicious replacement of store namespace entries while authority
 * is held is OUTSIDE the persistence contract ("this is not a defense
 * against malicious filesystem-owner/root replacement races"). Static symlink
 * entries are never followed and never deleted: readNames yields names only,
 * entry validation uses lstat via kind(), and unlink removes a final-component
 * link entry itself rather than following it. Conforming writers are excluded
 * by the held writer authority.
 *
 * Bounded memory, unbounded history: both mark and inventory streams go
 * through a two-bank external cascade sort (`.private/gc-{stream}-{a|b}-{slot}.run`,
 * 128 slots per bank, 512 digests per chunk). When the active bank fills,
 * all its runs merge into ONE sealed run in the (empty) opposite bank, the
 * consumed inputs are unlinked, and the banks swap roles. Merge output and a
 * run being consumed can never share a slot; capacity grows level by level,
 * so the bounded namespace imposes NO total object/history ceiling. All GC
 * scratch is deterministic and swept at G1 and G7 of every attempt.
 */

export const GC_SCRATCH_NAMESPACE_SIZE = 128;
export const GC_SORT_CHUNK_ENTRIES = 512;
export const GC_UNLINK_BATCH = 64;
export const OBJECT_NAME_PATTERN = /^[0-9a-f]{64}\.bin$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_BYTES = 65;

export type GcStream = "mark" | "inventory";
export type GcPhase =
  | "G1-scratch-sweep" | "G2-mark" | "G2-mark-scratch" | "G3-inventory" | "G4-coverage"
  | "G5-validate" | "G6-reclaim" | "G7-final-cleanup";
/**
 * Internal failure disposition; never a public error code. "authoritative"
 * proves persisted authority uncertain; "maintenance" touches only GC-owned
 * scratch/objects-namespace work and never makes the runtime unready.
 */
export type GcDisposition = "maintenance" | "authoritative";
/** Trusted test instrumentation only; a throw simulates a crash at that boundary. */
export interface GcInstrumentation { at(phase: GcPhase): Promise<void> }

export interface GcScratchOptions {
  /** Sorter slots per bank (test injection; production default 128). */
  readonly namespaceSlots?: number;
  /** Digest entries per sorted chunk run (test injection; production default 512). */
  readonly chunkEntries?: number;
  /** Candidate unlinks per objects/ directory barrier (test injection; production default 64). */
  readonly unlinkBatch?: number;
}
export interface GcLimits {
  readonly namespaceSlots: number;
  readonly chunkEntries: number;
  readonly unlinkBatch: number;
}
export function gcLimits(options: GcScratchOptions = {}): Result<GcLimits> {
  if (typeof options !== "object" || options === null) return err("INVALID_INPUT", "GC limits must be an object.");
  const slots = options.namespaceSlots ?? GC_SCRATCH_NAMESPACE_SIZE;
  const chunk = options.chunkEntries ?? GC_SORT_CHUNK_ENTRIES;
  const batch = options.unlinkBatch ?? GC_UNLINK_BATCH;
  if (!Number.isSafeInteger(slots) || slots < 2 || slots > GC_SCRATCH_NAMESPACE_SIZE
    || !Number.isSafeInteger(chunk) || chunk < 1 || chunk > GC_SORT_CHUNK_ENTRIES
    || !Number.isSafeInteger(batch) || batch < 1 || batch > GC_UNLINK_BATCH) {
    return err("INVALID_INPUT", "GC limits must be integers within their frozen bounds.");
  }
  return ok({ namespaceSlots: slots, chunkEntries: chunk, unlinkBatch: batch });
}

const scratchRun = (stream: GcStream, bank: "a" | "b", index: number) =>
  `gc-${stream}-${bank}-${String(index).padStart(6, "0")}.run`;
export const GC_CANDIDATES_NAME = "gc-candidates-000000.run";
export const GC_VALIDATED_NAME = "gc-validated-000000.run";

/** Deterministic GC scratch paths: both streams, both banks, both single artifacts. */
const gcScratchNames = (limits: GcLimits): string[] => {
  const names: string[] = [GC_CANDIDATES_NAME, GC_VALIDATED_NAME];
  for (const stream of ["mark", "inventory"] as const) {
    for (const bank of ["a", "b"] as const) {
      for (let index = 0; index < limits.namespaceSlots; index++) names.push(scratchRun(stream, bank, index));
    }
  }
  return names;
};

const isHex = (value: string) => DIGEST_PATTERN.test(value);
/** Frozen unsigned lexicographic UTF-8 byte order; identical ordering to the receipt comparator on hex digests. */
export const compareDigests = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const ioFailureCode = (error: unknown): PersistenceErrorCode => {
  if (error instanceof DirectoryIoError) return error.code;
  const native = (error as NodeJS.ErrnoException | null)?.code;
  if (native === "EACCES" || native === "EPERM" || native === "EROFS") return "READ_ONLY_LOCKED";
  return "RECOVERY_REQUIRED";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** GC-internal error constructor: every error carries its phase AND disposition. */
const gcError = (code: PersistenceErrorCode, message: string, phase: GcPhase, disposition: GcDisposition,
  extra?: Record<string, unknown>): Result<never> =>
  err(code, message, { gcPhase: phase, gcDisposition: disposition, ...extra });

/**
 * Constant-size in-memory content binding for one owned scratch run: the
 * record count, exact canonical byte length and the SHA-256 of the exact
 * bytes the generating computation intended. Computed while generating;
 * verified by read-back after fsync; re-verified on every later open.
 */
export interface SealedRun {
  readonly path: string;
  readonly records: number;
  readonly byteLength: number;
  readonly sha256: string;
}

const recordBytes = (digest: string): Buffer => Buffer.from(digest + "\n", "utf8");

/**
 * Streams one scratch run to disk, hashing the exact canonical bytes it
 * intends to write. close() fsyncs, then fully reads the artifact back and
 * proves the physical bytes still equal the intended content (digest, count,
 * canonical encoding, strict ordering) before the run may be consumed.
 */
class RunWriter {
  private handle?: WalFileHandle;
  private position = 0;
  private records = 0;
  private readonly hash = createHash("sha256");

  constructor(private readonly path: string, private readonly files: WalIO, private readonly phase: GcPhase) {}

  async open(): Promise<Result<undefined>> {
    try {
      this.handle = await this.files.open(this.path, true);
      return ok(undefined);
    } catch (error) {
      return gcError(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC scratch run creation failed.", this.phase, "maintenance");
    }
  }

  async append(digest: string): Promise<Result<undefined>> {
    const handle = this.handle;
    if (!handle) return gcError("RECOVERY_REQUIRED", "GC scratch run is not open.", this.phase, "maintenance");
    try {
      const record = recordBytes(digest);
      await handle.write(record, this.position);
      this.position += record.byteLength;
      this.records++;
      this.hash.update(record);
      return ok(undefined);
    } catch (error) {
      return gcError(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC scratch run write failed.", this.phase, "maintenance");
    }
  }

  /** Close without verification; error-path cleanup only. */
  async dispose(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.close().catch(() => undefined);
  }

  async close(): Promise<Result<SealedRun>> {
    const handle = this.handle;
    if (!handle) return gcError("RECOVERY_REQUIRED", "GC scratch run is not open.", this.phase, "maintenance");
    const descriptor: SealedRun = { path: this.path, records: this.records, byteLength: this.position,
      sha256: this.hash.digest("hex") };
    try {
      await handle.sync();
      await handle.close();
    } catch (error) {
      this.handle = undefined;
      await handle.close().catch(() => undefined);
      return gcError(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
        "GC scratch run sync failed.", this.phase, "maintenance");
    }
    this.handle = undefined;
    const verified = await verifySealedRun(descriptor, this.files, this.phase, "maintenance");
    return verified.ok ? ok(descriptor) : verified;
  }
}

/** One strict pass over a run's bytes: canonical records, ascending, hashed. */
async function scanRunBytes(handle: WalFileHandle, byteLength: number, phase: GcPhase,
  disposition: GcDisposition): Promise<Result<{ sha256: string; records: number }>> {
  const hash = createHash("sha256");
  const chunk = new Uint8Array(RECORD_BYTES * 256);
  let position = 0;
  let seen = 0;
  let last: string | undefined;
  while (position < byteLength) {
    const want = Math.min(chunk.byteLength, byteLength - position);
    let read = 0;
    while (read < want) {
      const count = await handle.read(chunk.subarray(read, want), position + read);
      if (count <= 0) return gcError("PERSISTENCE_CORRUPTION", "GC scratch run ended early.", phase, disposition);
      read += count;
    }
    position += want;
    hash.update(chunk.subarray(0, want));
    for (let offset = 0; offset < want; offset += RECORD_BYTES) {
      const record = chunk.subarray(offset, offset + RECORD_BYTES);
      const digest = Buffer.from(record.subarray(0, 64)).toString("utf8");
      if (record[64] !== 10 || !isHex(digest)) {
        return gcError("PERSISTENCE_CORRUPTION", "GC scratch run is not canonically encoded.", phase, disposition);
      }
      if (last !== undefined && compareDigests(digest, last) <= 0) {
        return gcError("PERSISTENCE_CORRUPTION", "GC scratch run is not strictly increasing.", phase, disposition);
      }
      last = digest;
      seen++;
    }
  }
  return ok({ sha256: hash.digest("hex"), records: seen });
}

/**
 * Full read-back verification of one sealed run against its binding: the
 * physical bytes must hash to the intended SHA-256, with the exact byte
 * length, record count, canonical encoding and strict ascending order.
 */
async function verifySealedRun(descriptor: SealedRun, files: WalIO, phase: GcPhase,
  disposition: GcDisposition): Promise<Result<undefined>> {
  let handle: WalFileHandle;
  try {
    handle = await files.open(descriptor.path, false);
  } catch (error) {
    return gcError(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
      "GC scratch run read-back failed.", phase, disposition);
  }
  try {
    const size = (await handle.stat()).size;
    if (size !== descriptor.byteLength) {
      return gcError("PERSISTENCE_CORRUPTION", "GC scratch run byte length differs from its binding.",
        phase, disposition);
    }
    const scanned = await scanRunBytes(handle, size, phase, disposition);
    if (!scanned.ok) return scanned;
    if (scanned.value.records !== descriptor.records) {
      return gcError("PERSISTENCE_CORRUPTION", "GC scratch run record count differs from its binding.",
        phase, disposition);
    }
    if (scanned.value.sha256 !== descriptor.sha256) {
      return gcError("PERSISTENCE_CORRUPTION", "GC scratch run content differs from its exact-content binding.",
        phase, disposition);
    }
    return ok(undefined);
  } finally {
    await handle.close();
  }
}

/**
 * Verified reader over one sealed run. open() captures ONE handle plus its
 * file stamp and fully verifies the content binding on that handle BEFORE
 * any record is consumed; records then stream from the SAME handle (no path
 * reopen between verification and trusted consumption), re-hashing as they
 * stream, with the full-content hash asserted at end of stream. The captured
 * stamp is re-checked before destructive use (G6 unlinks).
 */
export class SealedRunReader {
  private constructor(private readonly handle: WalFileHandle, private readonly descriptor: SealedRun,
    private readonly stamp: WalFileStamp, private readonly phase: GcPhase,
    private readonly hash = createHash("sha256"), private consumed = 0) {}

  static async open(descriptor: SealedRun, files: WalIO, phase: GcPhase,
    disposition: GcDisposition): Promise<Result<SealedRunReader>> {
    let handle: WalFileHandle;
    let stamp: WalFileStamp;
    try {
      handle = await files.open(descriptor.path, false);
      stamp = await handle.stat();
    } catch (error) {
      return gcError(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC sealed run open failed.", phase, disposition);
    }
    try {
      if (stamp.size !== descriptor.byteLength) {
        return gcError("PERSISTENCE_CORRUPTION", "GC sealed run byte length differs from its binding.",
          phase, disposition);
      }
      const scanned = await scanRunBytes(handle, stamp.size, phase, disposition);
      if (!scanned.ok) return scanned;
      if (scanned.value.records !== descriptor.records || scanned.value.sha256 !== descriptor.sha256) {
        return gcError("PERSISTENCE_CORRUPTION", "GC sealed run content differs from its exact-content binding.",
          phase, disposition);
      }
      return ok(new SealedRunReader(handle, descriptor, stamp, phase));
    } catch (error) {
      return gcError(error instanceof DirectoryIoError ? error.code : ioFailureCode(error),
        "GC sealed run verification failed.", phase, disposition);
    }
  }

  /** Stream the next record from the same verified handle. */
  async next(): Promise<Result<string | undefined>> {
    if (this.consumed >= this.descriptor.records) return ok(undefined);
    const record = new Uint8Array(RECORD_BYTES);
    let read = 0;
    while (read < RECORD_BYTES) {
      const count = await this.handle.read(record.subarray(read), this.consumed * RECORD_BYTES + read);
      if (count <= 0) {
        return gcError("PERSISTENCE_CORRUPTION", "GC sealed run ended early during consumption.",
          this.phase, "maintenance");
      }
      read += count;
    }
    const digest = Buffer.from(record.subarray(0, 64)).toString("utf8");
    if (record[64] !== 10 || !isHex(digest)) {
      return gcError("PERSISTENCE_CORRUPTION", "GC sealed run is not canonically encoded during consumption.",
        this.phase, "maintenance");
    }
    this.hash.update(record);
    this.consumed++;
    return ok(digest);
  }

  /** Final exact-content assertion over the consumed stream. */
  verifyConsumed(): Result<undefined> {
    return this.consumed === this.descriptor.records && this.hash.digest("hex") === this.descriptor.sha256
      ? ok(undefined)
      : gcError("PERSISTENCE_CORRUPTION", "GC sealed run consumption differs from its exact-content binding.",
        this.phase, "maintenance");
  }

  /** Stamp stability of the same opened handle, before destructive use. */
  async checkStamp(): Promise<Result<undefined>> {
    try {
      const current = await this.handle.stat();
      if (!sameWalStamp(this.stamp, current)) {
        return gcError("RECOVERY_REQUIRED", "GC sealed run changed during consumption.", this.phase, "maintenance");
      }
      return ok(undefined);
    } catch {
      return gcError("RECOVERY_REQUIRED", "GC sealed run stamp check failed.", this.phase, "maintenance");
    }
  }

  async close(): Promise<void> { await this.handle.close(); }
}

/**
 * Two-bank bounded external digest sorter with exact-content bindings on
 * every generated run. Ingestion buffers `chunkEntries` digests in RAM and
 * flushes them as one sorted, sealed run into the ACTIVE bank; when the
 * active bank holds `namespaceSlots` runs, ALL of them are opened as sealed
 * readers (each re-verified on open), stream-merged into ONE sealed output
 * run in the (necessarily empty) opposite bank, the consumed input runs are
 * unlinked, and the banks swap roles.
 */
export class GcDigestSorter {
  private bank: "a" | "b" = "a";
  private runs: Record<"a" | "b", SealedRun[]> = { a: [], b: [] };
  private buffer: string[] = [];

  constructor(private readonly directory: string, private readonly stream: GcStream,
    private readonly io: DirectoryIO, private readonly files: WalIO, private readonly limits: GcLimits) {}

  private runPath(bank: "a" | "b", index: number): string {
    return join(this.directory, ".private", scratchRun(this.stream, bank, index));
  }

  private scratchPhase(): GcPhase {
    return this.stream === "mark" ? "G2-mark-scratch" : "G3-inventory";
  }

  async add(digest: string): Promise<Result<undefined>> {
    if (typeof digest !== "string" || !isHex(digest)) {
      return gcError("PERSISTENCE_CORRUPTION", "GC sorter requires an exact 64-hex digest.",
        this.scratchPhase(), "maintenance");
    }
    this.buffer.push(digest);
    if (this.buffer.length >= this.limits.chunkEntries) return this.flushChunk();
    return ok(undefined);
  }

  private async flushChunk(): Promise<Result<undefined>> {
    if (this.buffer.length === 0) return ok(undefined);
    if (this.runs[this.bank].length >= this.limits.namespaceSlots) {
      const cascaded = await this.cascade();
      if (!cascaded.ok) return cascaded;
    }
    const index = this.runs[this.bank].length;
    const sorted = [...new Set(this.buffer)].sort(compareDigests);
    this.buffer = [];
    // Reserve before create: the slot index is claimed in memory first; the
    // physical exclusive create then proves no debris occupies the path.
    const writer = new RunWriter(this.runPath(this.bank, index), this.files, this.scratchPhase());
    const opened = await writer.open();
    if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
    try {
      for (const digest of sorted) {
        const appended = await writer.append(digest);
        if (!appended.ok) return err(appended.error.code as PersistenceErrorCode, appended.error.message, appended.error.details);
      }
      const sealed = await writer.close();
      if (!sealed.ok) return err(sealed.error.code as PersistenceErrorCode, sealed.error.message, sealed.error.details);
      this.runs[this.bank].push(sealed.value);
      return ok(undefined);
    } catch (error) {
      await writer.dispose();
      return gcError(ioFailureCode(error), "GC chunk run write failed.", this.scratchPhase(), "maintenance");
    }
  }

  /**
   * Merge every sealed run of the active bank into one sealed, verified run
   * in the opposite bank, unlink the consumed inputs, barrier .private and
   * swap bank roles. The opposite bank is always empty at this point.
   */
  private async cascade(): Promise<Result<undefined>> {
    const from = this.bank;
    const to: "a" | "b" = from === "a" ? "b" : "a";
    if (this.runs[to].length !== 0) {
      return gcError("RECOVERY_REQUIRED", "GC cascade output bank is not empty.", this.scratchPhase(), "maintenance");
    }
    const inputs = this.runs[from];
    const readers: SealedRunReader[] = [];
    const writer = new RunWriter(this.runPath(to, 0), this.files, this.scratchPhase());
    let writerOpen = false;
    try {
      for (const input of inputs) {
        const reader = await SealedRunReader.open(input, this.files, this.scratchPhase(), "maintenance");
        if (!reader.ok) return reader;
        readers.push(reader.value);
      }
      const opened = await writer.open();
      if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
      writerOpen = true;
      const current: (string | undefined)[] = [];
      for (const reader of readers) {
        const first = await reader.next();
        if (!first.ok) return first;
        current.push(first.value);
      }
      let last: string | undefined;
      for (;;) {
        let best: string | undefined;
        let bestIndex = -1;
        for (let index = 0; index < current.length; index++) {
          const value = current[index]!;
          if (value !== undefined && (best === undefined || compareDigests(value, best) < 0)) {
            best = value; bestIndex = index;
          }
        }
        if (best === undefined) break;
        const advanced = await readers[bestIndex]!.next();
        if (!advanced.ok) return advanced;
        current[bestIndex] = advanced.value;
        // Set semantics: duplicate marks collapse; duplicate inventory names are impossible.
        if (last !== undefined && compareDigests(best, last) === 0) continue;
        const appended = await writer.append(best);
        if (!appended.ok) return err(appended.error.code as PersistenceErrorCode, appended.error.message, appended.error.details);
        last = best;
      }
      for (const reader of readers) {
        const consumed = reader.verifyConsumed();
        if (!consumed.ok) return err(consumed.error.code as PersistenceErrorCode, consumed.error.message, consumed.error.details);
      }
      const sealed = await writer.close();
      if (!sealed.ok) return err(sealed.error.code as PersistenceErrorCode, sealed.error.message, sealed.error.details);
      writerOpen = false;
      // Output is complete and content-bound; only now may inputs go away.
      for (const input of inputs) {
        try { await this.io.removeOwnedFile(input.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          return gcError(ioFailureCode(error), "GC cascade input reclamation failed.",
            this.scratchPhase(), "maintenance");
        }
      }
      try { await this.io.syncDirectory(join(this.directory, ".private")); }
      catch (error) {
        return gcError(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
          "GC cascade scratch barrier failed.", this.scratchPhase(), "maintenance");
      }
      this.runs[from] = [];
      this.runs[to] = [sealed.value];
      this.bank = to;
      return ok(undefined);
    } finally {
      for (const reader of readers) await reader.close().catch(() => undefined);
      if (writerOpen) await writer.dispose();
    }
  }

  /**
   * Flush, then collapse the active bank to exactly one sealed, deduplicated,
   * read-back-verified run. Empty input yields no run at all.
   */
  async finish(): Promise<Result<SealedRun | undefined>> {
    const flushed = await this.flushChunk();
    if (!flushed.ok) return flushed;
    if (this.runs[this.bank].length === 0) return ok(undefined);
    const cascaded = await this.cascade();
    if (!cascaded.ok) return cascaded;
    return ok(this.runs[this.bank][0]!);
  }

  /** Best-effort sweep on failure paths; the authoritative sweep is sweepGcScratch. */
  async sweep(): Promise<void> {
    for (const bank of ["a", "b"] as const) {
      for (const run of this.runs[bank]) {
        try { await this.io.removeOwnedFile(run.path); } catch { /* absent: fine */ }
      }
      this.runs[bank] = [];
    }
  }
}

/**
 * Authoritative sweep of the complete deterministic GC scratch namespace.
 * ENOENT is idempotent success; every other removal or barrier failure is
 * observable and fails the maintenance operation without touching authority.
 */
export async function sweepGcScratch(directory: string, io: DirectoryIO, limits: GcLimits,
  phase: GcPhase): Promise<Result<undefined>> {
  for (const name of gcScratchNames(limits)) {
    try { await io.removeOwnedFile(join(directory, ".private", name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return gcError(ioFailureCode(error), "GC scratch cleanup failed.", phase, "maintenance");
    }
  }
  try { await io.syncDirectory(join(directory, ".private")); }
  catch (error) {
    return gcError(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
      "GC scratch cleanup barrier failed.", phase, "maintenance");
  }
  return ok(undefined);
}

/**
 * Extract the authoritative payload-object digest of one persisted WAL/receipt
 * operation: an OBJECT_REFERENCE contributes its digest; an inline production
 * envelope contributes nothing. This reads PERSISTED AUTHORITATIVE DATA, not
 * caller input: a malformed persisted reference is corruption, never
 * INVALID_INPUT. (Caller-facing reference validation keeps its own frozen
 * INVALID_INPUT behavior at install boundaries.)
 */
export function extractObjectDigest(operation: WalOperation): Result<string | undefined> {
  const payload = operation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return err("PERSISTENCE_CORRUPTION", "Malformed persisted operation payload.");
  }
  const encoding = (payload as Record<string, unknown>).encoding;
  if (encoding === ETHER_DATA_PROFILE) return ok(undefined);
  if (encoding !== OBJECT_REFERENCE) return err("PERSISTENCE_CORRUPTION", "Unknown persisted operation encoding.");
  const reference = validateReference(payload);
  return reference.ok ? ok(reference.value.digest)
    : err("PERSISTENCE_CORRUPTION", "Malformed persisted OBJECT_REFERENCE in authoritative history.");
}

export interface GcCoverage {
  readonly candidatesRun?: SealedRun;
  readonly candidates: number;
  readonly reachable: number;
}

/**
 * G4: the exact sorted reachability merge over sealed runs. Proves BOTH
 * directions before any deletion can occur:
 *   inventory - marks  -> sealed reclaim candidates (exact-content bound);
 *   marks    - inventory -> PERSISTENCE_CORRUPTION (authoritative: a required
 *   authoritative object is physically missing), for active-WAL and receipt
 *   marks alike.
 * Any scratch read/integrity failure is maintenance: nothing is deleted and
 * the runtime stays ready.
 */
export async function deriveReclaimCandidates(markRun: SealedRun | undefined, inventoryRun: SealedRun | undefined,
  candidatesPath: string, files: WalIO): Promise<Result<GcCoverage>> {
  let markReader: SealedRunReader | undefined;
  let inventoryReader: SealedRunReader | undefined;
  if (markRun) {
    const opened = await SealedRunReader.open(markRun, files, "G4-coverage", "maintenance");
    if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
    markReader = opened.value;
  }
  if (inventoryRun) {
    const opened = await SealedRunReader.open(inventoryRun, files, "G4-coverage", "maintenance");
    if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
    inventoryReader = opened.value;
  }
  const writer = new RunWriter(candidatesPath, files, "G4-coverage");
  let writerOpen = false;
  try {
    const pull = async (reader: SealedRunReader | undefined): Promise<Result<string | undefined>> =>
      reader ? reader.next() : ok(undefined);
    let mark = (await pull(markReader));
    if (!mark.ok) return mark;
    let inventory = (await pull(inventoryReader));
    if (!inventory.ok) return inventory;
    let candidates = 0;
    let reachable = 0;
    let lastCandidate: string | undefined;
    const emitCandidate = async (digest: string): Promise<Result<undefined>> => {
      if (lastCandidate === undefined || compareDigests(digest, lastCandidate) > 0) {
        if (!writerOpen) {
          const opened = await writer.open();
          if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
          writerOpen = true;
        }
        const appended = await writer.append(digest);
        if (!appended.ok) return err(appended.error.code as PersistenceErrorCode, appended.error.message, appended.error.details);
        candidates++;
        lastCandidate = digest;
      }
      return ok(undefined);
    };
    for (;;) {
      if (mark.value !== undefined && inventory.value !== undefined) {
        const order = compareDigests(mark.value, inventory.value);
        if (order === 0) {
          reachable++;
          mark = await pull(markReader);
          if (!mark.ok) return mark;
          inventory = await pull(inventoryReader);
          if (!inventory.ok) return inventory;
          continue;
        }
        if (order < 0) {
          // The smallest remaining mark is below the current inventory item:
          // no physical object can match it - missing authoritative object.
          return gcError("PERSISTENCE_CORRUPTION",
            "A payload object required by authoritative history is missing from the physical inventory.",
            "G4-coverage", "authoritative", { missingDigest: mark.value });
        }
        const emitted = await emitCandidate(inventory.value);
        if (!emitted.ok) return emitted;
        inventory = await pull(inventoryReader);
        if (!inventory.ok) return inventory;
        continue;
      }
      if (mark.value !== undefined) {
        return gcError("PERSISTENCE_CORRUPTION",
          "Authoritative payload-object references exceed the physical inventory.",
          "G4-coverage", "authoritative", { missingDigest: mark.value });
      }
      if (inventory.value !== undefined) {
        const emitted = await emitCandidate(inventory.value);
        if (!emitted.ok) return emitted;
        inventory = await pull(inventoryReader);
        if (!inventory.ok) return inventory;
        continue;
      }
      break;
    }
    if (markReader) {
      const consumed = markReader.verifyConsumed();
      if (!consumed.ok) return err(consumed.error.code as PersistenceErrorCode, consumed.error.message, consumed.error.details);
    }
    if (inventoryReader) {
      const consumed = inventoryReader.verifyConsumed();
      if (!consumed.ok) return err(consumed.error.code as PersistenceErrorCode, consumed.error.message, consumed.error.details);
    }
    if (!writerOpen) return ok({ candidatesRun: undefined, candidates, reachable });
    const sealed = await writer.close();
    if (!sealed.ok) return err(sealed.error.code as PersistenceErrorCode, sealed.error.message, sealed.error.details);
    writerOpen = false;
    return ok({ candidatesRun: candidates > 0 ? sealed.value : undefined, candidates, reachable });
  } catch (error) {
    return gcError(error instanceof DirectoryIoError ? error.code : ioFailureCode(error),
      "GC reachability merge failed.", "G4-coverage", "maintenance");
  } finally {
    await markReader?.close().catch(() => undefined);
    await inventoryReader?.close().catch(() => undefined);
    if (writerOpen) await writer.dispose();
  }
}

export interface GcOutcome {
  readonly scannedObjects: number;
  readonly markedReferences: number;
  readonly reclaimedObjects: number;
  readonly unknownArtifacts: number;
}

export interface GcInput {
  readonly directory: string;
  readonly io?: DirectoryIO;
  readonly files?: WalIO;
  readonly instrumentation?: GcInstrumentation;
  readonly limits?: GcScratchOptions;
  /**
   * REQUIRED: the committed tip of a live published generation. G2 proves the
   * scanned active persistence representation reaches exactly this tip before
   * any coverage or deletion. The only supported destructive caller is the
   * runtime facade, which captures this from its own live generation; the
   * package exports map keeps external consumers away from this module.
   */
  readonly expectedTip: CommittedTip;
}

/**
 * G0-G7 payload-object orphan collection under one exclusive writer-authority
 * hold. G0 is the authority acquisition itself. No phase mutates authority:
 * G2/G3 only read authoritative sources and write bound scratch; G4 proves
 * complete bidirectional coverage over sealed runs; G5 revalidates each
 * candidate and seals the validated stream; G6 unlinks only records consumed
 * from the same verified handle that proved their exact content, with stamp
 * checks before each unlink; G7 sweeps scratch. Interruption at any point
 * leaves authority, StateRoot and tip untouched and is safely retryable.
 */
export async function collectDurableGarbage(input: GcInput): Promise<Result<GcOutcome>> {
  const io = input.io ?? nodeDirectoryIO;
  const files = input.files ?? nodeWalIO;
  const instrumentation = input.instrumentation ?? { at: async () => undefined };
  const limits = gcLimits(input.limits);
  if (!limits.ok) return limits;
  const directory = input.directory;
  if (!input.expectedTip || !parseTransactionSequenceId(input.expectedTip.txId).ok) {
    return err("INVALID_INPUT", "An exact committed tip of a live published generation is required.");
  }
  const expectedTip = input.expectedTip;
  let unknownArtifacts = 0;
  let markedReferences = 0;
  let scannedObjects = 0;
  let reclaimedObjects = 0;
  let phase: GcPhase = "G1-scratch-sweep";
  let disposition: GcDisposition = "maintenance";
  const at = async (next: GcPhase, nextDisposition: GcDisposition = "maintenance") => {
    phase = next;
    disposition = nextDisposition;
    await instrumentation.at(next);
  };
  const objectsDir = join(directory, "objects");

  return withRecoveryAuthority(directory, io, async (authority: RecoveryAuthority) => {
    let markRun: SealedRun | undefined;
    let inventoryRun: SealedRun | undefined;
    const markSorter = new GcDigestSorter(directory, "mark", io, files, limits.value);
    const inventorySorter = new GcDigestSorter(directory, "inventory", io, files, limits.value);
    try {
      // G1: deterministic scratch sweep; ENOENT is idempotent success.
      await instrumentation.at("G1-scratch-sweep");
      const swept = await sweepGcScratch(directory, io, limits.value, phase);
      if (!swept.ok) return err(swept.error.code as PersistenceErrorCode, swept.error.message, swept.error.details);

      // G2: authoritative mark collection. The ledger is fully digest-verified
      // during traversal; the WAL is scanned by the frozen scanner and must
      // terminate at exactly the captured committed tip. Sorter/scratch
      // failures during marking are MAINTENANCE failures.
      await at("G2-mark", "authoritative");
      const addMark = async (digest: string): Promise<void> => {
        const added = await markSorter.add(digest);
        if (!added.ok) {
          throw new DirectoryIoError(added.error.code as DirectoryIoError["code"], added.error.message,
            { gcPhase: "G2-mark-scratch", gcDisposition: "maintenance" });
        }
      };
      const head = authority.head;
      const ledger = await openAuthoritativeReceiptLedger(directory, head.storeId, head.epochId,
        head.checkpoint.checkpointId, files);
      if (!ledger.ok) {
        return gcError(ledger.error.code as PersistenceErrorCode, ledger.error.message, phase, "authoritative");
      }
      if (ledger.value) {
        const verified = await ledger.value.verify(async entry => {
          for (const operation of entry.operations) {
            const digest = required(extractObjectDigest(operation));
            if (digest !== undefined) await addMark(digest);
          }
        });
        if (!verified.ok) {
          return gcError(verified.error.code as PersistenceErrorCode, verified.error.message, phase, "authoritative");
        }
      }
      const walPath = join(directory, "wal", `wal-${head.checkpoint.digest}.bin`);
      const walKind = await io.kind(walPath);
      if (walKind === "directory") return gcError("RECOVERY_REQUIRED", "Unsafe WAL path.", phase, "authoritative");
      if (walKind === "file") {
        let handle;
        let terminalTip: CommittedTip | undefined;
        try {
          handle = await files.open(walPath, false);
          const scan = required(await WalFileScan.open(walPath, handle, head, productionRegistry, files,
            { mode: "authority-held", verifyAuthority: authority.verify }));
          let cursor = scan.cursor();
          do {
            const batch = required(await scan.next(cursor));
            cursor = batch.continuation;
            for (const transaction of batch.transactions) {
              for (const operation of transaction.operations) {
                const digest = required(extractObjectDigest(operation));
                if (digest !== undefined) await addMark(digest);
              }
            }
          } while (!cursor.ended);
          terminalTip = cursor.tip;
        } finally {
          if (handle) await handle.close();
        }
        // Terminal-authority proof (frozen T7 rotation-P2 precedent).
        if (!sameCommittedTip(terminalTip!, expectedTip)) {
          return gcError("RECOVERY_REQUIRED",
            "The active WAL does not terminate at the captured committed tip; recover before collecting garbage.",
            phase, "authoritative", { capturedTip: { ...expectedTip }, durableTip: { ...terminalTip! } });
        }
      } else if (!sameCommittedTip(head.checkpoint.tip, expectedTip)) {
        // WAL legitimately absent (post-rotation): the frozen checkpoint
        // authority must already represent the captured committed tip.
        return gcError("RECOVERY_REQUIRED",
          "The active WAL is absent but the checkpoint does not represent the captured committed tip; recover before collecting garbage.",
          phase, "authoritative", { capturedTip: { ...expectedTip }, checkpointTip: { ...head.checkpoint.tip } });
      }
      await authority.verify();
      const finishedMark = await markSorter.finish();
      if (!finishedMark.ok) return err(finishedMark.error.code as PersistenceErrorCode, finishedMark.error.message, finishedMark.error.details);
      markRun = finishedMark.value;
      markedReferences = markRun?.records ?? 0;

      // G3: physical inventory enumeration. Only valid-name REGULAR files are
      // inventory items; malformed names, dotfiles, directories and symlinks
      // are never deleted, never followed and count as unknown artifacts.
      await at("G3-inventory", "maintenance");
      const objectsKind = await io.kind(objectsDir);
      if (objectsKind === "file") {
        return gcError("RECOVERY_REQUIRED", "Unsafe payload-object directory.", phase, "maintenance");
      }
      if (objectsKind === "directory") {
        await io.readNames(objectsDir, async name => {
          if (!OBJECT_NAME_PATTERN.test(name)) { unknownArtifacts++; return; }
          try {
            if (await io.kind(join(objectsDir, name)) !== "file") { unknownArtifacts++; return; }
          } catch { unknownArtifacts++; return; }
          const added = await inventorySorter.add(name.slice(0, 64));
          if (!added.ok) {
            throw new DirectoryIoError(added.error.code as DirectoryIoError["code"], added.error.message,
              { gcPhase: "G3-inventory", gcDisposition: "maintenance" });
          }
        });
      }
      const finishedInventory = await inventorySorter.finish();
      if (!finishedInventory.ok) return err(finishedInventory.error.code as PersistenceErrorCode, finishedInventory.error.message, finishedInventory.error.details);
      inventoryRun = finishedInventory.value;
      scannedObjects = inventoryRun?.records ?? 0;

      // G4: bidirectional coverage proof over sealed runs; no deletion may
      // occur before it succeeds completely.
      await at("G4-coverage", "maintenance");
      await authority.verify();
      const coverage = await deriveReclaimCandidates(markRun, inventoryRun,
        join(directory, ".private", GC_CANDIDATES_NAME), files);
      if (!coverage.ok) return err(coverage.error.code as PersistenceErrorCode, coverage.error.message, coverage.error.details);
      await markSorter.sweep();
      await inventorySorter.sweep();

      // G5: revalidate every candidate immediately before it can be unlinked,
      // streaming from the SAME sealed handle that proved the candidates file's
      // exact content, and seal the validated stream with its own binding.
      await at("G5-validate", "maintenance");
      let validatedRun: SealedRun | undefined;
      if (coverage.value.candidatesRun) {
        const candidatesReader = await SealedRunReader.open(coverage.value.candidatesRun, files,
          "G5-validate", "maintenance");
        if (!candidatesReader.ok) return err(candidatesReader.error.code as PersistenceErrorCode, candidatesReader.error.message, candidatesReader.error.details);
        const candidates = candidatesReader.value;
        const writer = new RunWriter(join(directory, ".private", GC_VALIDATED_NAME), files, "G5-validate");
        let writerOpen = false;
        try {
          const opened = await writer.open();
          if (!opened.ok) return err(opened.error.code as PersistenceErrorCode, opened.error.message, opened.error.details);
          writerOpen = true;
          for (;;) {
            const item = await candidates.next();
            if (!item.ok) return err(item.error.code as PersistenceErrorCode, item.error.message, item.error.details);
            const digest = item.value;
            if (digest === undefined) break;
            const path = join(objectsDir, digest + ".bin");
            try {
              if (await io.kind(path) !== "file") { unknownArtifacts++; continue; }
            } catch { unknownArtifacts++; continue; }
            const appended = await writer.append(digest);
            if (!appended.ok) return err(appended.error.code as PersistenceErrorCode, appended.error.message, appended.error.details);
          }
          const consumed = candidates.verifyConsumed();
          if (!consumed.ok) return err(consumed.error.code as PersistenceErrorCode, consumed.error.message, consumed.error.details);
          const sealed = await writer.close();
          if (!sealed.ok) return err(sealed.error.code as PersistenceErrorCode, sealed.error.message, sealed.error.details);
          writerOpen = false;
          validatedRun = sealed.value;
        } finally {
          await candidates.close().catch(() => undefined);
          if (writerOpen) await writer.dispose();
        }
        if (validatedRun.records === 0) {
          try { await io.removeOwnedFile(validatedRun.path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
              return gcError(ioFailureCode(error), "GC candidate cleanup failed.", phase, "maintenance");
            }
          }
          validatedRun = undefined;
        }
      }

      // G6: reclaim only records consumed from the SAME sealed, verified
      // handle, in bounded batches with an objects/ barrier per batch. The
      // exact-content hash of the consumed stream is asserted at end; the
      // handle stamp is re-checked before every unlink.
      await at("G6-reclaim", "maintenance");
      await authority.verify();
      if (validatedRun) {
        const openedValidated = await SealedRunReader.open(validatedRun, files, "G6-reclaim", "maintenance");
        if (!openedValidated.ok) return err(openedValidated.error.code as PersistenceErrorCode, openedValidated.error.message, openedValidated.error.details);
        const reader = openedValidated.value;
        let batch = 0;
        let remaining = validatedRun.records;
        try {
          for (;;) {
            const item = await reader.next();
            if (!item.ok) {
              return gcError(item.error.code as PersistenceErrorCode, item.error.message, phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining, scannedObjects, markedReferences, unknownArtifacts });
            }
            const digest = item.value;
            if (digest === undefined) break;
            remaining--;
            const stable = await reader.checkStamp();
            if (!stable.ok) {
              return gcError(stable.error.code as PersistenceErrorCode, stable.error.message, phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining + 1, scannedObjects, markedReferences, unknownArtifacts });
            }
            try {
              await io.removeOwnedFile(join(objectsDir, digest + ".bin"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                // Safely idempotent under held authority: the object is absent.
                reclaimedObjects++;
                continue;
              }
              return gcError(ioFailureCode(error), "Payload-object reclamation failed.", phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining + 1, scannedObjects, markedReferences, unknownArtifacts });
            }
            reclaimedObjects++;
            batch++;
            if (batch >= limits.value.unlinkBatch) {
              try { await io.syncDirectory(objectsDir); }
              catch (error) {
                return gcError(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
                  "Payload-object reclamation barrier failed.", phase, "maintenance",
                  { reclaimedObjects, remainingCandidates: remaining, scannedObjects, markedReferences, unknownArtifacts });
              }
              batch = 0;
            }
          }
          const consumed = reader.verifyConsumed();
          if (!consumed.ok) {
            return gcError(consumed.error.code as PersistenceErrorCode, consumed.error.message, phase, "maintenance",
              { reclaimedObjects, remainingCandidates: 0, scannedObjects, markedReferences, unknownArtifacts });
          }
          if (batch > 0) {
            try { await io.syncDirectory(objectsDir); }
            catch (error) {
              return gcError(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
                "Payload-object reclamation barrier failed.", phase, "maintenance",
                { reclaimedObjects, remainingCandidates: 0, scannedObjects, markedReferences, unknownArtifacts });
            }
          }
        } finally {
          await reader.close().catch(() => undefined);
        }
      }

      // G7: final deterministic scratch sweep and barrier.
      await at("G7-final-cleanup", "maintenance");
      const finalSwept = await sweepGcScratch(directory, io, limits.value, phase);
      if (!finalSwept.ok) return err(finalSwept.error.code as PersistenceErrorCode, finalSwept.error.message, finalSwept.error.details);
      return ok({ scannedObjects, markedReferences, reclaimedObjects, unknownArtifacts });
    } catch (error) {
      // Any thrown failure inside a phase is classified with its exact phase
      // and disposition (preserving a thrown error's own classification) so
      // the runtime can distinguish maintenance failures (stay ready) from
      // authoritative uncertainty (recovery). Sorter scratch is swept on the
      // failure path; debris is inert and deterministically swept next attempt.
      await markSorter.sweep();
      await inventorySorter.sweep();
      if (error instanceof DirectoryIoError) {
        const details = isRecord(error.details) ? error.details : {};
        const ownPhase = typeof details.gcPhase === "string" ? details.gcPhase as GcPhase : undefined;
        const ownDisposition = typeof details.gcDisposition === "string"
          ? details.gcDisposition as GcDisposition : undefined;
        return err(error.code, error.message,
          { gcPhase: ownPhase ?? phase, gcDisposition: ownDisposition ?? disposition });
      }
      return err(ioFailureCode(error), "Payload-object garbage collection failed.",
        { gcPhase: phase, gcDisposition: disposition });
    }
  });
}
