import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { err, type Result } from "../utils/result.js";
import type { PersistenceErrorCode, WalOperation } from "../types/persistence.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, sameWalStamp, type WalFileHandle, type WalFileStamp, type WalIO } from "./walIO.js";
import { OBJECT_REFERENCE, validateReference } from "./payloadObjects.js";
import { ETHER_DATA_PROFILE } from "./etherData.js";

/**
 * Tranche 8: payload-object orphan garbage collection - non-destructive
 * scratch/planning primitives.
 *
 * SECURITY ARCHITECTURE: this module deliberately exports NO destructive
 * collector. The G0-G7 orchestration that unlinks payload objects lives as a
 * module-PRIVATE closure inside src/core/DurableEtherMemories.ts, structurally
 * owned by the runtime facade: no shipped export anywhere accepts a
 * caller-supplied tip, acquires authority independently and unlinks payloads.
 * Everything exported here is a planning/scratch helper that never deletes a
 * payload object (the sorter and sweeps manage only GC-owned scratch under
 * .private/).
 *
 * Scratch integrity has TWO layers, and each proves a different property:
 *
 * 1. WHOLE-RUN SEAL (SealedRun): a constant-size in-memory binding - record
 *    count, exact canonical byte length and a SHA-256 computed from the
 *    INTENDED output while it is generated - read back and verified after
 *    write+fsync, and re-verified whenever a run is opened for consumption.
 *    The seal proves completeness: exact count, no truncation, extension,
 *    omission, duplication or reordering of the file as a whole.
 *
 * 2. PER-RECORD AUTHENTICATION: every scratch record is
 *    `digest(64 hex) || tag(64 hex) || LF`, where tag = HMAC-SHA256 over a
 *    domain-separated canonical encoding of runType || index || digest, under
 *    an EPHEMERAL high-entropy key held only in memory for one GC invocation.
 *    The tag is computed from the TRUSTED in-memory digest the producing
 *    computation just derived (never from bytes re-read from scratch), and it
 *    is verified BEFORE the record's digest is returned to any consumer -
 *    in particular before any unlink decision. A whole-run seal that becomes
 *    authoritative only at end-of-stream can never authorize an early
 *    destructive action; per-record authentication supplies exactly the
 *    missing property: the exact record authorizing this unlink was produced
 *    by this invocation's trusted computation.
 *
 *    - The key never touches disk: crash/restart discards it, so all stale
 *      authenticated scratch is automatically distrusted (and deterministically
 *      swept at G1).
 *    - The per-record index is authenticated and checked against the record's
 *      exact position, so records cannot be reordered, skipped or replayed
 *      from another position; runType domain separation prevents cross-stream
 *      replay; a different key prevents cross-invocation replay.
 *    - Memory stays bounded: constant-size key and HMAC state, no per-record
 *      tables.
 *
 * Threat-model boundary (frozen at T1/T2, unchanged by T8): concurrent
 * external/malicious replacement of store namespace entries while authority is
 * held is OUTSIDE the persistence contract. Static symlink entries are never
 * followed and never deleted: readNames yields names only, entry validation
 * uses lstat via kind(), and unlink removes a final-component link entry
 * itself rather than following it.
 *
 * Failure dispositions: helpers report failures through the GC error model
 * (details.gcPhase + details.gcDisposition). "maintenance" covers every
 * scratch create/write/sync/verify/read failure; "authoritative" is assigned
 * only by the orchestrator for persisted-authority conditions.
 */

export const GC_SCRATCH_NAMESPACE_SIZE = 128;
export const GC_SORT_CHUNK_ENTRIES = 512;
export const GC_UNLINK_BATCH = 64;
export const OBJECT_NAME_PATTERN = /^[0-9a-f]{64}\.bin$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** digest(64 hex) || tag(64 hex) || LF */
const RECORD_BYTES = 129;
const TAG_BYTES = 64;
const GC_RECORD_DOMAIN = "ether.gc.record.v1";

export type GcStream = "mark" | "inventory";
export type GcRunType = "mark" | "inventory" | "candidates" | "validated";
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

