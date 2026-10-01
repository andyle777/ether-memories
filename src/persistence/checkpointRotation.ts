import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import type { CommittedTip, MutationId } from "../types/persistence.js";
import type { WalOperation } from "../types/persistence.js";
import { encodeCheckpoint, encodeStoreHead, verifyCheckpoint, decodeStoreHead, PERSISTENCE_LIMITS, HEAD_FORMAT, HEAD_VERSION, DIGEST_ALGORITHM, type PersistedStoreHead } from "./codecs.js";
import { nodeDirectoryIO, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "./walIO.js";
import { withRecoveryAuthority, type RecoveryAuthority } from "./recoveryAuthority.js";
import { WalFileScan } from "./walFileScan.js";
import { productionRegistry } from "./productionOperations.js";
import {
  RECEIPTS_DIRECTORY, ReceiptLedgerReader, ROOT_PREDECESSOR_DIGEST, compareMutationIds, decodeReceiptEntryLine,
  encodeReceiptEntryLine, encodeReceiptHeaderLine, openAuthoritativeReceiptLedger, receiptLedgerPath,
  type ReceiptEntry
} from "./receiptLedger.js";
export { MAX_ACTIVE_WAL_BYTES, MIN_LEGAL_WAL_FRAME_BYTES } from "./receiptLedger.js";

/**
 * Tranche 7 checkpoint rotation + durable receipts + WAL reclamation.
 *
 * T7 invariant: no byte of retired WAL may be deleted until every
 * committed-state fact and mutation-reconciliation fact needed from it
 * exists durably in the new authoritative lineage. P6 (atomic HEAD
 * activation) is the sole irreversible rotation commit point: before P6
 * every new artifact is inert; after P6 every old artifact is inert and
 * reclaimable.
 *
 * Scratch follows the frozen T5 bounded-namespace convention: rotation scratch
 * lives under a fixed set of deterministic .private names that EVERY rotation
 * sweeps at start and end regardless of state, tolerating ENOENT. Unknown
 * receipt-ledger files from crashed rotations are unreferenced and therefore
 * INERT (the frozen orphan-object semantics); they are never treated as
 * authority and future object/ledger GC may collect them.
 */

export type RotationPhase =
  | "P0-authority" | "P1-capture" | "P2-scan" | "P3-sort" | "P3-merge"
  | "P4-checkpoint" | "P5-ledger-activate" | "P5-checkpoint-activate"
  | "P6-head-activate" | "P7-reclaim";

/** Trusted test instrumentation; throwing simulates a crash at that boundary. */
export interface RotationInstrumentation { at(phase: RotationPhase): Promise<void> }

export interface RotationOutcome {
  readonly activated: true;
  readonly newCheckpointId: string;
  readonly newCheckpointDigest: string;
  readonly ledgerDigest: string;
  readonly retiredWalBytes: number;
  readonly receiptCount: number;
}

export interface RotationInput {
  readonly directory: string;
  /** The exact immutable published generation: canonical bytes + committed tip. */
  readonly generation: { readonly bytes: Uint8Array; readonly tip: CommittedTip };
  readonly io?: DirectoryIO;
  readonly files?: WalIO;
  readonly instrumentation?: RotationInstrumentation;
}

/** Deterministic scratch namespace (T5 convention: bounded, swept every time). */
export const SCRATCH_NAMESPACE_SIZE = 128;
const scratchCandidate = (index: number) => `rotation-candidate-${String(index).padStart(6, "0")}.bin`;
const scratchCheckpoint = (index: number) => `rotation-checkpoint-${String(index).padStart(6, "0")}.bin`;
const scratchHead = (index: number) => `rotation-head-${String(index).padStart(6, "0")}.bin`;
const scratchSortRun = (index: number) => `rotation-sort-${String(index).padStart(6, "0")}.run`;

/** Entries buffered per sorted run: RAM stays bounded by this chunk. */
export const SORT_CHUNK_ENTRIES = 512;
/**
 * Maximum receipt entries one rotation can sort: every committed transaction
 * in the retiring segment becomes exactly one entry, so this fixed capacity is
 * a hard bound on the segments MAX_ACTIVE_WAL_BYTES may admit (derivation in
 * receiptLedger.ts; enforced by the envelope derivation test).
 */
export const SORTER_ENTRY_CAPACITY = SCRATCH_NAMESPACE_SIZE * SORT_CHUNK_ENTRIES;

/**
 * Sweeps the entire deterministic rotation scratch namespace. ENOENT is the
 * idempotent-success case; every OTHER removal or directory-sync failure is
 * observable (never silently swallowed debris - Copilot AMBER Finding 5).
 * After successful removals the .private directory barrier is taken.
 */
async function sweepScratch(directory: string, io: DirectoryIO): Promise<Result<undefined>> {
  for (let index = 0; index < SCRATCH_NAMESPACE_SIZE; index++) {
    for (const name of [scratchCandidate(index), scratchCheckpoint(index), scratchHead(index), scratchSortRun(index)]) {
      try { await io.removeOwnedFile(join(directory, ".private", name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED", "Rotation scratch cleanup failed.");
      }
    }
  }
  try { await io.syncDirectory(join(directory, ".private")); }
  catch (error) {
    return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED", "Rotation scratch cleanup barrier failed.");
  }
  return ok(undefined);
}

/**
 * Incremental bounded external sort of the retiring segment's receipt
 * entries: entries stream in during the WAL scan, are sorted in
 * bounded chunks and flushed as sorted run files. RAM is bounded by
 * SORT_CHUNK_ENTRIES; run files are swept on every path.
 */
class SegmentSorter {
  private readonly runPaths: string[] = [];
  private readonly buffer: ReceiptEntry[] = [];
  private bufferBytes = 0;
  entryCount = 0;
  lineBytes = 0;

  constructor(private readonly directory: string, private readonly io: DirectoryIO, private readonly files: WalIO) {}

  async add(entry: ReceiptEntry): Promise<Result<undefined>> {
    const line = encodeReceiptEntryLine(entry);
    if (!line.ok) return line;
    this.buffer.push(entry);
    this.bufferBytes += line.value.byteLength;
    if (this.buffer.length >= SORT_CHUNK_ENTRIES) return this.flush();
    return ok(undefined);
  }

  private async flush(): Promise<Result<undefined>> {
    if (this.buffer.length === 0) return ok(undefined);
    if (this.runPaths.length >= SCRATCH_NAMESPACE_SIZE) {
      return err("RECOVERY_REQUIRED", "Rotation scratch namespace exhausted.", { reason: "resource-limit" });
    }
    const sorted = [...this.buffer].sort((a, b) => compareMutationIds(a.mutationId, b.mutationId));
    // Within-chunk duplicate mutationIds are logical corruption.
    for (let index = 1; index < sorted.length; index++) {
      if (compareMutationIds(sorted[index]!.mutationId, sorted[index - 1]!.mutationId) === 0) {
        return err("PERSISTENCE_CORRUPTION", "Duplicate mutation identity in the retiring segment.");
      }
    }
    const lines: Uint8Array[] = [];
    let bytes = 0;
    for (const entry of sorted) {
      const line = encodeReceiptEntryLine(entry);
      if (!line.ok) return line;
      lines.push(line.value);
      bytes += line.value.byteLength;
      this.entryCount++;
      this.lineBytes += line.value.byteLength;
    }
    const runPath = join(this.directory, ".private", scratchSortRun(this.runPaths.length));
    try {
      const handle = await this.files.open(runPath, true);
      try {
        let position = 0;
        for (const line of lines) {
          await handle.write(line, position);
          position += line.byteLength;
        }
        await handle.sync();
      } finally { await handle.close(); }
    } catch {
      return err("RECOVERY_REQUIRED", "Rotation segment sort run write failed.");
    }
    this.runPaths.push(runPath);
    this.buffer.length = 0;
    this.bufferBytes = 0;
    return ok(undefined);
  }

  /** Streaming ordered readers over the sorted runs (k-way merge inputs). */
  runs(): { runPaths: string[]; entryCount: number; lineBytes: number } {
    return { runPaths: [...this.runPaths], entryCount: this.entryCount, lineBytes: this.lineBytes };
  }

  async finish(): Promise<Result<{ runPaths: string[]; entryCount: number; lineBytes: number }>> {
    const flushed = await this.flush();
    if (!flushed.ok) return flushed;
    return ok(this.runs());
  }

  async sweep(): Promise<void> {
    for (const path of this.runPaths) {
      try { await this.io.removeOwnedFile(path); } catch { /* absent: fine */ }
    }
    this.runPaths.length = 0;
  }
}

/** Streaming reader of one sorted run (one entry in memory at a time). */
async function* readSortedRun(path: string, files: WalIO): AsyncGenerator<ReceiptEntry> {
  const handle = await files.open(path, false);
  try {
    const size = (await handle.stat()).size;
    let position = 0;
    let line = Buffer.alloc(0);
    const chunk = new Uint8Array(64 * 1024);
    while (position < size) {
      const bytes = await handle.read(chunk, position);
      if (bytes <= 0) break;
      position += bytes;
      const data = chunk.subarray(0, bytes);
      let offset = 0;
      while (offset < data.length) {
        const relative = data.subarray(offset).indexOf(10);
        if (relative < 0) {
          line = Buffer.concat([line, data.subarray(offset)]);
          offset = data.length;
        } else {
          const piece = data.subarray(offset, offset + relative + 1);
          offset += relative + 1;
          const entryLine = line.byteLength === 0 ? piece : Buffer.concat([line, piece]);
          line = Buffer.alloc(0);
          const decoded = decodeReceiptEntryLine(entryLine);
          if (!decoded.ok) throw new Error("Malformed sorted receipt run entry.");
          yield decoded.value;
        }
      }
    }
    if (line.byteLength !== 0) throw new Error("Sorted run tail truncated.");
  } finally {
    await handle.close();
  }
}

/**
 * P0-P7 checkpoint rotation under writer authority held across the whole
 * protocol. P6 (atomic HEAD activation) is the irreversible commit point:
 * pre-P6 failures leave the old lineage authoritative with only inert
 * artifacts; post-P6 (P7) failures report { activated: true, phase:
 * "post-activation" } and never claim old authority.
 */
export async function rotateDurableStore(input: RotationInput): Promise<Result<RotationOutcome>> {
  const io = input.io ?? nodeDirectoryIO;
  const files = input.files ?? nodeWalIO;
  const instrumentation = input.instrumentation ?? { at: async () => undefined };
  const { directory } = input;
  const generation = input.generation;

  return withRecoveryAuthority(directory, io, async authority => {
    await instrumentation.at("P0-authority");
    const head = authority.head;
    if (head.epochId !== generation.tip.epochId) {
      return err("RECOVERY_REQUIRED", "The published generation does not belong to the active store lineage.");
    }
    // T5-convention scratch sweep: crashed-rotation scratch never survives a
    // new attempt. ENOENT is tolerated; a real cleanup/barrier failure fails
    // the rotation pre-activation with the old lineage fully authoritative.
    const swept = await sweepScratch(directory, io);
    if (!swept.ok) return swept;
    await instrumentation.at("P1-capture");

    // The authoritative historical ledger for the CURRENT lineage (zero
    // history for a non-rotated root), fully verified before merging.
    const authoritative = await openAuthoritativeReceiptLedger(directory, head.storeId, head.epochId, head.checkpoint.checkpointId, files);
    if (!authoritative.ok) return authoritative;
    const previousReader = authoritative.value;
    if (previousReader) {
      const verified = await previousReader.verify();
      if (!verified.ok) return verified;
    }

    // P2: stream-scan the active WAL, proving it is anchored to exactly the
    // current checkpoint and terminates at exactly the captured generation
    // tip. Entries stream into the bounded segment sorter as they are read.
    await instrumentation.at("P2-scan");
    const sorter = new SegmentSorter(directory, io, files);
    const walPath = join(directory, "wal", `wal-${head.checkpoint.digest}.bin`);
    let retiredWalBytes = 0;
    const walKind = await io.kind(walPath);
    try {
      if (walKind === "file") {
        let handle: WalFileHandle | undefined;
        let scan: WalFileScan | undefined;
        try {
          handle = await files.open(walPath, false);
          retiredWalBytes = (await handle.stat()).size;
          const opened = await WalFileScan.open(walPath, handle, head, productionRegistry, files,
            { mode: "authority-held", verifyAuthority: authority.verify });
          if (!opened.ok) return opened;
          scan = opened.value;
          let cursor = scan.cursor();
          do {
            const batch = await scan.next(cursor);
            if (!batch.ok) return batch;
            cursor = batch.value.continuation;
            for (const tx of batch.value.transactions) {
              const added = await sorter.add({
                mutationId: tx.mutation.mutationId, intentDigest: tx.mutation.digest,
                txId: tx.identity.txId, transactionDigest: tx.identity.digest, operations: tx.operations as readonly WalOperation[]
              });
              if (!added.ok) return added;
            }
          } while (!cursor.ended);
          if (cursor.tip.txId !== generation.tip.txId || cursor.tip.epochId !== generation.tip.epochId
            || cursor.tip.digest !== generation.tip.digest) {
            return err("RECOVERY_REQUIRED", "The active WAL does not terminate at the captured committed tip; recover before rotating.");
          }
        } finally {
          if (handle) await handle.close();
        }
      } else if (walKind === "directory") {
        return err("RECOVERY_REQUIRED", "Unsafe WAL path.");
      } else if (head.checkpoint.tip.txId !== generation.tip.txId) {
        // No WAL file: the checkpoint tip must already be the captured tip.
        return err("RECOVERY_REQUIRED", "The active WAL is absent but the checkpoint does not match the captured tip.");
      }
    } catch (error) {
      await sorter.sweep();
      const scanCode = (error as { code?: string }).code as Parameters<typeof err>[0] | undefined;
      return err(scanCode ?? "RECOVERY_REQUIRED", "Rotation WAL scan failed.");
    }

    // P3: finish the bounded sort, then cumulative two-way merge of the
    // previous verified ledger stream and the sorted segment streams into the
    // new candidate ledger. Strictly increasing under the frozen comparator;
    // any duplicate mutationId anywhere is corruption.
    await instrumentation.at("P3-sort");
    const segment = await sorter.finish();
    if (!segment.ok) {
      await sorter.sweep();
      return segment;
    }
    await instrumentation.at("P3-merge");
    const previousEntries = previousReader ? previousReader.entries() : undefined;
    const previousIterator = previousEntries ? previousEntries[Symbol.asyncIterator]() : undefined;
    const segmentGenerators = segment.value.runPaths.map(path => readSortedRun(path, files));
    const segmentCursors: Array<{ generator: AsyncGenerator<ReceiptEntry>; current: ReceiptEntry | null }> =
      segmentGenerators.map(generator => ({ generator, current: null as ReceiptEntry | null }));
    let previousCurrent: ReceiptEntry | undefined = previousIterator ? (await previousIterator.next()).value : undefined;
    for (const cursor of segmentCursors) {
      const first = await cursor.generator.next();
      cursor.current = first.done ? null : first.value;
    }

    const receiptsDirectory = join(directory, RECEIPTS_DIRECTORY);
    if (await io.kind(receiptsDirectory) === "missing") await io.mkdirExclusive(receiptsDirectory);
    const candidatePath = join(directory, ".private", scratchCandidate(0));
    const headerLine = encodeReceiptHeaderLine({
      format: "ether.receipts", version: "1", storeId: head.storeId, epochId: head.epochId,
      retiredCheckpointDigest: head.checkpoint.digest,
      predecessorLedgerDigest: previousReader?.ledgerDigest ?? ROOT_PREDECESSOR_DIGEST,
      entryCount: (previousReader?.header.entryCount ?? 0) + segment.value.entryCount,
      payloadBytes: (previousReader?.header.payloadBytes ?? 0) + segment.value.lineBytes
    });
    if (!headerLine.ok) {
      await sorter.sweep();
      return headerLine;
    }

    const ledgerDigest = createHash("sha256");
    let written = 0;
    let lastWrittenId: string | undefined;
    let receiptCount = 0;
    let ledgerHandle: WalFileHandle | undefined;
    try {
      ledgerHandle = await files.open(candidatePath, true);
      await ledgerHandle.write(headerLine.value, 0);
      written += headerLine.value.byteLength;
      ledgerDigest.update(headerLine.value);
      const writeLine = async (line: Uint8Array) => {
        await ledgerHandle!.write(line, written);
        written += line.byteLength;
        ledgerDigest.update(line);
        receiptCount++;
      };
      for (;;) {
        // Smallest mutationId across the previous-ledger stream and every
        // sorted segment cursor, under the frozen comparator.
        let next: ReceiptEntry | undefined;
        let source: "previous" | "segment" = "previous";
        if (previousCurrent) next = previousCurrent;
        for (const cursor of segmentCursors) {
          if (cursor.current && (!next || compareMutationIds(cursor.current.mutationId, next.mutationId) < 0)) {
            next = cursor.current;
            source = "segment";
          }
        }
        if (!next) break;
        if (lastWrittenId !== undefined && compareMutationIds(next.mutationId, lastWrittenId) <= 0) {
          await sorter.sweep();
          return err("PERSISTENCE_CORRUPTION", "Duplicate mutation identity across retired history.");
        }
        lastWrittenId = next.mutationId;
        const line = encodeReceiptEntryLine(next);
        if (!line.ok) {
          await sorter.sweep();
          return line;
        }
        await writeLine(line.value);
        if (source === "segment") {
          for (const cursor of segmentCursors) {
            if (cursor.current && cursor.current.mutationId === next!.mutationId && cursor.current === next) {
              const advanced = await cursor.generator.next();
              cursor.current = advanced.done ? null : advanced.value;
              break;
            }
          }
        } else {
          const advanced = previousIterator ? await previousIterator.next() : undefined;
          previousCurrent = advanced && !advanced.done ? advanced.value : undefined;
        }
      }
      await ledgerHandle.sync();
    } catch (error) {
      await sorter.sweep();
      const mergeCode = (error as { code?: string }).code as Parameters<typeof err>[0] | undefined;
      return err(mergeCode ?? "RECOVERY_REQUIRED", "Rotation receipt ledger construction failed.");
    } finally {
      if (ledgerHandle) await ledgerHandle.close();
      for (const generator of segmentGenerators) await generator.return?.(undefined as never).catch(() => undefined);
      if (previousIterator) await previousIterator.return?.(undefined as never).catch(() => undefined);
    }
    const ledgerDigestHex = ledgerDigest.digest("hex");
    // The sort runs' content is now durably inside the candidate ledger.
    await sorter.sweep();

    // P4: checkpointId = ledgerDigest; encode the new checkpoint exactly once.
    await instrumentation.at("P4-checkpoint");
    const checkpoint = encodeCheckpoint({ storeId: head.storeId, checkpointId: ledgerDigestHex, tip: generation.tip }, generation.bytes);
    if (!checkpoint.ok) return checkpoint;
    const newHead: PersistedStoreHead = {
      format: HEAD_FORMAT, version: HEAD_VERSION, storeId: head.storeId, epochId: head.epochId,
      schemaVersion: head.schemaVersion, digestAlgorithm: DIGEST_ALGORITHM,
      checkpoint: checkpoint.value.identity, walFormat: head.walFormat
    };

    // P5: activate both artifacts into their FINAL immutable paths, fsync and
    // fully verify them, and sync their directories - all BEFORE HEAD activation.
    await instrumentation.at("P5-ledger-activate");
    const finalLedgerPath = receiptLedgerPath(directory, ledgerDigestHex);
    await io.activateFile(candidatePath, finalLedgerPath);
    let verifyHandle: WalFileHandle | undefined;
    try {
      verifyHandle = await files.open(finalLedgerPath, false);
      await verifyHandle.sync();
    } finally { if (verifyHandle) await verifyHandle.close(); }
    const storedLedger = await ReceiptLedgerReader.open(directory, ledgerDigestHex, files);
    if (!storedLedger.ok) return storedLedger;
    const ledgerVerified = await storedLedger.value.verify();
    if (!ledgerVerified.ok) return ledgerVerified;
    await io.syncDirectory(receiptsDirectory);

    await instrumentation.at("P5-checkpoint-activate");
    const checkpointCandidate = join(directory, ".private", scratchCheckpoint(0));
    await io.writeExclusive(checkpointCandidate, checkpoint.value.bytes);
    await io.syncDirectory(join(directory, ".private"));
    const finalCheckpointPath = join(directory, "checkpoints", `checkpoint-${ledgerDigestHex}.bin`);
    await io.activateFile(checkpointCandidate, finalCheckpointPath);
    const storedCheckpoint = await io.readBounded(finalCheckpointPath,
      PERSISTENCE_LIMITS.checkpointHeaderBytes + 1 + PERSISTENCE_LIMITS.checkpointPayloadBytes);
    if (!verifyCheckpoint(storedCheckpoint, newHead).ok) {
      return err("RECOVERY_REQUIRED", "Activated checkpoint verification failed.");
    }
    await io.syncDirectory(join(directory, "checkpoints"));

    // P6: IRREVERSIBLE rotation commit point - atomic HEAD activation.
    // The activation state is tracked explicitly through every substep
    // (Copilot AMBER Finding 4): pre-activation (HEAD rename never occurred,
    // old lineage definitely authoritative) is materially different from
    // head-renamed-durability-unconfirmed (process-visible HEAD may already be
    // the new lineage, crash durability unconfirmed - never reported as an
    // ordinary pre-activation failure).
    let headRenamed = false;
    try {
      await instrumentation.at("P6-head-activate");
      const headCandidate = join(directory, ".private", scratchHead(0));
      const encodedHead = encodeStoreHead(newHead);
      if (!encodedHead.ok) {
        return err(encodedHead.error.code, encodedHead.error.message, { activationState: "pre-activation" });
      }
      await io.writeExclusive(headCandidate, encodedHead.value);
      await io.syncDirectory(join(directory, ".private"));
      const persistedHead = await io.readBounded(headCandidate, PERSISTENCE_LIMITS.headBytes);
      const decodedHead = decodeStoreHead(persistedHead);
      if (!decodedHead.ok || !Buffer.from(persistedHead).equals(Buffer.from(encodedHead.value))) {
        return err("RECOVERY_REQUIRED", "HEAD candidate verification failed.", { activationState: "pre-activation" });
      }
      const activated = await io.activateFile(headCandidate, join(directory, "HEAD"));
      if (activated !== "atomic") {
        return err("DURABILITY_UNAVAILABLE", "Backend did not confirm atomic HEAD activation.", { activationState: "pre-activation" });
      }
      headRenamed = true;
      await io.syncDirectory(join(directory, ".private"));
      await io.syncDirectory(directory);
    } catch (error) {
      return err(error instanceof DirectoryIoError ? error.code : "RECOVERY_REQUIRED",
        error instanceof DirectoryIoError ? error.message : "HEAD activation failed.",
        { activationState: headRenamed ? "head-renamed-durability-unconfirmed" : "pre-activation" });
    }

    // P7: idempotent post-activation reclamation. The new lineage is now
    // authoritative; failures here NEVER undo the rotation and are reported
    // distinctly as post-activation cleanup. Unknown receipt artifacts from
    // older crashed rotations are unreferenced and therefore inert (frozen
    // orphan semantics); only known retired artifacts are reclaimed here.
    try {
      await instrumentation.at("P7-reclaim");
      if (walKind === "file") await io.removeOwnedFile(walPath);
      if (head.checkpoint.checkpointId !== ledgerDigestHex) {
        await io.removeOwnedFile(join(directory, "checkpoints", `checkpoint-${head.checkpoint.checkpointId}.bin`));
      }
      if (previousReader && previousReader.ledgerDigest !== ledgerDigestHex) {
        await io.removeOwnedFile(receiptLedgerPath(directory, previousReader.ledgerDigest));
      }
      const scratchSwept = await sweepScratch(directory, io);
      if (!scratchSwept.ok) throw new Error("scratch cleanup failed");
      await io.syncDirectory(join(directory, "wal"));
      await io.syncDirectory(join(directory, "checkpoints"));
      await io.syncDirectory(receiptsDirectory);
      await io.syncDirectory(directory);
    } catch {
      return err("RECOVERY_REQUIRED", "Rotation activated; reclamation cleanup is pending.",
        { activated: true, phase: "post-activation", newCheckpointDigest: checkpoint.value.identity.digest });
    }
    return ok({ activated: true, newCheckpointId: ledgerDigestHex, newCheckpointDigest: checkpoint.value.identity.digest,
      ledgerDigest: ledgerDigestHex, retiredWalBytes, receiptCount });
  });
}

export type { RecoveryAuthority, MutationId };
