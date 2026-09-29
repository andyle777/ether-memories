import { join } from "node:path";
import type { BuildMemoryContextInput, EtherSnapshot } from "../types/index.js";
import type { CommittedTip, MutationId } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";
import { MemoryRetriever, type QueryOptions } from "../core/MemoryRetriever.js";
import { MemoryContextBuilder } from "../core/MemoryContext.js";
import { LIBRARY_VERSION } from "../version.js";
import { PERSISTENCE_LIMITS, verifyCheckpoint } from "./codecs.js";
import { nodeDirectoryIO, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, sameWalStamp, type WalFileHandle, type WalIO } from "./walIO.js";
import { WalFileScan } from "./walFileScan.js";
import { withRecoveryAuthority, required, type RecoveryAuthority } from "./recoveryAuthority.js";
import { buildStateRoot, type StateRoot } from "./stateRoot.js";
export { normalizeSnapshotGraph } from "./stateRoot.js";
import { decodeCheckpointSnapshotPayload, snapshotData } from "./snapshotPayload.js";
import { productionRegistry, reduceProduction, resolveOperation, validateCandidate } from "./productionOperations.js";
import { PayloadObjects } from "./payloadObjects.js";
import { encodeEtherData } from "./etherData.js";
import { DiskBackedMutationIndex, DEFAULT_MAX_INDEX_BYTES } from "./recoveryMutationIndex.js";
import type { JsonObject } from "./walJson.js";

export type RecoveryPhase = "checkpoint" | "transaction" | "tail-repair" | "indexes" | "before-publication" | "after-publication";
/** Trusted test instrumentation only, never invoked inside the publication assignment. */
export interface RecoveryInstrumentation { at(phase: RecoveryPhase, txId?: string): Promise<void> }

export interface RecoveryReceipt { readonly tip: CommittedTip; readonly repairedTailBytes: number; readonly transactions: number }

/**
 * Internal read-only durable runtime. Legacy Core constructors and StoragePort
 * remain untouched. No mutator/module references escape this generation boundary.
 */
