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

import type {
  BuildMemoryContextInput, DiaryEntry, EtherSnapshot, MemoryContext, MemoryNote, MindGraphEdge, RetrievalMatch, UserIdentity
} from "../types/index.js";
import type { CommittedTip, MutationId } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";
import { createId } from "../utils/ids.js";
import { LIBRARY_VERSION, STORE_SCHEMA_VERSION } from "../version.js";
import type { AddNoteInput, UpdateNoteInput } from "./MemoryNotes.js";
import type { AddDiaryInput } from "./DiarySystem.js";
import type { QueryOptions } from "./MemoryRetriever.js";
import { MemoryContextBuilder } from "./MemoryContext.js";
import { hydrateNote, hydrateDiary } from "./snapshotPreparation.js";
import { FsDurableStore } from "../persistence/FsDurableStore.js";
import { StartupRecovery } from "../persistence/StartupRecovery.js";
import { ProductionWalStore, type SemanticOperation } from "../persistence/productionOperations.js";
import type { ProductionMutationCommand } from "../persistence/mutationPreparation.js";
import { attachTip, type StateRoot } from "../persistence/stateRoot.js";
import { encodeSnapshotPayload } from "../persistence/snapshotPayload.js";
import { DEFAULT_MAX_INDEX_BYTES } from "../persistence/recoveryMutationIndex.js";
import { nodeDirectoryIO, type DirectoryIO } from "../persistence/directoryIO.js";
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
  addMemory(input: AddNoteInput, mutationId: string): Promise<Result<MemoryNote>>;
  updateMemory(id: string, patch: UpdateNoteInput, mutationId: string): Promise<Result<MemoryNote>>;
  promoteCandidate(id: string, mutationId: string): Promise<Result<MemoryNote>>;
  deleteMemory(id: string, mutationId: string): Promise<Result<void>>;
  addDiaryEntry(input: AddDiaryInput, mutationId: string): Promise<Result<DiaryEntry>>;
  updateDiary(id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>, mutationId: string): Promise<Result<DiaryEntry>>;
  deleteDiary(id: string, mutationId: string): Promise<Result<void>>;
  addGraphEdge(id: string, source: string, target: string, relationship: string,
    data: Record<string, unknown>, mutationId: string): Promise<Result<MindGraphEdge>>;
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
}

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
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

  constructor(directory: string, userId: string, io: DirectoryIO, files: WalIO, indexDiskBytes: number) {
    this.#directory = directory;
    this.#userId = userId;
    this.#io = io;
    this.#files = files;
    this.#indexDiskBytes = indexDiskBytes;
    this.#store = new ProductionWalStore(directory, io, files);
  }

  /**
   * Durable factory: inspect/bootstrap -> authoritative recovery -> ready
   * runtime. Nothing escapes before recovery succeeds. The io/files
   * parameters are internal injection points for protocol testing.
   */
  static async open(options: DurableEtherMemoriesOptions, io: DirectoryIO = nodeDirectoryIO,
    files: WalIO = nodeWalIO, indexDiskBytes: number = DEFAULT_MAX_INDEX_BYTES): Promise<Result<DurableEtherMemories>> {
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
    const runtime = new DurableRuntime(options.directory, options.userId, io, files, indexDiskBytes);
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
  private readable(): Result<StateRoot> {
    if (this.#lifecycle === "closed" || !this.#generation) {
      return err("CLOSED", "This durable runtime is closed.");
    }
    return ok(this.#generation);
  }

  queryMemories(text: string, options?: QueryOptions): Result<MemoryNote[]> {
    const generation = this.readable();
    if (!generation.ok) return generation;
    return ok(generation.value.retriever.query(text, options).map(x => cloneValue(x.memory)));
  }

  queryMemoriesDetailed(text: string, options?: QueryOptions): Result<RetrievalMatch[]> {
    const generation = this.readable();
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
    const generation = this.readable();
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
    const generation = this.readable();
    if (!generation.ok) return generation;
    return ok(cloneValue(generation.value.snapshot.identity));
  }

  exportData(): Result<EtherSnapshot> {
    const generation = this.readable();
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

/** Public durable factory: only supported user configuration; no injection points. */
export const openDurableEtherMemories = (options: DurableEtherMemoriesOptions): Promise<Result<DurableEtherMemories>> =>
  DurableRuntime.open(options);

/** Internal test factory with protocol-testing dependency injection; never exported from the package root. */
export const openDurableEtherMemoriesInternal = (options: DurableEtherMemoriesOptions,
  dependencies: DurableDependencies = {}): Promise<Result<DurableEtherMemories>> =>
  DurableRuntime.open(options, dependencies.io ?? nodeDirectoryIO, dependencies.files ?? nodeWalIO,
    dependencies.indexDiskBytes ?? DEFAULT_MAX_INDEX_BYTES);