/**
 * One GC invocation's ephemeral authentication context. The 32-byte key is
 * generated from the platform CSPRNG, held only in memory, never written to
 * scratch, and discarded with the invocation.
 */
export interface GcSession { readonly key: Uint8Array }
export const createGcSession = (): GcSession => ({ key: randomBytes(32) });

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

export const ioFailureCode = (error: unknown): PersistenceErrorCode => {
  if (error instanceof DirectoryIoError) return error.code;
  const native = (error as NodeJS.ErrnoException | null)?.code;
  if (native === "EACCES" || native === "EPERM" || native === "EROFS") return "READ_ONLY_LOCKED";
  return "RECOVERY_REQUIRED";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** GC-internal error constructor: every error carries its phase AND disposition. */
export const gcFailure = (code: PersistenceErrorCode, message: string, phase: GcPhase, disposition: GcDisposition,
  extra?: Record<string, unknown>): Result<never> =>
  err(code, message, { gcPhase: phase, gcDisposition: disposition, ...extra });

/** Domain-separated canonical bytes authenticated for one record. */
const tagInput = (runType: GcRunType, index: number, digest: string): Buffer =>
  Buffer.concat([Buffer.from(`${GC_RECORD_DOMAIN}\0${runType}\0${index}\0`, "utf8"), Buffer.from(digest, "utf8")]);
/**
 * Imported WebCrypto HMAC keys per session/runType: one standard key schedule
 * per (session, runType), fast per-record signs (HMAC-SHA-256 via
 * crypto.subtle - a standard cryptographic HMAC, never concatenated hashes).
 */
const hmacKeys = new WeakMap<GcSession, Map<GcRunType, Promise<CryptoKey>>>();
const tagKey = (session: GcSession, runType: GcRunType): Promise<CryptoKey> => {
  let byRun = hmacKeys.get(session);
  if (!byRun) { byRun = new Map(); hmacKeys.set(session, byRun); }
  let key = byRun.get(runType);
  if (!key) {
    key = crypto.subtle.importKey("raw", session.key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    byRun.set(runType, key);
  }
  return key;
};
const computeTag = async (session: GcSession, runType: GcRunType, index: number, digest: string): Promise<string> => {
  const key = await tagKey(session, runType);
  const signature = await crypto.subtle.sign("HMAC", key, tagInput(runType, index, digest) as unknown as ArrayBuffer);
  return Buffer.from(signature).toString("hex");
};
const sameTag = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * Constant-size in-memory content binding for one owned scratch run: the run
 * type, record count, exact canonical byte length and the SHA-256 of the exact
 * authenticated bytes the generating computation intended. Computed while
 * generating; verified by read-back after fsync; re-verified on every open.
 */
export interface SealedRun {
  readonly path: string;
  readonly runType: GcRunType;
  readonly records: number;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Streams one authenticated scratch run to disk. The per-record tag is
 * computed from the TRUSTED in-memory digest handed to append() - never from
 * bytes re-read from scratch - and the whole-run hash is computed over the
 * exact bytes intended. close() fsyncs, then fully reads the artifact back and
 * proves the physical bytes still equal the intended content before the run
 * may be consumed.
 */
export class RunWriter {
  private handle?: WalFileHandle;
  private position = 0;
  private records = 0;
  private readonly hash = createHash("sha256");

  constructor(private readonly path: string, private readonly files: WalIO,
    private readonly session: GcSession, private readonly runType: GcRunType, private readonly phase: GcPhase) {}

  async open(): Promise<Result<undefined>> {
    try {
      this.handle = await this.files.open(this.path, true);
      return ok(undefined);
    } catch (error) {
      return gcFailure(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC scratch run creation failed.", this.phase, "maintenance");
    }
  }

  async append(digest: string): Promise<Result<undefined>> {
    const handle = this.handle;
    if (!handle) return gcFailure("RECOVERY_REQUIRED", "GC scratch run is not open.", this.phase, "maintenance");
    if (!isHex(digest)) {
      return gcFailure("PERSISTENCE_CORRUPTION", "GC scratch records require an exact 64-hex digest.",
        this.phase, "maintenance");
    }
    try {
      const tag = await computeTag(this.session, this.runType, this.records, digest);
      const record = Buffer.from(digest + tag + "\n", "utf8");
      await handle.write(record, this.position);
      this.position += record.byteLength;
      this.records++;
      this.hash.update(record);
      return ok(undefined);
    } catch (error) {
      return gcFailure(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
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
    if (!handle) return gcFailure("RECOVERY_REQUIRED", "GC scratch run is not open.", this.phase, "maintenance");
    const descriptor: SealedRun = { path: this.path, runType: this.runType, records: this.records,
      byteLength: this.position, sha256: this.hash.digest("hex") };
    try {
      await handle.sync();
      await handle.close();
    } catch (error) {
      this.handle = undefined;
      await handle.close().catch(() => undefined);
      return gcFailure(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
        "GC scratch run sync failed.", this.phase, "maintenance");
    }
    this.handle = undefined;
    const verified = await verifySealedRun(descriptor, this.files, this.phase, "maintenance");
    return verified.ok ? ok(descriptor) : verified;
  }
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** One strict seal pass over a run's bytes: canonical records, ascending digests, hashed. */
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
      if (count <= 0) return gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run ended early.", phase, disposition);
      read += count;
    }
    position += want;
    hash.update(chunk.subarray(0, want));
    for (let offset = 0; offset < want; offset += RECORD_BYTES) {
      const record = chunk.subarray(offset, offset + RECORD_BYTES);
      const digest = Buffer.from(record.subarray(0, 64)).toString("utf8");
      const tag = Buffer.from(record.subarray(64, 128)).toString("utf8");
      if (record[128] !== 10 || !isHex(digest) || !isHex(tag)) {
        return gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run is not canonically encoded.", phase, disposition);
      }
      if (last !== undefined && compareDigests(digest, last) <= 0) {
        return gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run is not strictly increasing.", phase, disposition);
      }
      last = digest;
      seen++;
    }
  }
  return ok({ sha256: hash.digest("hex"), records: seen });
}

/**
 * Full read-back verification of one sealed run against its binding.
 * Exactly one eventual close: the handle is closed on success and on every
 * failure path (size, read, canonical, ordering, count, hash).
 */
async function verifySealedRun(descriptor: SealedRun, files: WalIO, phase: GcPhase,
  disposition: GcDisposition): Promise<Result<undefined>> {
  let handle: WalFileHandle;
  try {
    handle = await files.open(descriptor.path, false);
  } catch (error) {
    return gcFailure(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
      "GC scratch run read-back failed.", phase, disposition);
  }
  let failure: Result<never> | undefined;
  try {
    const size = (await handle.stat()).size;
    if (size !== descriptor.byteLength) {
      failure = gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run byte length differs from its binding.",
        phase, disposition);
    } else {
      const scanned = await scanRunBytes(handle, size, phase, disposition);
      if (!scanned.ok) failure = scanned;
      else if (scanned.value.records !== descriptor.records) {
        failure = gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run record count differs from its binding.",
          phase, disposition);
      } else if (scanned.value.sha256 !== descriptor.sha256) {
        failure = gcFailure("PERSISTENCE_CORRUPTION", "GC scratch run content differs from its exact-content binding.",
          phase, disposition);
      }
    }
  } catch (error) {
    failure = gcFailure(ioFailureCode(error), "GC scratch run read-back failed.", phase, disposition);
  } finally {
    await handle.close();
  }
  return failure ?? ok(undefined);
}

/**
 * Verified reader over one sealed, authenticated run. open() captures ONE
 * handle plus its file stamp, fully verifies the whole-run seal on that handle
 * (completeness: length, canonical encoding, ordering, count, content hash),
 * and records are then streamed from the SAME handle. Every next() verifies,
 * BEFORE the digest is returned:
 *   - canonical record structure;
 *   - the authenticated index equals the record's exact position;
 *   - the HMAC tag over (domain || runType || index || digest) under the
 *     invocation's in-memory key (constant-time compare).
 * A substituted digest, substituted tag, reordered, replayed, skipped or
 * cross-invocation record therefore fails before it can influence any
 * consumer - in particular before any unlink decision. The full content hash
 * of the consumed stream is asserted at end-of-stream for completeness; it is
 * never the authority for an earlier destructive action.
 */
export class SealedRunReader {
  private constructor(private readonly handle: WalFileHandle, private readonly descriptor: SealedRun,
    private readonly session: GcSession, private readonly stamp: WalFileStamp,
    private readonly phase: GcPhase, private readonly disposition: GcDisposition,
    private readonly hash = createHash("sha256"), private consumed = 0) {}

  static async open(descriptor: SealedRun, files: WalIO, session: GcSession, phase: GcPhase,
    disposition: GcDisposition): Promise<Result<SealedRunReader>> {
    let handle: WalFileHandle;
    try {
      handle = await files.open(descriptor.path, false);
    } catch (error) {
      return gcFailure(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC sealed run open failed.", phase, disposition);
    }
    // Strict ownership: a successfully acquired handle gets exactly one
    // eventual close even when the initial stat fails.
    let stamp: WalFileStamp;
    try {
      stamp = await handle.stat();
    } catch (error) {
      await handle.close().catch(() => undefined);
      return gcFailure(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        "GC sealed run open failed.", phase, disposition);
    }
    let failure: Result<never> | undefined;
    try {
      if (stamp.size !== descriptor.byteLength) {
        failure = gcFailure("PERSISTENCE_CORRUPTION", "GC sealed run byte length differs from its binding.",
          phase, disposition);
      } else {
        const scanned = await scanRunBytes(handle, stamp.size, phase, disposition);
        if (!scanned.ok) failure = scanned;
        else if (scanned.value.records !== descriptor.records || scanned.value.sha256 !== descriptor.sha256) {
          failure = gcFailure("PERSISTENCE_CORRUPTION",
            "GC sealed run content differs from its exact-content binding.", phase, disposition);
        }
      }
    } catch (error) {
      failure = gcFailure(ioFailureCode(error), "GC sealed run verification failed.", phase, disposition);
    } finally {
      if (failure) await handle.close().catch(() => undefined);
    }
    return failure ?? ok(new SealedRunReader(handle, descriptor, session, stamp, phase, disposition));
  }

  /**
   * Stream the next authenticated record from the same verified handle. The
   * digest is returned only after its HMAC authenticates this exact record at
   * this exact position under this invocation's key.
   */
  async next(): Promise<Result<string | undefined>> {
    if (this.consumed >= this.descriptor.records) return ok(undefined);
    const record = new Uint8Array(RECORD_BYTES);
    let read = 0;
    while (read < RECORD_BYTES) {
      const count = await this.handle.read(record.subarray(read), this.consumed * RECORD_BYTES + read);
      if (count <= 0) {
        return gcFailure("PERSISTENCE_CORRUPTION", "GC sealed run ended early during consumption.",
          this.phase, this.disposition);
      }
      read += count;
    }
    const digest = Buffer.from(record.subarray(0, 64)).toString("utf8");
    const tag = Buffer.from(record.subarray(64, 128)).toString("utf8");
    if (record[128] !== 10 || !isHex(digest) || !isHex(tag)) {
      return gcFailure("PERSISTENCE_CORRUPTION", "GC sealed run is not canonically encoded during consumption.",
        this.phase, this.disposition);
    }
    // The authenticated index binds this record to this exact position:
    // reordered, skipped or replayed records fail here.
    if (!sameTag(tag, await computeTag(this.session, this.descriptor.runType, this.consumed, digest))) {
      return gcFailure("PERSISTENCE_CORRUPTION",
        "GC record authentication failed before use; scratch content was substituted after generation.",
        this.phase, this.disposition);
    }
    this.hash.update(record);
    this.consumed++;
    return ok(digest);
  }

  /** Final whole-stream completeness assertion over the consumed bytes. */
  verifyConsumed(): Result<undefined> {
    return this.consumed === this.descriptor.records && this.hash.digest("hex") === this.descriptor.sha256
      ? ok(undefined)
      : gcFailure("PERSISTENCE_CORRUPTION", "GC sealed run consumption differs from its exact-content binding.",
        this.phase, this.disposition);
  }

  /** Stamp stability of the same opened handle, before destructive use. */
  async checkStamp(): Promise<Result<undefined>> {
    try {
      const current = await this.handle.stat();
      if (!sameWalStamp(this.stamp, current)) {
        return gcFailure("RECOVERY_REQUIRED", "GC sealed run changed during consumption.", this.phase, this.disposition);
      }
      return ok(undefined);
    } catch {
      return gcFailure("RECOVERY_REQUIRED", "GC sealed run stamp check failed.", this.phase, this.disposition);
    }
  }

  async close(): Promise<void> { await this.handle.close(); }
}

/**
 * Two-bank bounded external digest sorter with exact-content bindings and
 * per-record authentication on every generated run. Ingestion buffers
 * `chunkEntries` digests in RAM and flushes them as one sorted, sealed,
 * authenticated run into the ACTIVE bank (within-chunk duplicates collapse so
 * every run is strictly increasing); when the active bank holds
 * `namespaceSlots` runs, ALL of them are opened as sealed readers (each
 * re-verified on open, each record re-authenticated at read), stream-merged
 * into ONE sealed output run in the (necessarily empty) opposite bank, the
 * consumed input runs are unlinked, and the banks swap roles. Capacity grows
 * level by level, so the bounded namespace imposes NO total object/history
 * ceiling.
 */
export class GcDigestSorter {
  private bank: "a" | "b" = "a";
  private runs: Record<"a" | "b", SealedRun[]> = { a: [], b: [] };
  private buffer: string[] = [];

  constructor(private readonly directory: string, private readonly stream: GcStream,
    private readonly io: DirectoryIO, private readonly files: WalIO, private readonly limits: GcLimits,
    private readonly session: GcSession) {}

  private runPath(bank: "a" | "b", index: number): string {
    return join(this.directory, ".private", scratchRun(this.stream, bank, index));
  }

  private scratchPhase(): GcPhase {
    return this.stream === "mark" ? "G2-mark-scratch" : "G3-inventory";
  }

  async add(digest: string): Promise<Result<undefined>> {
    if (typeof digest !== "string" || !isHex(digest)) {
      return gcFailure("PERSISTENCE_CORRUPTION", "GC sorter requires an exact 64-hex digest.",
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
    const writer = new RunWriter(this.runPath(this.bank, index), this.files, this.session, this.stream,
      this.scratchPhase());
    const opened = await writer.open();
    if (!opened.ok) return opened;
    // Strict ownership: after a successful writer open, every exit path gets
    // exactly one eventual dispose. dispose() is a safe no-op once close() has
    // run (success or its own failure paths clear the handle first), so the
    // finally never double-closes and never masks the original error.
    try {
      for (const digest of sorted) {
        const appended = await writer.append(digest);
        if (!appended.ok) return appended;
      }
      const sealed = await writer.close();
      if (!sealed.ok) return sealed;
      this.runs[this.bank].push(sealed.value);
      return ok(undefined);
    } catch (error) {
      return gcFailure(ioFailureCode(error), "GC chunk run write failed.", this.scratchPhase(), "maintenance");
    } finally {
      await writer.dispose();
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
      return gcFailure("RECOVERY_REQUIRED", "GC cascade output bank is not empty.", this.scratchPhase(), "maintenance");
    }
    const inputs = this.runs[from];
    const readers: SealedRunReader[] = [];
    const writer = new RunWriter(this.runPath(to, 0), this.files, this.session, this.stream, this.scratchPhase());
    let writerOpen = false;
    try {
      for (const input of inputs) {
        const reader = await SealedRunReader.open(input, this.files, this.session, this.scratchPhase(), "maintenance");
        if (!reader.ok) return reader;
        readers.push(reader.value);
      }
      const opened = await writer.open();
      if (!opened.ok) return opened;
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
        if (!appended.ok) return appended;
        last = best;
      }
      for (const reader of readers) {
        const consumed = reader.verifyConsumed();
        if (!consumed.ok) return consumed;
      }
      const sealed = await writer.close();
      if (!sealed.ok) return sealed;
      writerOpen = false;
      // Output is complete and content-bound; only now may inputs go away.
      for (const input of inputs) {
        try { await this.io.removeOwnedFile(input.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          return gcFailure(ioFailureCode(error), "GC cascade input reclamation failed.",
            this.scratchPhase(), "maintenance");
        }
      }
      try { await this.io.syncDirectory(join(this.directory, ".private")); }
      catch (error) {
        return gcFailure(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
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
      return gcFailure(ioFailureCode(error), "GC scratch cleanup failed.", phase, "maintenance");
    }
  }
  try { await io.syncDirectory(join(directory, ".private")); }
  catch (error) {
    return gcFailure(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
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
 * G4 planning: the exact sorted reachability merge over sealed, authenticated
 * runs. Proves BOTH directions before the orchestrator can act:
 *   inventory - marks  -> sealed reclaim candidates (exact-content bound);
 *   marks    - inventory -> authoritative corruption (a required authoritative
 *   object is physically missing), for active-WAL and receipt marks alike.
 * Any scratch read/integrity/authentication failure is maintenance. This
 * function performs no payload deletion.
 */
export async function deriveReclaimCandidates(markRun: SealedRun | undefined, inventoryRun: SealedRun | undefined,
  candidatesPath: string, files: WalIO, session: GcSession): Promise<Result<GcCoverage>> {
  let markReader: SealedRunReader | undefined;
  let inventoryReader: SealedRunReader | undefined;
  const writer = new RunWriter(candidatesPath, files, session, "candidates", "G4-coverage");
  let writerOpen = false;
  try {
    if (markRun) {
      const opened = await SealedRunReader.open(markRun, files, session, "G4-coverage", "maintenance");
      if (!opened.ok) return opened;
      markReader = opened.value;
    }
    if (inventoryRun) {
      const opened = await SealedRunReader.open(inventoryRun, files, session, "G4-coverage", "maintenance");
      if (!opened.ok) return opened;
      inventoryReader = opened.value;
    }
    const pull = async (reader: SealedRunReader | undefined): Promise<Result<string | undefined>> =>
      reader ? reader.next() : ok(undefined);
    let mark = await pull(markReader);
    if (!mark.ok) return mark;
    let inventory = await pull(inventoryReader);
    if (!inventory.ok) return inventory;
    let candidates = 0;
    let reachable = 0;
    let lastCandidate: string | undefined;
    const emitCandidate = async (digest: string): Promise<Result<undefined>> => {
      if (lastCandidate === undefined || compareDigests(digest, lastCandidate) > 0) {
        if (!writerOpen) {
          const opened = await writer.open();
          if (!opened.ok) return opened;
          writerOpen = true;
        }
        const appended = await writer.append(digest);
        if (!appended.ok) return appended;
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
          return gcFailure("PERSISTENCE_CORRUPTION",
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
        return gcFailure("PERSISTENCE_CORRUPTION",
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
      if (!consumed.ok) return consumed;
    }
    if (inventoryReader) {
      const consumed = inventoryReader.verifyConsumed();
      if (!consumed.ok) return consumed;
    }
    if (!writerOpen) return ok({ candidatesRun: undefined, candidates, reachable });
    const sealed = await writer.close();
    if (!sealed.ok) return sealed;
    writerOpen = false;
    return ok({ candidatesRun: candidates > 0 ? sealed.value : undefined, candidates, reachable });
  } catch (error) {
    return gcFailure(error instanceof DirectoryIoError ? error.code : ioFailureCode(error),
      "GC reachability merge failed.", "G4-coverage", "maintenance");
  } finally {
    await markReader?.close().catch(() => undefined);
    await inventoryReader?.close().catch(() => undefined);
    if (writerOpen) await writer.dispose();
  }
}
