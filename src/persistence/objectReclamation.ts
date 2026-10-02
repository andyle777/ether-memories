import { join } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import type { PersistenceErrorCode, WalOperation } from "../types/persistence.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, type WalIO } from "./walIO.js";
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
 * GC never changes HEAD, checkpoints, WAL authority, receipt authority,
 * StateRoot or tip. There is no P6: every deleted file is already proven
 * unreachable, so interruption is safe and retry is idempotent. Maintenance
 * failures (scratch sweep, unlink, directory barrier) leave the runtime ready;
 * only failures that make AUTHORITATIVE data uncertain (corrupt history, a
 * marked object missing from the physical inventory) are classified for
 * recovery. Every error this module returns carries details.gcPhase so the
 * runtime can apply exactly that distinction.
 *
 * Bounded memory, unbounded history: both mark and inventory streams go
 * through a two-bank external cascade sort (`.private/gc-{stream}-{a|b}-{slot}.run`,
 * 128 slots per bank, 512 digests per chunk). When the active bank fills,
 * all its runs merge into ONE verified run in the (empty) opposite bank, the
 * consumed inputs are unlinked, and the banks swap roles. Merging into the
 * opposite bank guarantees the merge output never occupies a slot that a run
 * being consumed still holds; capacity grows level by level, so the bounded
 * namespace imposes NO total object/history ceiling. All GC scratch is
 * deterministic and swept at G1 and G7 of every attempt.
 */

export const GC_SCRATCH_NAMESPACE_SIZE = 128;
export const GC_SORT_CHUNK_ENTRIES = 512;
export const GC_UNLINK_BATCH = 64;
export const OBJECT_NAME_PATTERN = /^[0-9a-f]{64}\.bin$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_BYTES = 65;

export type GcStream = "mark" | "inventory";
export type GcPhase =
  | "G1-scratch-sweep" | "G2-mark" | "G3-inventory" | "G4-coverage"
  | "G5-validate" | "G6-reclaim" | "G7-final-cleanup";
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

/**
 * Streams the fixed 65-byte LF-terminated digest records of one GC scratch
 * run. Strict: any malformed record, torn tail or short read is corruption of
 * session-owned scratch and fails closed.
 */
export async function* readDigestFile(path: string, files: WalIO): AsyncGenerator<string> {
  const handle = await files.open(path, false);
  try {
    const size = (await handle.stat()).size;
    if (size % RECORD_BYTES !== 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Malformed GC scratch record file.");
    const chunk = new Uint8Array(RECORD_BYTES * 256);
    let position = 0;
    while (position < size) {
      const want = Math.min(chunk.byteLength, size - position);
      const buffer = chunk.subarray(0, want);
      let read = 0;
      while (read < want) {
        const count = await handle.read(buffer.subarray(read), position + read);
        if (count <= 0) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "GC scratch run ended early.");
        read += count;
      }
      position += want;
      for (let offset = 0; offset < want; offset += RECORD_BYTES) {
        const record = buffer.subarray(offset, offset + RECORD_BYTES);
        const digest = Buffer.from(record.subarray(0, 64)).toString("utf8");
        if (record[64] !== 10 || !isHex(digest)) {
          throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Malformed GC scratch record.");
        }
        yield digest;
      }
    }
  } finally { await handle.close(); }
}

/** Verifies one digest run: strictly increasing, exact expected count. */
export async function verifyDigestFile(path: string, files: WalIO, expectedEntries: number): Promise<Result<undefined>> {
  let seen = 0;
  let last: string | undefined;
  try {
    for await (const digest of readDigestFile(path, files)) {
      if (last !== undefined && compareDigests(digest, last) <= 0) {
        return err("PERSISTENCE_CORRUPTION", "GC scratch run is not strictly increasing.");
      }
      last = digest;
      seen++;
    }
  } catch (error) {
    if (error instanceof DirectoryIoError) return err(error.code, error.message);
    return err("RECOVERY_REQUIRED", "GC scratch run verification failed.");
  }
  return seen === expectedEntries ? ok(undefined)
    : err("PERSISTENCE_CORRUPTION", "GC scratch run entry count differs.");
}

