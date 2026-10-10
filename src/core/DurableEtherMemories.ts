/**
 * Tranche 6: live durable runtime (AF1).
 *
 * Opt-in durable mode around the frozen T1-T5 persistence machinery. Legacy
 * EtherMemoriesCore, StoragePort and storagePath behavior remain untouched.
 *
 * Startup is recovery-before-writable: no runtime object escapes the factory
 * until authoritative recovery has produced the committed generation. Public
 * mutations are durable-first and REQUIRE a caller-stable logical mutation
 * identity: stable command + stable mutationId -> authoritative active-WAL
 * receipt lookup -> detached preparation -> precommit complete-post-state
 * validation -> payload-object durability when required -> WAL durable commit
 * -> single atomic publication of the new committed generation. A failed
 * durable mutation leaves the published committed generation completely
 * unchanged; there is no live optimistic mutation and no rollback path.
 *
 * Already-committed results (lost ACK, restart retry, cross-runtime race) are
 * reconstructed only from the exact committed effect set of the transaction
 * in the active WAL - never from the current generation and never by
 * re-executing Core.
 *
 * This module deliberately separates the narrow public surface
 * (DurableEtherMemories interface + openDurableEtherMemories +
 * createMutationId) from the internal runtime class and its
 * protocol-testing dependency injection: internal persistence types must not
 * leak into the package-root declarations. The runtime does NOT expose
 * mutable legacy module references (notes/diary/graph/linker/condensation):
 * state changes only through the durable path above.
 */

import type { MemoryExplanation, MemoryHealthReport, MemoryInspectionOptions } from "../types/index.js";
import { explainMemory, inspectMemoryHealth } from "./memoryInspection.js";
import type { DreamSelector, DreamCyclePreviewOptions, DreamPlan } from "../types/dreamPlan.js";
import { previewDreamCycle } from "./dreamPlan.js";
import type { DreamCycleResult } from "../types/dreamAnalysis.js";
import { runDreamCycle } from "./dreamExecution.js";
import type {
  BuildMemoryContextInput, DiaryEntry, EtherSnapshot, MemoryContext, MemoryNote, MindGraphEdge, RetrievalMatch, UserIdentity
} from "../types/index.js";
import type { CommittedTip, MutationId, PersistenceErrorCode } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";
import { join } from "node:path";
import { createId } from "../utils/ids.js";
import { LIBRARY_VERSION, STORE_SCHEMA_VERSION } from "../version.js";
import type { AddNoteInput, UpdateNoteInput } from "./MemoryNotes.js";
import type { AddDiaryInput } from "./DiarySystem.js";
import type { QueryOptions } from "./MemoryRetriever.js";
import { MemoryContextBuilder } from "./MemoryContext.js";
import { hydrateNote, hydrateDiary } from "./snapshotPreparation.js";
import { FsDurableStore } from "../persistence/FsDurableStore.js";
import { StartupRecovery } from "../persistence/StartupRecovery.js";
import { ProductionWalStore, productionRegistry, type SemanticOperation } from "../persistence/productionOperations.js";
import type { ProductionMutationCommand } from "../persistence/mutationPreparation.js";
import { attachTip, type StateRoot } from "../persistence/stateRoot.js";
import { encodeSnapshotPayload } from "../persistence/snapshotPayload.js";
import { DEFAULT_MAX_INDEX_BYTES } from "../persistence/recoveryMutationIndex.js";
import { rotateDurableStore, MAX_ACTIVE_WAL_BYTES } from "../persistence/checkpointRotation.js";
import { WAL_LIMITS } from "../persistence/wal.js";
import {
  GC_CANDIDATES_NAME, GC_VALIDATED_NAME, GcDigestSorter, type GcInstrumentation, type GcLimits,
  type GcScratchOptions, OBJECT_NAME_PATTERN, RunWriter, type SealedRun,
  SealedRunReader, createGcSession, deriveReclaimCandidates, extractObjectDigest, gcFailure,
  gcLimits, ioFailureCode, sweepGcScratch, type GcPhase
} from "../persistence/objectReclamation.js";
import { required, withRecoveryAuthority } from "../persistence/recoveryAuthority.js";
import { WalFileScan } from "../persistence/walFileScan.js";
import { openAuthoritativeReceiptLedger } from "../persistence/receiptLedger.js";
import { sameCommittedTip } from "../utils/durablePersistence.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../persistence/directoryIO.js";
import { nodeWalIO, type WalIO } from "../persistence/walIO.js";
import { DIGEST_ALGORITHM, HEAD_FORMAT, HEAD_VERSION, encodeCheckpoint, type PersistedStoreHead } from "../persistence/codecs.js";
import { parseTransactionSequenceId } from "../utils/durablePersistence.js";

export interface DurableEtherMemoriesOptions {
  readonly userId: string;
  readonly displayName?: string;
  readonly preferences?: Record<string, unknown>;
  /** Separate durable store directory (never a legacy JSON file path). */
  readonly directory: string;
  /**
   * Bootstrap policy. Never overwrites or reinitializes an existing,
   * partial, legacy, unknown or corrupt durable store:
   * - "auto" (default): missing -> create the initial store; active -> recover it.
   * - "create": require a missing store, otherwise fail closed.
   * - "existing": require an active store, otherwise fail closed.
   */
  readonly openMode?: "auto" | "create" | "existing";
}

/** Public observable lifecycle. "Opening" is factory-internal: no object escapes during it. */
export type DurableRuntimeState = "ready" | "recovery-required" | "closed";

/** Public recovery receipt shape; only public persistence identity types appear. */
export interface DurableRecoveryReceipt {
  readonly tip: CommittedTip;
  readonly repairedTailBytes: number;
  readonly transactions: number;
}

/**
 * Public rotation summary (Tranche 7). The published generation - state and
 * committed tip - is IDENTICAL before and after a successful rotation; only
 * the durable lineage (checkpoint, receipt ledger, active WAL segment)
 * changes.
 */
export interface DurableRotationSummary {
  readonly newCheckpointId: string;
  readonly newCheckpointDigest: string;
  readonly ledgerDigest: string;
  readonly retiredWalBytes: number;
  readonly receiptCount: number;
}

/**
 * Public garbage-collection summary (Tranche 8). Payload-object orphan
 * collection is generation-neutral and tip-neutral: the published generation
 * is IDENTICAL before and after. Only never-referenced payload objects
 * (precommit crash orphans and injected debris) can ever be reclaimed;
 * authoritative history - active WAL and cumulative receipts - is permanent
 * root set and never deleted.
 */
export interface DurableGcSummary {
  readonly scannedObjects: number;
  readonly markedReferences: number;
  readonly reclaimedObjects: number;
  readonly unknownArtifacts: number;
}

/**
 * Public maintenance receipt (Tranche 10). `runMaintenance()` is the single
 * explicit maintenance operation: it derives one deterministic rotation
 * recommendation from the configured active-WAL envelope and the frozen WAL
 * v1 frame cap, performs the existing Tranche 7 rotation only when the
 * recommendation fires, and follows a FULLY successful rotation with the
 * existing Tranche 8 orphan collection. The plan block is an OBSERVATION
 * derived while the maintenance operation held the runtime's single-flight
 * queue slot: a no-op receipt means maintenance was not recommended from the
 * active-WAL state observed during this run — it is NOT a snapshot guarantee
 * that another conforming writer cannot append afterward. Mutation admission
 * keeps its own exact precommit envelope check, and every destructive
 * operation still acquires the frozen Tranche 7/8 writer authority.
 */