export class StartupRecovery {
  private root?: StateRoot;
  private running = false;
  private lifecycle: "uninitialized" | "recovering" | "ready" | "recovery-required" = "uninitialized";
  constructor(private readonly directory: string, private readonly userId: string,
    private readonly io: DirectoryIO = nodeDirectoryIO, private readonly files: WalIO = nodeWalIO,
    private readonly instrumentation?: RecoveryInstrumentation,
    /** Internal recovery-index disk bound; the default never limits normal histories. */
    private readonly indexDiskBytes: number = DEFAULT_MAX_INDEX_BYTES) {}
  get state() { return this.lifecycle; }
  read(): Result<{ snapshot: EtherSnapshot; tip: CommittedTip }> {
    const root = this.root;
    return root ? ok({ snapshot: cloneValue(root.snapshot), tip: { ...root.tip } })
      : err("RECOVERY_REQUIRED", "Durable canonical state is unavailable before successful recovery.");
  }
  /**
   * Internal single-ownership hand-off of the frozen recovered generation to
   * the durable runtime. The receiver owns the generation exclusively; this
   * recovery object must be discarded afterwards, and the generation is only
   * as immutable as its frozen StateRoot contract.
   */
  generation(): Result<StateRoot> {
    const root = this.root;
    return root ? ok(root) : err("RECOVERY_REQUIRED", "Durable canonical generation is unavailable before successful recovery.");
  }
  queryMemories(text: string, options?: QueryOptions) {
    const root = this.root;
    return root ? ok(cloneValue(root.retriever.query(text, options))) : err("RECOVERY_REQUIRED", "Durable canonical state is unavailable.");
  }
  buildMemoryContext(input: BuildMemoryContextInput) {
    const root = this.root;
    if (!root) return err("RECOVERY_REQUIRED", "Durable canonical state is unavailable.");
    try {
      return ok(new MemoryContextBuilder(LIBRARY_VERSION, root.snapshot.identity.userId, root.snapshot.identity.displayName,
        root.retriever, root.graph, () => root.notes.valuesUnsafe(), () => root.diary.valuesUnsafe()).build(input));
    } catch { return err("INVALID_INPUT", "Invalid memory context request."); }
  }
  private async phase(phase: RecoveryPhase, txId?: string) { await this.instrumentation?.at(phase, txId); }
  private async reconstruct(authority: RecoveryAuthority): Promise<Result<RecoveryReceipt>> {
    const { head } = authority;
    const checkpointBytes = await this.io.readBounded(join(authority.directory, "checkpoints", "checkpoint-" + head.checkpoint.checkpointId + ".bin"),
      PERSISTENCE_LIMITS.checkpointHeaderBytes + 1 + PERSISTENCE_LIMITS.checkpointPayloadBytes);
    // Physical integrity always precedes semantic decode or normalization.
    required(verifyCheckpoint(checkpointBytes, head));
    const separator = checkpointBytes.subarray(0, PERSISTENCE_LIMITS.checkpointHeaderBytes + 1).indexOf(10);
    const checkpoint = required(decodeCheckpointSnapshotPayload(checkpointBytes.subarray(separator + 1), this.userId));
    await this.phase("checkpoint");
    const path = join(authority.directory, "wal", "wal-" + head.checkpoint.digest + ".bin");
    const objects = new PayloadObjects(this.io, this.files);
    let repairedTailBytes = 0;
    let snapshot = checkpoint;
    let tip = head.checkpoint.tip;
    let transactions = 0;
    // Exact disk-backed mutation index: duplicate detection across the entire
    // WAL lineage with bounded RAM; disk usage scales with active WAL history.
    const mutationIndex = new DiskBackedMutationIndex(authority.directory, this.io, this.files, this.indexDiskBytes);
    
    try {
    for (let pass = 0; pass < 2; pass++) {
      let candidate = required(snapshotData(checkpoint)) as JsonObject;
      snapshot = checkpoint; tip = head.checkpoint.tip; transactions = 0;
      let file: WalFileHandle | undefined;
      let repaired = false;
      try {
        const kind = await this.io.kind(path);
        if (kind === "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe WAL path.");
        if (kind === "file") {
          file = await this.files.open(path, false);
          const scan = required(await WalFileScan.open(path, file, head, productionRegistry, this.files,
            { mode: "authority-held", verifyAuthority: authority.verify }));
          let cursor = scan.cursor();
          do {
            const batch = required(await scan.next(cursor));
            cursor = batch.continuation;
            for (const tx of batch.transactions) {
              // Adjacent byte-identical physical duplicate frames are deduplicated
              // by the scanner and replay exactly once (frozen WAL semantics).
              // Every logical transaction is recorded in the exact disk-backed
              // index; verifyExact() compares the entire WAL lineage below.
              required(await mutationIndex.record(tx.mutation.mutationId as MutationId,
                { digest: tx.mutation.digest, txId: tx.identity.txId }));
              for (const operation of tx.operations) {
                const semantic = required(await resolveOperation(operation, authority, objects));
                candidate = required(reduceProduction(candidate, operation.type, semantic));
                // Bound retained candidate growth before another object can be resolved.
                required(encodeEtherData(candidate));
              }
              snapshot = required(validateCandidate(candidate, this.userId));
              candidate = required(snapshotData(snapshot)) as JsonObject;
              tip = tx.identity;
              transactions++;
              await this.phase("transaction", tip.txId);
            }
          } while (!cursor.ended);
          // Exact duplicate verification across the entire active WAL lineage
          // must complete before tail repair or publication.
          required(await mutationIndex.verifyExact());
          required(await scan.checkSource());
          if (cursor.tail === "incomplete") {
            if (pass !== 0 || !file.truncate) {
              await mutationIndex.reset();
              throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Safe tail repair is unavailable.");
            }
            await this.phase("tail-repair");
            await authority.verify();
            required(await scan.checkSource());
            if (!sameWalStamp(scan.stamp, await file.stat())) {
              await mutationIndex.reset();
              throw new DirectoryIoError("RECOVERY_REQUIRED", "WAL changed before tail repair.");
            }
            repairedTailBytes = scan.stamp.size - cursor.completeBytes;
            await file.truncate(cursor.completeBytes);
            try { await file.sync(); } catch { 
              await mutationIndex.reset();
              throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Tail truncate sync failed."); 
            }
            await this.io.syncDirectory(join(authority.directory, "wal"));
            if ((await file.stat()).size !== cursor.completeBytes) {
              await mutationIndex.reset();
              throw new DirectoryIoError("RECOVERY_REQUIRED", "Tail repair length differs.");
            }
            repaired = true;
          } else {
            try { await file.sync(); } catch { 
              await mutationIndex.reset();
              throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Recovered WAL sync failed."); 
            }
            await this.io.syncDirectory(join(authority.directory, "wal"));
            required(await scan.checkSource());
            tip = cursor.tip;
          }
        }
      } finally { 
        if (file) await file.close(); 
        if (!repaired) await mutationIndex.reset();
      }
      if (repaired) {
        // Pass 1 rescans the repaired WAL from its checkpoint; index records
        // from pass 0 must not carry over into the rescan.
        required(await mutationIndex.reset());
        continue;
      }
      break;
    }
    // One shared construction path: recovery and the live durable runtime
    // publish generations built by the same internal helper (RED 4 + T6).
    await this.phase("indexes");
    const root = required(buildStateRoot(snapshot, tip));
    // Clean up the mutation index after successful recovery
    await mutationIndex.reset();
    await this.phase("before-publication");
    await authority.verify();
    // No awaits, callbacks, I/O, or independent state/tip assignments in this boundary.
    this.root = root;
    this.lifecycle = "ready";
    await this.phase("after-publication");
    return ok({ tip: { ...tip }, repairedTailBytes, transactions });
    } catch (error) {
      // Clean up mutation index on any error
      await mutationIndex.reset();
      throw error;
    }
  }
  async recover(): Promise<Result<RecoveryReceipt>> {
    if (this.running) return err("WRITER_BUSY", "This runtime is already recovering.");
    this.running = true;
    this.lifecycle = "recovering";
    try {
      return await withRecoveryAuthority(this.directory, this.io, authority => this.reconstruct(authority));
    } finally {
      this.running = false;
      this.lifecycle = this.root ? "ready" : "recovery-required";
    }
  }
}