/**
 * k-way merge of sorted digest runs into one deduplicated output run. The
 * output is written completely, fsynced and read-back verified BEFORE any
 * input run is unlinked; inputs are unlinked only after that verification,
 * and the caller releases ownership/accounting only after successful unlinks.
 */
export async function mergeDigestRuns(inputPaths: readonly string[], outputPath: string, files: WalIO):
Promise<Result<{ entries: number; bytes: number }>> {
  const iterators = inputPaths.map(path => readDigestFile(path, files)[Symbol.asyncIterator]());
  const current: (string | undefined)[] = [];
  let output;
  try {
    for (const iterator of iterators) {
      const first = await iterator.next();
      current.push(first.done ? undefined : first.value);
    }
    output = await files.open(outputPath, true);
    let entries = 0;
    let bytes = 0;
    let position = 0;
    let last: string | undefined;
    for (;;) {
      let best: string | undefined;
      let bestIndex = -1;
      for (let index = 0; index < current.length; index++) {
        const value = current[index]!;
        if (value !== undefined && (best === undefined || compareDigests(value, best) < 0)) { best = value; bestIndex = index; }
      }
      if (best === undefined) break;
      const advanced = await iterators[bestIndex]!.next();
      current[bestIndex] = advanced.done ? undefined : advanced.value;
      // Set semantics: duplicate marks collapse; duplicate inventory names are impossible.
      if (last !== undefined && compareDigests(best, last) === 0) continue;
      await output.write(Buffer.from(best + "\n", "utf8"), position);
      position += RECORD_BYTES;
      entries++;
      bytes += RECORD_BYTES;
      last = best;
    }
    await output.sync();
    await output.close();
    output = undefined;
    const verified = await verifyDigestFile(outputPath, files, entries);
    if (!verified.ok) return verified;
    return ok({ entries, bytes });
  } catch (error) {
    if (error instanceof DirectoryIoError) return err(error.code, error.message);
    return err("RECOVERY_REQUIRED", "GC run merge failed.");
  } finally {
    if (output) await output.close().catch(() => undefined);
    for (const iterator of iterators) await iterator.return?.(undefined as never).catch(() => undefined);
  }
}

/**
 * Two-bank bounded external digest sorter. Ingestion buffers `chunkEntries`
 * digests in RAM and flushes them as one sorted run into the ACTIVE bank;
 * when the active bank holds `namespaceSlots` runs, ALL of them merge into a
 * single verified run in the (necessarily empty) opposite bank, the consumed
 * input runs are unlinked and the banks swap roles. Merge output and source
 * runs therefore never share a slot, RAM stays bounded by one chunk plus at
 * most `namespaceSlots` merge cursors, and capacity is unbounded.
 */
export class GcDigestSorter {
  private bank: "a" | "b" = "a";
  private counts: Record<"a" | "b", number> = { a: 0, b: 0 };
  private bankEntries: Record<"a" | "b", number> = { a: 0, b: 0 };
  private buffer: string[] = [];

  constructor(private readonly directory: string, private readonly stream: GcStream,
    private readonly io: DirectoryIO, private readonly files: WalIO, private readonly limits: GcLimits) {}

  private runPath(bank: "a" | "b", index: number): string {
    return join(this.directory, ".private", scratchRun(this.stream, bank, index));
  }

  async add(digest: string): Promise<Result<undefined>> {
    if (typeof digest !== "string" || !isHex(digest)) {
      return err("PERSISTENCE_CORRUPTION", "GC sorter requires an exact 64-hex digest.");
    }
    this.buffer.push(digest);
    if (this.buffer.length >= this.limits.chunkEntries) return this.flushChunk();
    return ok(undefined);
  }