export interface DurableMaintenanceReceipt {
  /** Derived at decision time under the maintenance queue slot. */
  readonly plan: {
    readonly activeWalBytes: number;
    /** The CONFIGURED instance envelope (production default: 30 MiB). */
    readonly envelopeBytes: number;
    readonly headroomBytes: number;
    readonly rotationRecommended: boolean;
    readonly reason: "within-headroom" | "rotation-headroom";
  };
  readonly performed: readonly ("rotation" | "garbage")[];
  readonly rotation?: DurableRotationSummary;
  readonly garbage?: DurableGcSummary;
}

/**
 * Public durable runtime surface. Only supported user-facing types appear
 * here; internal persistence types are deliberately absent.
 */
export interface DurableEtherMemories {
  readonly state: DurableRuntimeState;
  readonly tip: Result<CommittedTip>;
  queryMemories(text: string, options?: QueryOptions): Result<MemoryNote[]>;
  queryMemoriesDetailed(text: string, options?: QueryOptions): Result<RetrievalMatch[]>;
  buildMemoryContext(input: BuildMemoryContextInput): Result<MemoryContext>;
  getSystemState(): Result<UserIdentity>;
  exportData(): Result<EtherSnapshot>;
  explainMemory(id: string, options?: MemoryInspectionOptions): Result<MemoryExplanation>;
  inspectMemoryHealth(options?: MemoryInspectionOptions): Result<MemoryHealthReport>;
  previewDreamCycle(selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan>;
  runDreamCycle(plan: DreamPlan): Result<DreamCycleResult>;
  addMemory(input: AddNoteInput, mutationId: string): Promise<Result<MemoryNote>>;
  updateMemory(id: string, patch: UpdateNoteInput, mutationId: string): Promise<Result<MemoryNote>>;
  promoteCandidate(id: string, mutationId: string): Promise<Result<MemoryNote>>;
  deleteMemory(id: string, mutationId: string): Promise<Result<void>>;
  addDiaryEntry(input: AddDiaryInput, mutationId: string): Promise<Result<DiaryEntry>>;
  updateDiary(id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>, mutationId: string): Promise<Result<DiaryEntry>>;
  deleteDiary(id: string, mutationId: string): Promise<Result<void>>;
  addGraphEdge(id: string, source: string, target: string, relationship: string,
    data: Record<string, unknown>, mutationId: string): Promise<Result<MindGraphEdge>>;
  rotate(): Promise<Result<DurableRotationSummary>>;
  collectGarbage(): Promise<Result<DurableGcSummary>>;
  runMaintenance(): Promise<Result<DurableMaintenanceReceipt>>;
  recover(): Promise<Result<DurableRecoveryReceipt>>;
  close(): Promise<Result<void>>;
}

/**
 * Caller's stable logical mutation identity: generate it BEFORE the durable
 * operation, retain it, and reuse it for every retry of the same logical
 * command after ambiguity or restart. The runtime never generates an
 * invisible identity on the caller's behalf.
 */
export function createMutationId(): string { return createId("mut"); }

/**
 * Internal dependency-injection points for protocol testing only. Never part
 * of the package-root public surface.
 */
export interface DurableDependencies {
  readonly io?: DirectoryIO;
  readonly files?: WalIO;
  readonly indexDiskBytes?: number;
  readonly maxActiveWalBytes?: number;
  /** Internal protocol-testing injection for GC phase crash simulation. */
  readonly gcInstrumentation?: GcInstrumentation;
}

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Shared internal rotation-outcome classification (Tranche 10). ONE routing
 * table consumed by both public rotate() and public runMaintenance(); no
 * duplicated branch logic. Public rotate() remains observable-equivalent to
 * the frozen Tranche 7 behavior: the returned error keeps its code, message
 * and original details, with exactly the additive detail marks the frozen
 * wrapper already produced, and the lifecycle transition is identical.
 */
export const classifyRotationFailure = (failure: { code: string; details?: unknown }): {
  moveToRecoveryRequired: boolean;
  /** Present only for the two cases whose details gain an additive mark. */
  markedDetails?: Record<string, unknown>;
} => {
  const details = record(failure.details) ? failure.details : {};
  // P6 already committed the new lineage: pending cleanup must never be
  // reported as if the old lineage were still authoritative.
  if (details.activated === true) {
    return { moveToRecoveryRequired: false, markedDetails: { ...details, rotationCommitted: true } };
  }
  // HEAD may already point at the new lineage but crash durability of the
  // switch is unconfirmed: the runtime must not casually remain writable.
  if (details.activationState === "head-renamed-durability-unconfirmed") {
    return { moveToRecoveryRequired: true, markedDetails: { ...details, rotationDurabilityUncertain: true } };
  }
  // Same staleness semantics as durable mutations.
  if (failure.code === "RECOVERY_REQUIRED" || failure.code === "STALE_TRANSACTION_BASE") {
    return { moveToRecoveryRequired: true };
  }
  // Ordinary pre-activation failure: the old lineage remains fully
  // authoritative and the runtime stays ready.
  return { moveToRecoveryRequired: false };
};

/**
 * Shared internal garbage-collection failure routing (frozen Tranche 8
 * precedence, unchanged): authority-release uncertainty > authoritative data
 * uncertainty > ordinary maintenance failure, with the conservative
 * code-based classification when no GC disposition is present. Returns
 * whether the runtime must move to recovery-required; the returned error
 * itself is always passed through verbatim by both callers.
 */
export const gcFailureRequiresRecovery = (failure: { code: string; details?: unknown }): boolean => {
  const details = record(failure.details) ? failure.details : {};
  if (details.authorityReleaseFailed === true) return true;
  const disposition = details.gcDisposition;
  if (disposition === "authoritative") return true;
  if (disposition === "maintenance") return false;
  return failure.code === "PERSISTENCE_CORRUPTION" || failure.code === "RECOVERY_REQUIRED"
    || failure.code === "STALE_TRANSACTION_BASE";
};
const INITIAL_ANCHOR_TX = "9007199254740993";
const INITIAL_ANCHOR_DIGEST = "0".repeat(64);

/** Deterministic result reconstruction from the exact committed effect set. */
function selectNoteEffect(effects: readonly SemanticOperation[], expectedId?: string): Result<MemoryNote> {
  const puts = effects.filter(operation => operation.type === "ether.note.put");
  if (puts.length !== 1 || !record(puts[0]!.payload)) {
    return err("PERSISTENCE_CORRUPTION", "The committed effect set does not contain exactly one note effect.");
  }
  if (expectedId !== undefined && puts[0]!.payload.id !== expectedId) {
    return err("PERSISTENCE_CORRUPTION", "The committed note effect does not match the mutation target.");
  }
  return ok(hydrateNote(puts[0]!.payload));
}

function selectDiaryEffect(effects: readonly SemanticOperation[], expectedId?: string): Result<DiaryEntry> {
  const puts = effects.filter(operation => operation.type === "ether.diary.put");
  if (puts.length !== 1 || !record(puts[0]!.payload)) {
    return err("PERSISTENCE_CORRUPTION", "The committed effect set does not contain exactly one diary effect.");
  }
  if (expectedId !== undefined && puts[0]!.payload.id !== expectedId) {
    return err("PERSISTENCE_CORRUPTION", "The committed diary effect does not match the mutation target.");
  }
  return ok(hydrateDiary(puts[0]!.payload));
}

function selectEdgeEffect(effects: readonly SemanticOperation[], expectedId: string): Result<MindGraphEdge> {
  const puts = effects.filter(operation => operation.type === "ether.graph-edge.put");
  if (puts.length !== 1 || !record(puts[0]!.payload)) {
    return err("PERSISTENCE_CORRUPTION", "The committed effect set does not contain exactly one graph-edge effect.");
  }
  const edge = cloneValue(puts[0]!.payload) as MindGraphEdge;
  if (edge.id !== expectedId) {
    return err("PERSISTENCE_CORRUPTION", "The committed graph-edge effect does not match the mutation target.");
  }
  return ok(edge);
}

function selectRemoveEffect(effects: readonly SemanticOperation[], type: "ether.note.remove" | "ether.diary.remove", id: string): Result<void> {
  const removes = effects.filter(operation => operation.type === type);
  if (removes.length !== 1 || !record(removes[0]!.payload) || removes[0]!.payload.id !== id) {
    return err("PERSISTENCE_CORRUPTION", "The committed effect set does not contain the expected removal effect.");
  }
  return ok(undefined);
}

/** Tranche 8 collection outcome (internal shape behind DurableGcSummary). */
interface PayloadCollectionOutcome {
  readonly scannedObjects: number;
  readonly markedReferences: number;
  readonly reclaimedObjects: number;
  readonly unknownArtifacts: number;
}

/**
 * PRIVATE Tranche 8 G0-G7 payload-object orphan collection. This function is
 * deliberately NOT exported from any shipped module: destructive payload
 * reclamation is structurally owned by the runtime facade, which is the only
 * caller and supplies the committed tip captured from its own live published
 * generation. No shipped export anywhere accepts a caller-supplied tip,
 * acquires authority independently and unlinks payloads (structural containment;
 * absolute-path imports of internal modules reveal only non-destructive
 * scratch/planning helpers).
 *
 * Two-layer scratch integrity: whole-run seals prove completeness (exact count,
 * canonical encoding, ordering, no truncation/extension/omission/duplication);
 * per-record HMAC authentication - computed from the TRUSTED in-memory digest
 * of the producing computation under this invocation's ephemeral in-memory
 * key - proves, BEFORE any record is used, that the exact record authorizing
 * an unlink was produced by this trusted computation. The end-of-stream seal
 * is a completeness assertion and never the authority for an earlier
 * destructive action. Crash/restart discards the key, automatically
 * distrusting all stale authenticated scratch, which G1 sweeps deterministically.
 */
const collectPayloadObjectGarbage = async (input: {
  readonly directory: string;
  readonly io: DirectoryIO;
  readonly files: WalIO;
  /** Captured by the runtime facade from its own live published generation. */
  readonly expectedTip: CommittedTip;
  readonly instrumentation: GcInstrumentation;
  readonly limits?: GcScratchOptions;
}): Promise<Result<PayloadCollectionOutcome>> => {
  const io = input.io;
  const files = input.files;
  const limits = gcLimits(input.limits);
  if (!limits.ok) return limits;
  const directory = input.directory;
  if (!input.expectedTip || !parseTransactionSequenceId(input.expectedTip.txId).ok) {
    return err("INVALID_INPUT", "An exact committed tip of a live published generation is required.");
  }
  const expectedTip = input.expectedTip;
  const session = createGcSession();
  const instrumentation = input.instrumentation;
  let unknownArtifacts = 0;
  let markedReferences = 0;
  let scannedObjects = 0;
  let reclaimedObjects = 0;
  let phase: GcPhase = "G1-scratch-sweep";
  let disposition: "maintenance" | "authoritative" = "maintenance";
  const at = async (next: GcPhase, nextDisposition: "maintenance" | "authoritative" = "maintenance") => {
    phase = next;
    disposition = nextDisposition;
    await instrumentation.at(next);
  };
  const objectsDir = join(directory, "objects");

  return withRecoveryAuthority(directory, io, async authority => {
    let markRun: SealedRun | undefined;
    let inventoryRun: SealedRun | undefined;
    const markSorter = new GcDigestSorter(directory, "mark", io, files, limits.value, session);
    const inventorySorter = new GcDigestSorter(directory, "inventory", io, files, limits.value, session);
    const wrap = <T>(result: Result<T>): Result<T> => result.ok ? result
      : err(result.error.code, result.error.message, result.error.details);
    try {
      // G1: deterministic scratch sweep; ENOENT is idempotent success.
      await instrumentation.at("G1-scratch-sweep");
      const swept = await sweepGcScratch(directory, io, limits.value, phase);
      if (!swept.ok) return err(swept.error.code, swept.error.message, swept.error.details);

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
        return gcFailure(ledger.error.code as PersistenceErrorCode, ledger.error.message, phase, "authoritative");
      }
      if (ledger.value) {
        const verified = await ledger.value.verify(async entry => {
          for (const operation of entry.operations) {
            const digest = required(extractObjectDigest(operation));
            if (digest !== undefined) await addMark(digest);
          }
        });
        if (!verified.ok) {
          return gcFailure(verified.error.code as PersistenceErrorCode, verified.error.message, phase, "authoritative");
        }
      }
      const walPath = join(directory, "wal", `wal-${head.checkpoint.digest}.bin`);
      const walKind = await io.kind(walPath);
      if (walKind === "directory") return gcFailure("RECOVERY_REQUIRED", "Unsafe WAL path.", phase, "authoritative");
      if (walKind === "file") {
        let handle;
        let terminalTip: CommittedTip | undefined;
        try {
          handle = await files.open(walPath, false);
          const scan = required(await WalFileScan.open(walPath, handle, head, productionRegistry, files,
            { mode: "authority-held", verifyAuthority: authority.verify }));
          let cursor = scan.cursor();
          do {
            const nextBatch = await scan.next(cursor);
            if (!nextBatch.ok) {
              // Persistence-reading boundary: any payload/operation validation
              // failure here came from AUTHORITATIVE PERSISTED STATE, never
              // from a caller - malformed persisted references are corruption.
              // The frozen scanner/registry semantics are unchanged; only the
              // classification at this reading boundary is normalized.
              if (nextBatch.error.code === "INVALID_INPUT" || nextBatch.error.code === "UNSUPPORTED_PERSISTENCE_FORMAT") {
                return gcFailure("PERSISTENCE_CORRUPTION",
                  "Malformed persisted operation or object reference in authoritative history: " + nextBatch.error.message,
                  phase, "authoritative");
              }
              return gcFailure(nextBatch.error.code as PersistenceErrorCode, nextBatch.error.message, phase, "authoritative");
            }
            const batch = nextBatch.value;
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
          return gcFailure("RECOVERY_REQUIRED",
            "The active WAL does not terminate at the captured committed tip; recover before collecting garbage.",
            phase, "authoritative", { capturedTip: { ...expectedTip }, durableTip: { ...terminalTip! } });
        }
      } else if (!sameCommittedTip(head.checkpoint.tip, expectedTip)) {
        return gcFailure("RECOVERY_REQUIRED",
          "The active WAL is absent but the checkpoint does not represent the captured committed tip; recover before collecting garbage.",
          phase, "authoritative", { capturedTip: { ...expectedTip }, checkpointTip: { ...head.checkpoint.tip } });
      }
      await authority.verify();
      const finishedMark = await markSorter.finish();
      if (!finishedMark.ok) return err(finishedMark.error.code, finishedMark.error.message, finishedMark.error.details);
      markRun = finishedMark.value;
      markedReferences = markRun?.records ?? 0;

      // G3: physical inventory enumeration. Only valid-name REGULAR files are
      // inventory items; malformed names, dotfiles, directories and symlinks
      // are never deleted, never followed and count as unknown artifacts.
      await at("G3-inventory", "maintenance");
      const objectsKind = await io.kind(objectsDir);
      if (objectsKind === "file") {
        return gcFailure("RECOVERY_REQUIRED", "Unsafe payload-object directory.", phase, "maintenance");
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
      if (!finishedInventory.ok) return err(finishedInventory.error.code, finishedInventory.error.message, finishedInventory.error.details);
      inventoryRun = finishedInventory.value;
      scannedObjects = inventoryRun?.records ?? 0;

      // G4: bidirectional coverage proof over sealed, authenticated runs; no
      // deletion may occur before it succeeds completely.
      await at("G4-coverage", "maintenance");
      await authority.verify();
      const coverage = await deriveReclaimCandidates(markRun, inventoryRun,
        join(directory, ".private", GC_CANDIDATES_NAME), files, session);
      if (!coverage.ok) return err(coverage.error.code, coverage.error.message, coverage.error.details);
      await markSorter.sweep();
      await inventorySorter.sweep();

      // G5: revalidate every candidate immediately before it can be unlinked,
      // streaming authenticated records from the sealed candidates run, and
      // seal the validated stream with per-record authentication computed from
      // THIS trusted in-memory validated digest.
      await at("G5-validate", "maintenance");
      let validatedRun: SealedRun | undefined;
      if (coverage.value.candidatesRun) {
        const openedCandidates = await SealedRunReader.open(coverage.value.candidatesRun, files, session,
          "G5-validate", "maintenance");
        if (!openedCandidates.ok) return err(openedCandidates.error.code, openedCandidates.error.message, openedCandidates.error.details);
        const candidates = openedCandidates.value;
        const writer = new RunWriter(join(directory, ".private", GC_VALIDATED_NAME), files, session,
          "validated", "G5-validate");
        let writerOpen = false;
        try {
          const opened = await writer.open();
          if (!opened.ok) return err(opened.error.code, opened.error.message, opened.error.details);
          writerOpen = true;
          for (;;) {
            const item = await candidates.next();
            if (!item.ok) return err(item.error.code, item.error.message, item.error.details);
            const digest = item.value;
            if (digest === undefined) break;
            const path = join(objectsDir, digest + ".bin");
            try {
              if (await io.kind(path) !== "file") { unknownArtifacts++; continue; }
            } catch { unknownArtifacts++; continue; }
            const appended = await writer.append(digest);
            if (!appended.ok) return err(appended.error.code, appended.error.message, appended.error.details);
          }
          const consumed = candidates.verifyConsumed();
          if (!consumed.ok) return err(consumed.error.code, consumed.error.message, consumed.error.details);
          const sealed = await writer.close();
          if (!sealed.ok) return err(sealed.error.code, sealed.error.message, sealed.error.details);
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
              return gcFailure(ioFailureCode(error), "GC candidate cleanup failed.", phase, "maintenance");
            }
          }
          validatedRun = undefined;
        }
      }

      // G6: unlink ONLY records whose per-record authentication verifies
      // immediately before the unlink. The digest is extracted after the
      // record's HMAC authenticates under this invocation's in-memory key; a
      // substituted, reordered, replayed or cross-invocation record fails
      // BEFORE any unlink. Batched with objects/ barriers; the end-of-stream
      // seal is a completeness assertion over already-individually-
      // authenticated deletions.
      await at("G6-reclaim", "maintenance");
      await authority.verify();
      if (validatedRun) {
        const openedValidated = await SealedRunReader.open(validatedRun, files, session, "G6-reclaim", "maintenance");
        if (!openedValidated.ok) return err(openedValidated.error.code, openedValidated.error.message, openedValidated.error.details);
        const reader = openedValidated.value;
        let batch = 0;
        let remaining = validatedRun.records;
        try {
          for (;;) {
            const item = await reader.next();
            if (!item.ok) {
              return gcFailure(item.error.code as PersistenceErrorCode, item.error.message, phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining, scannedObjects, markedReferences, unknownArtifacts });
            }
            const digest = item.value;
            if (digest === undefined) break;
            remaining--;
            const stable = await reader.checkStamp();
            if (!stable.ok) {
              return gcFailure(stable.error.code as PersistenceErrorCode, stable.error.message, phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining + 1, scannedObjects, markedReferences, unknownArtifacts });
            }
            try {
              await io.removeOwnedFile(join(objectsDir, digest + ".bin"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                reclaimedObjects++;
                continue;
              }
              return gcFailure(ioFailureCode(error), "Payload-object reclamation failed.", phase, "maintenance",
                { reclaimedObjects, remainingCandidates: remaining + 1, scannedObjects, markedReferences, unknownArtifacts });
            }
            reclaimedObjects++;
            batch++;
            if (batch >= limits.value.unlinkBatch) {
              try { await io.syncDirectory(objectsDir); }
              catch (error) {
                return gcFailure(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
                  "Payload-object reclamation barrier failed.", phase, "maintenance",
                  { reclaimedObjects, remainingCandidates: remaining, scannedObjects, markedReferences, unknownArtifacts });
              }
              batch = 0;
            }
          }
          const consumed = reader.verifyConsumed();
          if (!consumed.ok) {
            return gcFailure(consumed.error.code as PersistenceErrorCode, consumed.error.message, phase, "maintenance",
              { reclaimedObjects, remainingCandidates: 0, scannedObjects, markedReferences, unknownArtifacts });
          }
          if (batch > 0) {
            try { await io.syncDirectory(objectsDir); }
            catch (error) {
              return gcFailure(error instanceof DirectoryIoError ? error.code : "DURABILITY_UNAVAILABLE",
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
      if (!finalSwept.ok) return err(finalSwept.error.code, finalSwept.error.message, finalSwept.error.details);
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
        const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? error.details as Record<string, unknown> : {};
        const ownPhase = typeof details.gcPhase === "string" ? details.gcPhase as GcPhase : undefined;
        const ownDisposition = typeof details.gcDisposition === "string"
          ? details.gcDisposition as "maintenance" | "authoritative" : undefined;
        return err(error.code, error.message,
          { gcPhase: ownPhase ?? phase, gcDisposition: ownDisposition ?? disposition });
      }
      return err(ioFailureCode(error), "Payload-object garbage collection failed.",
        { gcPhase: phase, gcDisposition: disposition });
    }
  });
};

/** Internal runtime implementation; the public surface is the interface above. */
class DurableRuntime implements DurableEtherMemories {
  /**
   * Runtime-enforced encapsulation (final RED repair): every internal state
   * reference is an ECMAScript #private field, not a TypeScript-private
   * property. TypeScript `private` is compile-time only and leaves the
   * canonical generation reachable as an ordinary own property in emitted
   * JavaScript, which would allow bypassing every durable mutation API and
   * mutating live modules directly. #private fields do not exist on the
   * object's own/prototype property graph at runtime: a caller holding the
   * public durable-runtime object has no route to the canonical generation,
   * its mutable modules, the store, or injected I/O dependencies.
   */
  #generation?: StateRoot;
  #lifecycle: DurableRuntimeState = "ready";
  readonly #store: ProductionWalStore;
  /** Single-flight in-process serialization of durable operations. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #directory: string;
  readonly #userId: string;
  readonly #io: DirectoryIO;
  readonly #files: WalIO;
  readonly #indexDiskBytes: number;
  readonly #gcInstrumentation: GcInstrumentation;

  constructor(directory: string, userId: string, io: DirectoryIO, files: WalIO, indexDiskBytes: number,
    maxActiveWalBytes: number, gcInstrumentation: GcInstrumentation = { at: async () => undefined }) {
    this.#directory = directory;
    this.#userId = userId;
    this.#io = io;
    this.#files = files;
    this.#indexDiskBytes = indexDiskBytes;
    this.#gcInstrumentation = gcInstrumentation;
    this.#store = new ProductionWalStore(directory, io, files, maxActiveWalBytes);
  }

  /**
   * Durable factory: inspect/bootstrap -> authoritative recovery -> ready
   * runtime. Nothing escapes before recovery succeeds. The io/files
   * parameters are internal injection points for protocol testing.
   */
  static async open(options: DurableEtherMemoriesOptions, io: DirectoryIO = nodeDirectoryIO,
    files: WalIO = nodeWalIO, indexDiskBytes: number = DEFAULT_MAX_INDEX_BYTES,
    maxActiveWalBytes: number = MAX_ACTIVE_WAL_BYTES,
    gcInstrumentation: GcInstrumentation = { at: async () => undefined }): Promise<Result<DurableRuntime>> {
    if (!record(options) || typeof options.userId !== "string" || !options.userId.trim()) {
      return err("INVALID_INPUT", "A non-empty userId is required.");
    }
    if (typeof options.directory !== "string" || !options.directory.trim()) {
      return err("INVALID_INPUT", "A durable store directory is required.");
    }
    const openMode = options.openMode ?? "auto";
    const inspected = await new FsDurableStore({ directory: options.directory }, io).inspect();
    if (!inspected.ok) return inspected;
    if (inspected.value.state === "legacy-json") {
      return err("PERSISTENCE_CORRUPTION", "Durable mode never converts or overwrites a legacy store; migration is a future tranche.");
    }
    if (inspected.value.state !== "missing" && openMode === "create") {
      return err("INVALID_INPUT", "openMode \"create\" requires a missing durable store.");
    }
    if (inspected.value.state !== "active" && openMode === "existing") {
      return err("INVALID_INPUT", "openMode \"existing\" requires an active durable store.");
    }
    if (inspected.value.state === "missing") {
      const bootstrapped = await DurableRuntime.bootstrap(options, io);
      if (!bootstrapped.ok) return bootstrapped;
    }
    const runtime = new DurableRuntime(options.directory, options.userId, io, files, indexDiskBytes,
      maxActiveWalBytes, gcInstrumentation);
    const recovered = await runtime.recover();
    if (!recovered.ok) return recovered;
    return ok(runtime);
  }

  /** One-time initial store creation; never reinitializes an existing store. */
  private static async bootstrap(options: DurableEtherMemoriesOptions, io: DirectoryIO): Promise<Result<undefined>> {
    const now = new Date();
    const snapshot: EtherSnapshot = {
      schemaVersion: STORE_SCHEMA_VERSION,
      identity: { userId: options.userId, displayName: options.displayName, createdAt: now, lastActive: now,
        preferences: cloneValue(options.preferences ?? {}) },
      memoryNotes: [], diary: [], graph: { nodes: [], edges: [] }
    };
    const payload = encodeSnapshotPayload(snapshot);
    if (!payload.ok) return payload;
    const anchorTx = parseTransactionSequenceId(INITIAL_ANCHOR_TX);
    if (!anchorTx.ok) return anchorTx;
    const storeId = createId("store");
    const anchor = { epochId: createId("epoch"), txId: anchorTx.value, digest: INITIAL_ANCHOR_DIGEST };
    const checkpoint = encodeCheckpoint({ storeId, checkpointId: "checkpoint-initial", tip: anchor }, payload.value);
    if (!checkpoint.ok) return checkpoint;
    const head: PersistedStoreHead = {
      format: HEAD_FORMAT, version: HEAD_VERSION, storeId, epochId: anchor.epochId,
      schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM,
      checkpoint: checkpoint.value.identity, walFormat: { format: "ether.wal", version: "1" }
    };
    const initialized = await new FsDurableStore({ directory: options.directory }, io)
      .initialize({ head, checkpointBytes: checkpoint.value.bytes });
    return initialized.ok ? ok(undefined) : initialized;
  }

  get state(): DurableRuntimeState { return this.#lifecycle; }

  get tip(): Result<CommittedTip> {
    const generation = this.#generation;
    if (this.#lifecycle === "closed" || !generation) {
      return err("CLOSED", "This durable runtime is closed.");
    }
    return ok({ ...generation.tip });
  }

/** Committed-generation reads remain available in every non-closed state. */
  #readable(): Result<StateRoot> {
    if (this.#lifecycle === "closed" || !this.#generation) {
      return err("CLOSED", "This durable runtime is closed.");
    }
    return ok(this.#generation);
  }

  queryMemories(text: string, options?: QueryOptions): Result<MemoryNote[]> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    return ok(generation.value.retriever.query(text, options).map(x => cloneValue(x.memory)));
  }

  explainMemory(id: string, options?: MemoryInspectionOptions): Result<MemoryExplanation> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    if (this.#lifecycle === "recovery-required") return err("RECOVERY_REQUIRED", "Recover before inspecting logical memory.");
    return explainMemory(generation.value.notes, generation.value.graph, id, options);
  }

  inspectMemoryHealth(options?: MemoryInspectionOptions): Result<MemoryHealthReport> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    if (this.#lifecycle === "recovery-required") return err("RECOVERY_REQUIRED", "Recover before inspecting logical memory.");
    return inspectMemoryHealth(generation.value.notes, generation.value.graph, options);
  }

  previewDreamCycle(selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    if (this.#lifecycle === "recovery-required") return err("RECOVERY_REQUIRED", "Recover before planning logical memory.");
    return previewDreamCycle(generation.value.notes, generation.value.graph, selector, options);
  }

  runDreamCycle(plan: DreamPlan): Result<DreamCycleResult> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    if (this.#lifecycle === "recovery-required") return err("RECOVERY_REQUIRED", "Recover before analyzing logical memory.");
    return runDreamCycle(generation.value.notes, generation.value.graph, plan);
  }

  queryMemoriesDetailed(text: string, options?: QueryOptions): Result<RetrievalMatch[]> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    return ok(generation.value.retriever.query(text, options).map(x => ({
      ...cloneValue(x),
      memory: cloneValue(x.memory),
      matchedBy: [...x.matchedBy],
      evidence: cloneValue(x.evidence),
      graphEvidence: x.graphEvidence ? cloneValue(x.graphEvidence) : undefined
    })));
  }

  buildMemoryContext(input: BuildMemoryContextInput): Result<MemoryContext> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    try {
      return ok(new MemoryContextBuilder(LIBRARY_VERSION, generation.value.snapshot.identity.userId,
        generation.value.snapshot.identity.displayName, generation.value.retriever, generation.value.graph,
        () => generation.value.notes.valuesUnsafe(), () => generation.value.diary.valuesUnsafe()).build(input));
    } catch (e) {
      return err("INVALID_INPUT", e instanceof Error ? e.message : "Unable to build memory context.");
    }
  }

  getSystemState(): Result<UserIdentity> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    return ok(cloneValue(generation.value.snapshot.identity));
  }

  exportData(): Result<EtherSnapshot> {
    const generation = this.#readable();
    if (!generation.ok) return generation;
    return ok(cloneValue(generation.value.snapshot));
  }

  async addMemory(input: AddNoteInput, mutationId: string): Promise<Result<MemoryNote>> {
    return this.runMutation(mutationId, { kind: "note.put", input }, effects => selectNoteEffect(effects));
  }

  async updateMemory(id: string, patch: UpdateNoteInput, mutationId: string): Promise<Result<MemoryNote>> {
    return this.runMutation(mutationId, { kind: "note.update", id, patch }, effects => selectNoteEffect(effects, id));
  }

  async promoteCandidate(id: string, mutationId: string): Promise<Result<MemoryNote>> {
    return this.runMutation(mutationId, { kind: "note.update", id, patch: { status: "active" } },
      effects => selectNoteEffect(effects, id));
  }

  async deleteMemory(id: string, mutationId: string): Promise<Result<void>> {
    return this.runMutation(mutationId, { kind: "note.remove", id }, effects => selectRemoveEffect(effects, "ether.note.remove", id));
  }

  async addDiaryEntry(input: AddDiaryInput, mutationId: string): Promise<Result<DiaryEntry>> {
    return this.runMutation(mutationId, { kind: "diary.put", input }, effects => selectDiaryEffect(effects));
  }

  async updateDiary(id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>, mutationId: string): Promise<Result<DiaryEntry>> {
    return this.runMutation(mutationId, { kind: "diary.update", id, patch }, effects => selectDiaryEffect(effects, id));
  }

  async deleteDiary(id: string, mutationId: string): Promise<Result<void>> {
    return this.runMutation(mutationId, { kind: "diary.remove", id }, effects => selectRemoveEffect(effects, "ether.diary.remove", id));
  }

  async addGraphEdge(id: string, source: string, target: string, relationship: string,
    data: Record<string, unknown>, mutationId: string): Promise<Result<MindGraphEdge>> {
    return this.runMutation(mutationId, { kind: "graph-edge.put", id, source, target, relationship, data },
      effects => selectEdgeEffect(effects, id));
  }

  /**
   * Explicit checkpoint rotation (Tranche 7): write a new checkpoint from the
   * exact committed tip, durably preserve the retiring WAL segment's mutation
   * receipts in the cumulative receipt ledger, activate the new anchored
   * lineage and reclaim the retired WAL. The published generation (state and
   * tip) is IDENTICAL before and after a successful rotation. Rotation
   * serializes behind the same single-flight queue as mutations: queued
   * mutations run either entirely before or entirely after it, and reads
   * continue from the current immutable generation throughout.
   */
  async rotate(): Promise<Result<DurableRotationSummary>> {
    return this.enqueue(async () => {
      if (this.#lifecycle === "closed") return err("CLOSED", "This durable runtime is closed.");
      const generation = this.#generation;
      if (this.#lifecycle !== "ready" || !generation) {
        return err("RECOVERY_REQUIRED", "Recovery is required before rotation.");
      }
      const outcome = await rotateDurableStore({
        directory: this.#directory,
        generation: { bytes: generation.bytes, tip: generation.tip },
        io: this.#io,
        files: this.#files
      });
      if (outcome.ok) {
        return ok({
          newCheckpointId: outcome.value.newCheckpointId,
          newCheckpointDigest: outcome.value.newCheckpointDigest,
          ledgerDigest: outcome.value.ledgerDigest,
          retiredWalBytes: outcome.value.retiredWalBytes,
          receiptCount: outcome.value.receiptCount
        });
      }
      // One shared internal routing table (Tranche 10): identical observable
      // behavior to the frozen Tranche 7 wrapper - same lifecycle
      // transitions, code, message, original details and additive marks.
      const disposition = classifyRotationFailure(outcome.error);
      if (disposition.moveToRecoveryRequired) {
        this.#lifecycle = "recovery-required";
      }
      if (disposition.markedDetails === undefined) return outcome;
      return err(outcome.error.code, outcome.error.message, disposition.markedDetails);
    });
  }

  /**
   * Explicit payload-object orphan collection (Tranche 8). Serialized behind
   * the same single-flight queue as mutations and rotation. GC never changes
   * HEAD, checkpoints, WAL/receipt authority, the published generation or the
   * committed tip; only provably unreachable payload objects are deleted.
   * The captured committed tip of the published generation is passed to the
   * collector: G2 proves the scanned active persistence representation reaches
   * exactly that tip (frozen rotation-P2 precedent) before coverage/deletion,
   * so a truncated or vanished active segment fails closed instead of
   * silently omitting committed roots. Because deleted files are already
   * unreachable, maintenance failures (mark scratch, unlink, directory
   * barrier, scratch cleanup) return exact partial-reclaim details while the
   * runtime REMAINS ready - GC has no P6 and no authority-switch. Only
   * failures that make authoritative data itself uncertain (corrupt history,
   * terminal-tip mismatch, a marked object physically missing) move the
   * runtime to recovery-required.
   */
  async collectGarbage(): Promise<Result<DurableGcSummary>> {
    return this.enqueue(async () => {
      if (this.#lifecycle === "closed") return err("CLOSED", "This durable runtime is closed.");
      const generation = this.#generation;
      if (this.#lifecycle !== "ready" || !generation) {
        return err("RECOVERY_REQUIRED", "Recovery is required before garbage collection.");
      }
      const outcome = await collectPayloadObjectGarbage({
        directory: this.#directory, io: this.#io, files: this.#files, expectedTip: generation.tip,
        instrumentation: this.#gcInstrumentation
      });
      if (!outcome.ok) {
        // One shared internal routing table (Tranche 10): the frozen Tranche 8
        // precedence - AUTHORITY UNCERTAINTY (writer-lock release/barrier
        // failure, marked by the authority coordinator) > AUTHORITATIVE DATA
        // UNCERTAINTY (gcDisposition "authoritative") > MAINTENANCE FAILURE
        // (gcDisposition "maintenance"), with the conservative code-based
        // classification when no explicit disposition exists - is applied
        // unchanged; the error itself is returned verbatim.
        if (gcFailureRequiresRecovery(outcome.error)) {
          this.#lifecycle = "recovery-required";
        }
        return outcome;
      }
      return ok({
        scannedObjects: outcome.value.scannedObjects,
        markedReferences: outcome.value.markedReferences,
        reclaimedObjects: outcome.value.reclaimedObjects,
        unknownArtifacts: outcome.value.unknownArtifacts
      });
    });
  }

  /**
   * Explicit deterministic maintenance orchestration (Tranche 10). ONE
   * queue slot; never invokes the public rotate()/collectGarbage() (they
   * enqueue themselves and nested entry would self-deadlock) - it calls the
   * same non-enqueue module helpers those wrappers call, directly under this
   * single hold. The maintenance plan is derived under the held slot: the
   * single rotation recommendation uses the CONFIGURED instance envelope and
   * the frozen WAL v1 total-frame cap (`effectiveNextFrameBound =
   * min(WAL_LIMITS.frameBytes, envelopeBytes)`; recommendation iff
   * `activeWalBytes + effectiveNextFrameBound > envelopeBytes`, strict, so
   * equality - exactly enough room for a maximal legal frame - remains
   * admissible and an empty WAL under a sub-cap envelope never repeats empty
   * rotations). No recommendation -> successful no-op receipt. Otherwise the
   * existing Tranche 7 rotation runs; ONLY a fully successful rotation
   * proceeds to the existing Tranche 8 orphan collection. Failures return
   * the EXISTING underlying error (code, message, every original detail)
   * plus only additive orchestration context (`maintenanceStage`, and
   * `completedRotation` when a fully committed rotation precedes a GC
   * failure - the rotation is never implied to have rolled back). A genuine
   * failure is never reported through ok(). No timers, no background
   * scheduling, no persisted maintenance state: maintenance executes only
   * when the caller explicitly invokes this method, and the plan remains an
   * observation, not a durable snapshot or an authority receipt.
   */
  async runMaintenance(): Promise<Result<DurableMaintenanceReceipt>> {
    return this.enqueue(async () => {
      if (this.#lifecycle === "closed") return err("CLOSED", "This durable runtime is closed.");
      const generation = this.#generation;
      if (this.#lifecycle !== "ready" || !generation) {
        return err("RECOVERY_REQUIRED", "Recovery is required before maintenance.");
      }
      const observation = await this.#store.observeActiveWalEnvelope();
      if (!observation.ok) {
        // Same unlocked-observation failure class as the precommit envelope
        // check: an ordinary read failure, returned verbatim; the runtime
        // stays ready and the caller may retry.
        return observation;
      }
      const activeWalBytes = observation.value.activeWalBytes;
      const envelopeBytes = observation.value.envelopeBytes;
      const effectiveNextFrameBound = Math.min(WAL_LIMITS.frameBytes, envelopeBytes);
      const rotationRecommended = activeWalBytes + effectiveNextFrameBound > envelopeBytes;
      const plan = {
        activeWalBytes,
        envelopeBytes,
        headroomBytes: envelopeBytes - activeWalBytes,
        rotationRecommended,
        reason: (rotationRecommended ? "rotation-headroom" : "within-headroom") as
          "within-headroom" | "rotation-headroom"
      };
      if (!rotationRecommended) {
        const noOp: DurableMaintenanceReceipt = { plan, performed: [] };
        return ok(noOp);
      }
      const rotation = await rotateDurableStore({
        directory: this.#directory,
        generation: { bytes: generation.bytes, tip: generation.tip },
        io: this.#io,
        files: this.#files
      });
      if (!rotation.ok) {
        const disposition = classifyRotationFailure(rotation.error);
        if (disposition.moveToRecoveryRequired) this.#lifecycle = "recovery-required";
        const details = disposition.markedDetails !== undefined ? disposition.markedDetails
          : (record(rotation.error.details) ? rotation.error.details : {});
        return err(rotation.error.code, rotation.error.message,
          { ...details, maintenanceStage: "rotation" as const });
      }
      const rotationSummary: DurableRotationSummary = {
        newCheckpointId: rotation.value.newCheckpointId,
        newCheckpointDigest: rotation.value.newCheckpointDigest,
        ledgerDigest: rotation.value.ledgerDigest,
        retiredWalBytes: rotation.value.retiredWalBytes,
        receiptCount: rotation.value.receiptCount
      };
      // The published generation (state and tip) is identical across a
      // successful rotation; the captured tip remains the committed tip the
      // collector must prove the authoritative representation reaches.
      const garbage = await collectPayloadObjectGarbage({
        directory: this.#directory, io: this.#io, files: this.#files, expectedTip: generation.tip,
        instrumentation: this.#gcInstrumentation
      });
      if (!garbage.ok) {
        if (gcFailureRequiresRecovery(garbage.error)) this.#lifecycle = "recovery-required";
        const details = record(garbage.error.details) ? garbage.error.details : {};
        return err(garbage.error.code, garbage.error.message,
          { ...details, maintenanceStage: "garbage" as const, completedRotation: rotationSummary });
      }
      const completed: DurableMaintenanceReceipt = {
        plan,
        performed: ["rotation", "garbage"],
        rotation: rotationSummary,
        garbage: {
          scannedObjects: garbage.value.scannedObjects,
          markedReferences: garbage.value.markedReferences,
          reclaimedObjects: garbage.value.reclaimedObjects,
          unknownArtifacts: garbage.value.unknownArtifacts
        }
      };
      return ok(completed);
    });
  }

  /**
   * Explicit recovery. While state is "recovery-required", committed reads
   * remain available, recover() is available and durable mutations fail
   * predictably with RECOVERY_REQUIRED. Never performed transparently inside
   * an unrelated mutation.
   */
  async recover(): Promise<Result<DurableRecoveryReceipt>> {
    return this.enqueue(async () => {
      if (this.#lifecycle === "closed") return err("CLOSED", "This durable runtime is closed.");
      const recovery = new StartupRecovery(this.#directory, this.#userId, this.#io, this.#files, undefined, this.#indexDiskBytes);
      const receipt = await recovery.recover();
      if (!receipt.ok) {
        this.#lifecycle = "recovery-required";
        return receipt;
      }
      const generation = recovery.generation();
      if (!generation.ok) {
        this.#lifecycle = "recovery-required";
        return generation;
      }
      // Single synchronous publication: no awaits or partial writes in this boundary.
      this.#generation = generation.value;
      this.#lifecycle = "ready";
      return receipt;
    });
  }

  /** Deterministic release. Idempotent; no durable session leases exist to release. */
  async close(): Promise<Result<void>> {
    return this.enqueue(async () => {
      this.#lifecycle = "closed";
      this.#generation = undefined;
      return ok(undefined);
    });
  }

  /**
   * Durable mutation flow. The caller's stable mutationId is REQUIRED and is
   * never regenerated: total-ACK-loss idempotency is only possible for an
   * identity the caller already possessed.
   */
  private async runMutation<T>(mutationId: string, command: ProductionMutationCommand,
    select: (effects: readonly SemanticOperation[]) => Result<T>): Promise<Result<T>> {
    if (typeof mutationId !== "string" || !mutationId.trim()) {
      return err("INVALID_INPUT", "A stable mutationId is required for durable mutations.");
    }
    const captured = mutationId as MutationId;
    return this.enqueue(async () => {
      // Readiness is rechecked when each queued mutation begins: an earlier
      // queued operation may have moved the runtime to recovery-required.
      if (this.#lifecycle === "closed") return err("CLOSED", "This durable runtime is closed.");
      const generation = this.#generation;
      if (this.#lifecycle !== "ready" || !generation) {
        return err("RECOVERY_REQUIRED", "Recovery is required before durable mutations.", { mutationId: captured });
      }
      const outcome = await this.#store.commitMutationDetailed(generation.tip, generation.snapshot, captured, command);
      if (!outcome.ok) {
        const details = record(outcome.error.details) ? outcome.error.details : {};
        // Unambiguous precommit rejections (complete-post-state validation)
        // commit nothing: the runtime stays ready and usable.
        if (details.phase !== "precommit-validation"
          && (outcome.error.code === "RECOVERY_REQUIRED" || outcome.error.code === "STALE_TRANSACTION_BASE")) {
          this.#lifecycle = "recovery-required";
          return err(outcome.error.code, outcome.error.message, { ...details, mutationId: captured });
        }
        return outcome;
      }
      const receipt = outcome.value.receipt;
      if (receipt.status === "already-committed") {
        // An already-committed success may only be reported when the runtime's
        // published generation already includes that committed transaction
        // coherently. If the durable history is ahead of the published
        // generation (lost ACK, cross-runtime race), report RECOVERY_REQUIRED
        // with the mutation identity and require explicit recovery; never a
        // normal success over a stale live generation.
        if (generation.tip.epochId !== receipt.identity.epochId || BigInt(generation.tip.txId) < BigInt(receipt.identity.txId)) {
          this.#lifecycle = "recovery-required";
          return err("RECOVERY_REQUIRED", "The committed mutation is ahead of the published generation; recover and retry with the same mutation identity.",
            { mutationId: captured, committedTip: { ...receipt.identity } });
        }
        return select(outcome.value.effects);
      }
      // Committed: publish the prevalidated candidate generation with the
      // exact committed tip attached. Single synchronous publication: readers
      // see the old or the new committed generation, never a half-published
      // mixture.
      const root = outcome.value.root;
      if (!root) {
        this.#lifecycle = "recovery-required";
        return err("RECOVERY_REQUIRED", "Durable commit lost its prevalidated post-state; recover and retry with the same mutation identity.", { mutationId: captured });
      }
      this.#generation = attachTip(root, receipt.identity);
      return select(outcome.value.effects);
    });
  }

  private enqueue<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * The object returned to callers is NEVER the implementation instance: it is
 * a frozen plain-object facade whose members are closures over the internal
 * implementation. No property, symbol, descriptor, prototype or constructor
 * path leads from the facade back to the implementation, its #private state,
 * the store, injected I/O dependencies, or any bootstrap/open capability.
 * The only reachable functionality is the approved public API returning
 * detached data. The facade is created only after approved inspection/
 * bootstrap and successful startup recovery: no public runtime object can
 * exist in a false ready state.
 */
const createFacade = (implementation: DurableRuntime): DurableEtherMemories => Object.freeze({
  get state(): DurableRuntimeState { return implementation.state; },
  get tip(): Result<CommittedTip> { return implementation.tip; },
  queryMemories: (text: string, options?: QueryOptions): Result<MemoryNote[]> => implementation.queryMemories(text, options),
  queryMemoriesDetailed: (text: string, options?: QueryOptions): Result<RetrievalMatch[]> => implementation.queryMemoriesDetailed(text, options),
  buildMemoryContext: (input: BuildMemoryContextInput): Result<MemoryContext> => implementation.buildMemoryContext(input),
  getSystemState: (): Result<UserIdentity> => implementation.getSystemState(),
  exportData: (): Result<EtherSnapshot> => implementation.exportData(),
  explainMemory: (id: string, options?: MemoryInspectionOptions): Result<MemoryExplanation> => implementation.explainMemory(id, options),
  inspectMemoryHealth: (options?: MemoryInspectionOptions): Result<MemoryHealthReport> => implementation.inspectMemoryHealth(options),
  previewDreamCycle: (selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> => implementation.previewDreamCycle(selector, options),
  runDreamCycle: (plan: DreamPlan): Result<DreamCycleResult> => implementation.runDreamCycle(plan),
  addMemory: (input: AddNoteInput, mutationId: string): Promise<Result<MemoryNote>> => implementation.addMemory(input, mutationId),
  updateMemory: (id: string, patch: UpdateNoteInput, mutationId: string): Promise<Result<MemoryNote>> => implementation.updateMemory(id, patch, mutationId),
  promoteCandidate: (id: string, mutationId: string): Promise<Result<MemoryNote>> => implementation.promoteCandidate(id, mutationId),
  deleteMemory: (id: string, mutationId: string): Promise<Result<void>> => implementation.deleteMemory(id, mutationId),
  addDiaryEntry: (input: AddDiaryInput, mutationId: string): Promise<Result<DiaryEntry>> => implementation.addDiaryEntry(input, mutationId),
  updateDiary: (id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>, mutationId: string): Promise<Result<DiaryEntry>> => implementation.updateDiary(id, patch, mutationId),
  deleteDiary: (id: string, mutationId: string): Promise<Result<void>> => implementation.deleteDiary(id, mutationId),
  addGraphEdge: (id: string, source: string, target: string, relationship: string,
    data: Record<string, unknown>, mutationId: string): Promise<Result<MindGraphEdge>> =>
    implementation.addGraphEdge(id, source, target, relationship, data, mutationId),
  rotate: (): Promise<Result<DurableRotationSummary>> => implementation.rotate(),
  collectGarbage: (): Promise<Result<DurableGcSummary>> => implementation.collectGarbage(),
  runMaintenance: (): Promise<Result<DurableMaintenanceReceipt>> => implementation.runMaintenance(),
  recover: (): Promise<Result<DurableRecoveryReceipt>> => implementation.recover(),
  close: (): Promise<Result<void>> => implementation.close()
});

/** Wrap the internal implementation result in the public facade. */
const withFacade = (opened: Promise<Result<DurableRuntime>>): Promise<Result<DurableEtherMemories>> =>
  opened.then(result => result.ok ? ok(createFacade(result.value)) : result);

/** Public durable factory: only supported user configuration; no injection points. */
export const openDurableEtherMemories = (options: DurableEtherMemoriesOptions): Promise<Result<DurableEtherMemories>> =>
  withFacade(DurableRuntime.open(options));

/** Internal test factory with protocol-testing dependency injection; never exported from the package root. */
export const openDurableEtherMemoriesInternal = (options: DurableEtherMemoriesOptions,
  dependencies: DurableDependencies = {}): Promise<Result<DurableEtherMemories>> =>
  withFacade(DurableRuntime.open(options, dependencies.io ?? nodeDirectoryIO, dependencies.files ?? nodeWalIO,
    dependencies.indexDiskBytes ?? DEFAULT_MAX_INDEX_BYTES, dependencies.maxActiveWalBytes ?? MAX_ACTIVE_WAL_BYTES,
    dependencies.gcInstrumentation ?? { at: async () => undefined }));