  private async flushChunk(): Promise<Result<undefined>> {
    if (this.buffer.length === 0) return ok(undefined);
    if (this.counts[this.bank] >= this.limits.namespaceSlots) {
      const cascaded = await this.cascade();
      if (!cascaded.ok) return cascaded;
    }
    const index = this.counts[this.bank];
    // Reserve before create: the slot index is claimed in memory first; the
    // physical exclusive create then proves no debris occupies the path.
    const sorted = [...this.buffer].sort(compareDigests);
    this.buffer = [];
    const path = this.runPath(this.bank, index);
    let handle;
    try {
      handle = await this.files.open(path, true);
      let position = 0;
      for (const digest of sorted) {
        await handle.write(Buffer.from(digest + "\n", "utf8"), position);
        position += RECORD_BYTES;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      return error instanceof DirectoryIoError
        ? err(error.code, error.message) : err("RECOVERY_REQUIRED", "GC chunk run write failed.");
    }
    this.counts[this.bank]++;
    this.bankEntries[this.bank] += sorted.length;
    return ok(undefined);
  }

  /**
   * Merge every run of the active bank into one deduplicated, verified run in
   * the opposite bank, unlink the consumed inputs, barrier .private and swap
   * bank roles. The opposite bank is always empty at this point: its previous
   * runs were consumed by the cascade that made it the active bank.
   */
  private async cascade(): Promise<Result<undefined>> {
    const from = this.bank;
    const to: "a" | "b" = from === "a" ? "b" : "a";
    if (this.counts[to] !== 0) return err("RECOVERY_REQUIRED", "GC cascade output bank is not empty.");
    const inputs: string[] = [];
    for (let index = 0; index < this.counts[from]; index++) inputs.push(this.runPath(from, index));
    const merged = await mergeDigestRuns(inputs, this.runPath(to, 0), this.files);
    if (!merged.ok) return merged;
    // Output is complete and verified; only now may consumed inputs go away.
    for (const input of inputs) {
      try { await this.io.removeOwnedFile(input); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        return err(ioFailureCode(error), "GC cascade input reclamation failed.");
      }
    }
    try { await this.io.syncDirectory(join(this.directory, ".private")); }
    catch (error) {
      return err(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE", "GC cascade scratch barrier failed.");
    }
    this.counts[from] = 0;
    this.counts[to] = 1;
    this.bankEntries[from] = 0;
    this.bankEntries[to] = merged.value.entries;
    this.bank = to;
    return ok(undefined);
  }

  /**
   * Flush, then collapse the active bank to exactly one deduplicated verified
   * run. Empty input yields no run at all.
   */
  async finish(): Promise<Result<{ path: string; entries: number } | undefined>> {
    const flushed = await this.flushChunk();
    if (!flushed.ok) return flushed;
    if (this.counts[this.bank] === 0) return ok(undefined);
    const cascaded = await this.cascade();
    if (!cascaded.ok) return cascaded;
    const path = this.runPath(this.bank, 0);
    const entries = this.bankEntries[this.bank];
    const verified = await verifyDigestFile(path, this.files, entries);
    return verified.ok ? ok({ path, entries }) : verified;
  }

  /** Best-effort sweep on failure paths; the authoritative sweep is sweepGcScratch. */
  async sweep(): Promise<void> {
    for (const bank of ["a", "b"] as const) {
      for (let index = 0; index < this.counts[bank]; index++) {
        try { await this.io.removeOwnedFile(this.runPath(bank, index)); } catch { /* absent: fine */ }
      }
      this.counts[bank] = 0;
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
      return err(ioFailureCode(error), "GC scratch cleanup failed.", { gcPhase: phase });
    }
  }
  try { await io.syncDirectory(join(directory, ".private")); }
  catch (error) {
    return err(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
      "GC scratch cleanup barrier failed.", { gcPhase: phase });
  }
  return ok(undefined);
}

/**
 * Extract the authoritative payload-object digest of one WAL/receipt
 * operation: an OBJECT_REFERENCE contributes its digest; an inline production
 * envelope contributes nothing; anything else is corruption.
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
  return reference.ok ? ok(reference.value.digest) : reference;
}

export interface GcCoverage {
  readonly candidatesPath?: string;
  readonly candidates: number;
  readonly reachable: number;
}

/**
 * G4: the exact sorted reachability merge. Proves BOTH directions before any
 * deletion can occur:
 *   inventory - marks  -> reclaim candidates (written, fsynced, verified);
 *   marks    - inventory -> PERSISTENCE_CORRUPTION (a required authoritative
 *   object is physically missing), for active-WAL and receipt marks alike.
 * Candidates are never deleted while coverage is still being proven: the
 * candidate file is complete and verified before G5/G6 begin.
 */
export async function deriveReclaimCandidates(markPath: string | undefined, inventoryPath: string | undefined,
  candidatesPath: string, files: WalIO): Promise<Result<GcCoverage>> {
  const markIterator = markPath ? readDigestFile(markPath, files)[Symbol.asyncIterator]() : undefined;
  const inventoryIterator = inventoryPath ? readDigestFile(inventoryPath, files)[Symbol.asyncIterator]() : undefined;
  const nextMark = async (): Promise<string | undefined> => {
    if (!markIterator) return undefined;
    const item = await markIterator.next();
    return item.done ? undefined : item.value;
  };
  const nextInventory = async (): Promise<string | undefined> => {
    if (!inventoryIterator) return undefined;
    const item = await inventoryIterator.next();
    return item.done ? undefined : item.value;
  };
  let mark = await nextMark();
  let inventory = await nextInventory();
  let candidates = 0;
  let reachable = 0;
  let output;
  let position = 0;
  let lastCandidate: string | undefined;
  try {
    for (;;) {
      if (mark !== undefined && inventory !== undefined) {
        const order = compareDigests(mark, inventory);
        if (order === 0) { reachable++; mark = await nextMark(); inventory = await nextInventory(); continue; }
        if (order < 0) {
          // The smallest remaining mark is below the current inventory item:
          // no physical object can match it - missing authoritative object.
          return err("PERSISTENCE_CORRUPTION", "A payload object required by authoritative history is missing from the physical inventory.",
            { missingDigest: mark });
        }
        // order > 0: this inventory object is unreachable and becomes a candidate.
        if (!output) output = await files.open(candidatesPath, true);
        if (lastCandidate === undefined || compareDigests(inventory, lastCandidate) > 0) {
          await output.write(Buffer.from(inventory + "\n", "utf8"), position);
          position += RECORD_BYTES;
          candidates++;
          lastCandidate = inventory;
        }
        inventory = await nextInventory();
        continue;
      }
      if (mark !== undefined) {
        // Inventory exhausted while authoritative marks remain: corruption.
        return err("PERSISTENCE_CORRUPTION", "Authoritative payload-object references exceed the physical inventory.",
          { missingDigest: mark });
      }
      if (inventory !== undefined) {
        if (!output) output = await files.open(candidatesPath, true);
        if (lastCandidate === undefined || compareDigests(inventory, lastCandidate) > 0) {
          await output.write(Buffer.from(inventory + "\n", "utf8"), position);
          position += RECORD_BYTES;
          candidates++;
          lastCandidate = inventory;
        }
        inventory = await nextInventory();
        continue;
      }
      break;
    }
    if (output) {
      await output.sync();
      await output.close();
      output = undefined;
      const verified = await verifyDigestFile(candidatesPath, files, candidates);
      if (!verified.ok) return verified;
    }
    return ok({ candidatesPath: candidates > 0 ? candidatesPath : undefined, candidates, reachable });
  } catch (error) {
    if (error instanceof DirectoryIoError) return err(error.code, error.message);
    return err("RECOVERY_REQUIRED", "GC reachability merge failed.");
  } finally {
    if (output) await output.close().catch(() => undefined);
    await markIterator?.return?.(undefined as never).catch(() => undefined);
    await inventoryIterator?.return?.(undefined as never).catch(() => undefined);
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
}

/**
 * G0-G7 payload-object orphan collection under one exclusive writer-authority
 * hold. G0 is the authority acquisition itself. No phase mutates authority:
 * G2/G3 only read authoritative sources and write scratch; G4 proves complete
 * bidirectional coverage; G5 revalidates each candidate; G6 unlinks only
 * proven-unreachable regular files in bounded batches with directory
 * barriers; G7 sweeps scratch. Interruption at any point leaves authority,
 * StateRoot and tip untouched and is safely retryable.
 */
export async function collectDurableGarbage(input: GcInput): Promise<Result<GcOutcome>> {
  const io = input.io ?? nodeDirectoryIO;
  const files = input.files ?? nodeWalIO;
  const instrumentation = input.instrumentation ?? { at: async () => undefined };
  const limits = gcLimits(input.limits);
  if (!limits.ok) return limits;
  const directory = input.directory;
  let unknownArtifacts = 0;
  let markedReferences = 0;
  let scannedObjects = 0;
  let reclaimedObjects = 0;
  let phase: GcPhase = "G1-scratch-sweep";
  const at = async (next: GcPhase) => { phase = next; await instrumentation.at(next); };
  const objectsDir = join(directory, "objects");

  return withRecoveryAuthority(directory, io, async (authority: RecoveryAuthority) => {
    const markSorter = new GcDigestSorter(directory, "mark", io, files, limits.value);
    const inventorySorter = new GcDigestSorter(directory, "inventory", io, files, limits.value);
    let markRun: { path: string; entries: number } | undefined;
    let inventoryRun: { path: string; entries: number } | undefined;
    try {
      // G1: deterministic scratch sweep; ENOENT is idempotent success.
      await instrumentation.at("G1-scratch-sweep");
      const swept = await sweepGcScratch(directory, io, limits.value, phase);
      if (!swept.ok) return swept;

      // G2: authoritative mark collection. The ledger is fully digest-verified
      // during traversal; the WAL is scanned by the frozen scanner. Only valid
      // OBJECT_REFERENCE digests are marked.
      await at("G2-mark");
      const head = authority.head;
      const ledger = await openAuthoritativeReceiptLedger(directory, head.storeId, head.epochId,
        head.checkpoint.checkpointId, files);
      if (!ledger.ok) return ledger;
      if (ledger.value) {
        const verified = await ledger.value.verify(async entry => {
          for (const operation of entry.operations) {
            const digest = required(extractObjectDigest(operation));
            if (digest !== undefined) required(await markSorter.add(digest));
          }
        });
        if (!verified.ok) return err(verified.error.code, verified.error.message, { gcPhase: phase });
      }
      const walPath = join(directory, "wal", `wal-${head.checkpoint.digest}.bin`);
      const walKind = await io.kind(walPath);
      if (walKind === "directory") return err("RECOVERY_REQUIRED", "Unsafe WAL path.", { gcPhase: phase });
      if (walKind === "file") {
        let handle;
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
                if (digest !== undefined) required(await markSorter.add(digest));
              }
            }
          } while (!cursor.ended);
        } finally {
          if (handle) await handle.close();
        }
      }
      await authority.verify();
      markRun = required(await markSorter.finish());
      markedReferences = markRun?.entries ?? 0;

      // G3: physical inventory enumeration. Only valid-name REGULAR files are
      // inventory items; malformed names, dotfiles, directories and symlinks
      // are never deleted, never followed and count as unknown artifacts.
      await at("G3-inventory");
      const objectsKind = await io.kind(objectsDir);
      if (objectsKind === "file") return err("RECOVERY_REQUIRED", "Unsafe payload-object directory.", { gcPhase: phase });
      if (objectsKind === "directory") {
        await io.readNames(objectsDir, async name => {
          if (!OBJECT_NAME_PATTERN.test(name)) { unknownArtifacts++; return; }
          try {
            if (await io.kind(join(objectsDir, name)) !== "file") { unknownArtifacts++; return; }
          } catch { unknownArtifacts++; return; }
          required(await inventorySorter.add(name.slice(0, 64)));
        });
      }
      inventoryRun = required(await inventorySorter.finish());
      scannedObjects = inventoryRun?.entries ?? 0;

      // G4: bidirectional coverage proof; no deletion may occur before it
      // succeeds completely.
      await at("G4-coverage");
      await authority.verify();
      const coverage = await deriveReclaimCandidates(markRun?.path, inventoryRun?.path,
        join(directory, ".private", GC_CANDIDATES_NAME), files);
      if (!coverage.ok) return err(coverage.error.code, coverage.error.message,
        { gcPhase: phase, ...coverage.error.details as Record<string, unknown> | undefined });
      await markSorter.sweep();
      await inventorySorter.sweep();

      // G5: revalidate every candidate immediately before it can be unlinked.
      // A replaced/unsafe entry is never deleted and is reported instead.
      await at("G5-validate");
      let validatedPath: string | undefined;
      let validatedCount = 0;
      if (coverage.value.candidatesPath) {
        validatedPath = join(directory, ".private", GC_VALIDATED_NAME);
        let output;
        try {
          output = await files.open(validatedPath, true);
          let position = 0;
          for await (const digest of readDigestFile(coverage.value.candidatesPath, files)) {
            const path = join(objectsDir, digest + ".bin");
            try {
              if (await io.kind(path) !== "file") { unknownArtifacts++; continue; }
            } catch { unknownArtifacts++; continue; }
            await output.write(Buffer.from(digest + "\n", "utf8"), position);
            position += RECORD_BYTES;
            validatedCount++;
          }
          await output.sync();
          await output.close();
          output = undefined;
        } catch (error) {
          if (output) await output.close().catch(() => undefined);
          return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
            "GC candidate validation failed.", { gcPhase: phase });
        }
        const verified = validatedCount > 0 ? await verifyDigestFile(validatedPath, files, validatedCount) : ok(undefined);
        if (!verified.ok) return err(verified.error.code, verified.error.message, { gcPhase: phase });
        if (validatedCount === 0) {
          try { await io.removeOwnedFile(validatedPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
              return err(ioFailureCode(error), "GC candidate cleanup failed.", { gcPhase: phase });
            }
          }
          validatedPath = undefined;
        }
      }

      // G6: reclaim only proven-unreachable validated regular files, in
      // bounded batches with an objects/ barrier per batch. Failures report
      // exact partial reclaim accounting; the runtime remains ready.
      await at("G6-reclaim");
      await authority.verify();
      if (validatedPath) {
        const iterator = readDigestFile(validatedPath, files)[Symbol.asyncIterator]();
        let batch = 0;
        let remaining = validatedCount;
        let current: string | undefined;
        try {
          for (;;) {
            const item = await iterator.next();
            current = item.done ? undefined : item.value;
            if (current === undefined) break;
            remaining--;
            try {
              await io.removeOwnedFile(join(objectsDir, current + ".bin"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                // Safely idempotent under held authority: the object is absent.
                reclaimedObjects++;
                continue;
              }
              return err(ioFailureCode(error), "Payload-object reclamation failed.",
                { gcPhase: phase, reclaimedObjects, remainingCandidates: remaining + 1,
                  scannedObjects, markedReferences, unknownArtifacts });
            }
            reclaimedObjects++;
            batch++;
            if (batch >= limits.value.unlinkBatch) {
              try { await io.syncDirectory(objectsDir); }
              catch (error) {
                return err(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
                  "Payload-object reclamation barrier failed.",
                  { gcPhase: phase, reclaimedObjects, remainingCandidates: remaining,
                    scannedObjects, markedReferences, unknownArtifacts });
              }
              batch = 0;
            }
          }
          if (batch > 0) {
            try { await io.syncDirectory(objectsDir); }
            catch (error) {
              return err(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
                "Payload-object reclamation barrier failed.",
                { gcPhase: phase, reclaimedObjects, remainingCandidates: 0,
                  scannedObjects, markedReferences, unknownArtifacts });
            }
          }
        } finally {
          await iterator.return?.(undefined as never).catch(() => undefined);
        }
      }

      // G7: final deterministic scratch sweep and barrier.
      await at("G7-final-cleanup");
      const finalSwept = await sweepGcScratch(directory, io, limits.value, phase);
      if (!finalSwept.ok) return finalSwept;
      return ok({ scannedObjects, markedReferences, reclaimedObjects, unknownArtifacts });
    } catch (error) {
      // Any thrown failure inside a phase is classified with its exact phase
      // so the runtime can distinguish maintenance failures (stay ready) from
      // authoritative uncertainty (recovery). Sorter scratch is swept on the
      // failure path; debris is inert and deterministically swept next attempt.
      await markSorter.sweep();
      await inventorySorter.sweep();
      if (error instanceof DirectoryIoError) {
        return err(error.code, error.message, { gcPhase: phase });
      }
      return err(ioFailureCode(error), "Payload-object garbage collection failed.", { gcPhase: phase });
    }
  });
}
