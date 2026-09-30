import type { EtherSnapshot } from "../types/index.js";
import type { CommittedTip, MutationId, WalOperation } from "../types/persistence.js";
import { join } from "node:path";
import { STARTER_RELATIONS } from "../core/MindGraph.js";
import { intentDigest, prepareCoreMutation, validatedCommand, type ProductionMutationCommand } from "./mutationPreparation.js";
import { err, ok, type Result } from "../utils/result.js";
import { ETHER_DATA_PROFILE, encodeEtherData, decodeEtherData } from "./etherData.js";
import { referenceFor, validateReference, digestBytes, PayloadObjects, OBJECT_REFERENCE } from "./payloadObjects.js";
import { createReplayRegistry } from "./walOperations.js";
import { canonicalJson, type JsonObject } from "./walJson.js";
import { WAL_LIMITS, encodeWalFrame } from "./wal.js";
import { FsWalStore, type CommitReceipt } from "./FsWalStore.js";
import { withRecoveryAuthority, required, type RecoveryAuthority } from "./recoveryAuthority.js";
import { nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "./walIO.js";
import { decodeStoreHead, PERSISTENCE_LIMITS, verifyCheckpoint } from "./codecs.js";
import { WalFileScan } from "./walFileScan.js";
import { validateStateRoot, type StateRoot } from "./stateRoot.js";
import { snapshotData, hydrateSnapshot } from "./snapshotPayload.js";
import { parseTransactionSequenceId } from "../utils/durablePersistence.js";

export const PRODUCTION_OPERATIONS = ["ether.note.put", "ether.note.remove", "ether.diary.put", "ether.diary.remove",
  "ether.graph-node.put", "ether.graph-node.remove", "ether.graph-edge.put", "ether.graph-edge.remove", "ether.identity.put"] as const;
export type ProductionOperationType = typeof PRODUCTION_OPERATIONS[number];
export interface SemanticOperation { readonly type: ProductionOperationType; readonly version: "1"; readonly payload: unknown }
/** Tranche 6 live-runtime commit outcome: frozen receipt plus the prevalidated candidate generation and the exact committed effect set. */
export interface MutationOutcome {
  readonly receipt: CommitReceipt;
  readonly after?: EtherSnapshot;
  readonly root?: StateRoot;
  readonly effects: readonly SemanticOperation[];
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export function validateSemantic(type: string, payload: unknown): Result<void> {
  if (!PRODUCTION_OPERATIONS.includes(type as ProductionOperationType)) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unknown production operation.");
  if (!record(payload)) return err("INVALID_INPUT", "Semantic operation body must be an object.");
  if (type === "ether.identity.put") return typeof payload.userId === "string" ? ok(undefined) : err("INVALID_INPUT", "Missing identity user.");
  if (typeof payload.id !== "string" || !payload.id) return err("INVALID_INPUT", "Missing semantic object id.");
  if (type.endsWith(".remove") && Object.keys(payload).length !== 1) return err("INVALID_INPUT", "Removal requires only id.");
  return ok(undefined);
}
export function decodeInline(payload: unknown) {
  if (!record(payload) || payload.encoding !== ETHER_DATA_PROFILE) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported inline semantic encoding.");
  if (Object.keys(payload).sort().join(",") !== "data,encoding" || typeof payload.data !== "string"
    || Buffer.byteLength(payload.data) > WAL_LIMITS.payloadBytes) return err("INVALID_INPUT", "Invalid bounded inline envelope.");
  return decodeEtherData(Buffer.from(payload.data, "utf8"));
}
export function validateEnvelope(payload: unknown): Result<void> {
  const result = record(payload) && payload.encoding === OBJECT_REFERENCE ? validateReference(payload) : decodeInline(payload);
  return result.ok ? ok(undefined) : result;
}
/** Postimages capture all policy decisions, generated IDs, links and times before commit. */
export function reduceProduction(state: JsonObject, type: string, payload: unknown): Result<JsonObject> {
  const valid = validateSemantic(type, payload);
  if (!valid.ok) return valid;
  const body = payload as Record<string, any>;
  const current = state as Record<string, any>;
  if (type === "ether.identity.put") return ok({ ...state, identity: body });
  const collection = type.startsWith("ether.note.") ? "memoryNotes" : type.startsWith("ether.diary.") ? "diary"
    : type.startsWith("ether.graph-node.") ? "nodes" : "edges";
  const graph = collection === "nodes" || collection === "edges";
  const items = (graph ? current.graph?.[collection] : current[collection]) as Record<string, any>[];
  if (!Array.isArray(items)) return err("INVALID_INPUT", "Invalid candidate collection.");
  const index = items.findIndex(x => x.id === body.id);
  let next: Record<string, any>[];
  if (type.endsWith(".remove")) {
    if (index < 0) return err("NOT_FOUND", "Replay removal target is absent.");
    next = items.filter(x => x.id !== body.id);
  } else {
    next = [...items];
    if (index < 0) next.push(body); else next[index] = body;
  }
  if (!graph) {
    // Generic effect applicator only. The reducer never reconstructs Core
    // mutation policy (FoundationLinker decisions, generated IDs, conflict
    // resolution): preparation executes the real Core mutation once on
    // detached state and WALs the exact captured effect set.
    return ok({ ...state, [collection]: next });
  }
  if (collection === "edges") {
    // Same relationship normalization the runtime graph applies on insert.
    next = next.map(e => e.id === body.id ? { ...e, relationship: normalizeGraphRelationship(e.relationship) } : e);
  }
  const nextGraph = { ...current.graph, [collection]: next };
  if (collection === "nodes" && type.endsWith(".remove")) {
    nextGraph.edges = current.graph.edges.filter((e: any) => e.source !== body.id && e.target !== body.id);
  }
  return ok({ ...state, graph: nextGraph });
}

function normalizeGraphRelationship(relationship: string): string {
  return STARTER_RELATIONS.includes(relationship as never) ? relationship : "related_to";
}
export const productionRegistry = required(createReplayRegistry(PRODUCTION_OPERATIONS.map(type => ({
  type, version: "1",
  validate: (payload: JsonObject) => {
    const valid = validateEnvelope(payload);
    if (!valid.ok || payload.encoding === OBJECT_REFERENCE) return valid;
    const semantic = decodeInline(payload);
    return semantic.ok ? validateSemantic(type, semantic.value) : semantic;
  },
  reduce: (state: JsonObject, payload: JsonObject) => {
    const semantic = decodeInline(payload);
    return semantic.ok ? reduceProduction(state, type, semantic.value) : semantic;
  }
}))));

export async function resolveOperation(operation: WalOperation, authority: RecoveryAuthority, objects: PayloadObjects) {
  if (operation.version !== "1" || !PRODUCTION_OPERATIONS.includes(operation.type as ProductionOperationType)) {
    return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported production operation/version.");
  }
  let decoded;
  if (operation.payload.encoding === OBJECT_REFERENCE) {
    const reference = validateReference(operation.payload);
    if (!reference.ok) return reference;
    decoded = decodeEtherData(await objects.read(authority, reference.value));
  } else decoded = decodeInline(operation.payload);
  if (!decoded.ok) return decoded;
  const valid = validateSemantic(operation.type, decoded.value);
  return valid.ok ? decoded : valid;
}

/**
 * Internal semantic transport only; it does not mutate a live Core. Inline is
 * chosen only if the complete frozen transaction fits; otherwise all bodies are
 * referenced. A second encoding verifies input stability without retaining 128
 * large buffers. Reconciliation still belongs to the frozen coordinator.
 */
export class ProductionWalStore {
  private readonly wal: FsWalStore;
  private readonly objects: PayloadObjects;
  private readonly files: WalIO;
  constructor(private readonly directory: string, private readonly io: DirectoryIO = nodeDirectoryIO,
    files: WalIO = nodeWalIO) {
    this.wal = new FsWalStore({ directory, registry: productionRegistry }, io, files);
    this.objects = new PayloadObjects(io, files);
    this.files = files;
  }
  async commit(base: CommittedTip, mutationId: MutationId, input: readonly SemanticOperation[]): Promise<Result<CommitReceipt>> {
    return this.commitOperations(base, mutationId, input);
  }

  /**
   * High-level durable mutation flow (process-restart-safe idempotency):
   * stable mutationId + stable command intent
   *   -> authoritative active-WAL committed-mutation lookup FIRST
   *   -> if already committed with the same intent digest: return that receipt
   *      (no re-preparation, no new random IDs, no new objects)
   *   -> different intent digest under the same mutationId: fail closed
   *   -> only if definitely absent: detached Core execution, exact effect
   *      capture, durable object preparation, WAL commit bound to the stable
   *      intent digest.
   */
  async commitMutation(base: CommittedTip, baseSnapshot: EtherSnapshot, mutationId: MutationId,
    command: ProductionMutationCommand): Promise<Result<CommitReceipt>> {
    // Accessor-safe validation and canonical copy FIRST; every later step
    // (digest, receipt lookup, preparation) consumes this copy, never the
    // caller's original object.
    const validated = validatedCommand(command);
    if (!validated.ok) return validated;
    const stableCommand = validated.value;
    const intent = intentDigest(stableCommand);
    if (!intent.ok) return intent;
    const found = await this.wal.readCommittedMutation(mutationId);
    if (!found.ok) return found;
    if (found.value) {
      if (found.value.mutation.digest !== intent.value) {
        return err("PERSISTENCE_CORRUPTION", "Incompatible mutation identity reuse.");
      }
      return ok(found.value);
    }
    const prepared = prepareCoreMutation(baseSnapshot, stableCommand);
    if (!prepared.ok) return prepared;
    return this.commitOperations(base, mutationId, prepared.value.operations, intent.value);
  }

  /**
   * Tranche 6 live-runtime commit outcome. Identical durable flow to
   * commitMutation, plus the prevalidated candidate generation and the exact
   * committed effect set so the caller can publish and reconstruct results
   * without a second execution. For an already-committed receipt the effects
   * are resolved from the active WAL (see resolveCommittedEffects); `after`
   * and `root` are absent there by construction.
   */
  async commitMutationDetailed(base: CommittedTip, baseSnapshot: EtherSnapshot, mutationId: MutationId,
    command: ProductionMutationCommand): Promise<Result<MutationOutcome>> {
    // Command validation, intent digesting, detached preparation and complete
    // post-state validation are all pure precommit phases: nothing durable has
    // happened, so any failure there (including deterministic resource-bound
    // hits) is an unambiguous precommit rejection, never an ambiguous outcome.
    const precommit = <T>(result: Result<T>): Result<T> => {
      if (result.ok) return result;
      const details = record(result.error.details) ? result.error.details : {};
      return err(result.error.code, result.error.message, { ...details, phase: "precommit-validation" });
    };
    const validated = precommit(validatedCommand(command));
    if (!validated.ok) return validated;
    const stableCommand = validated.value;
    const intent = precommit(intentDigest(stableCommand));
    if (!intent.ok) return intent;
    const found = await this.wal.readCommittedMutation(mutationId);
    if (!found.ok) return found;
    if (found.value) {
      if (found.value.mutation.digest !== intent.value) {
        return err("PERSISTENCE_CORRUPTION", "Incompatible mutation identity reuse.");
      }
      const effects = await this.resolveCommittedEffects(mutationId);
      if (!effects.ok) return effects;
      return ok({ receipt: found.value, effects: effects.value });
    }
    const prepared = precommit(prepareCoreMutation(baseSnapshot, stableCommand));
    if (!prepared.ok) return prepared;
    // RED 1 precommit complete-post-state validation: no transaction may
    // become durable if its complete deterministic post-state cannot be
    // reconstructed and published by startup recovery. The same single
    // construction path used by recovery and live publication validates the
    // prospective post-state BEFORE payload-object durability or WAL
    // authority can advance. Individual WAL-operation validity is not
    // sufficient; nothing has been written at this point.
    const prospective = precommit(validateStateRoot(prepared.value.after));
    if (!prospective.ok) return prospective;
    const committed = await this.commitOperations(base, mutationId, prepared.value.operations, intent.value);
    if (!committed.ok) {
      // RED 3 race-boundary reconciliation: the pre-preparation lookup can
      // race with another writer committing the same mutation identity. When
      // the final commit observes changed durable history, reconcile the
      // mutation identity again before classifying corruption: the same
      // stable intent under this identity is the existing committed logical
      // mutation, not corruption; a conflicting intent is; a still-absent
      // identity is a genuine stale-base/contention result.
      if (committed.error.code === "PERSISTENCE_CORRUPTION") {
        const relooked = await this.wal.readCommittedMutation(mutationId);
        if (!relooked.ok) return relooked;
        if (relooked.value) {
          if (relooked.value.mutation.digest !== intent.value) {
            return err("PERSISTENCE_CORRUPTION", "Incompatible mutation identity reuse.");
          }
          const effects = await this.resolveCommittedEffects(mutationId);
          if (!effects.ok) return effects;
          return ok({ receipt: relooked.value, effects: effects.value });
        }
      }
      return committed;
    }
    return ok({ receipt: committed.value, after: prepared.value.after, root: prospective.value, effects: prepared.value.operations });
  }

  /**
   * Resolve the exact committed effect set of an already-committed mutation
   * from the active WAL of the HEAD lineage (Tranche 6 result
   * reconstruction). Bounded single pass under writer authority; inline and
   * object-referenced bodies resolve through the same production decode path
   * recovery uses. No Core re-execution, no regenerated IDs/timestamps. RAM
   * stays bounded: only the matching transaction's effects are retained.
   */
  async resolveCommittedEffects(mutationId: MutationId): Promise<Result<readonly SemanticOperation[]>> {
    return withRecoveryAuthority(this.directory, this.io, async authority => {
      const headBytes = Buffer.from(await this.io.readBounded(join(authority.directory, "HEAD"), PERSISTENCE_LIMITS.headBytes));
      const head = required(decodeStoreHead(headBytes));
      const checkpoint = await this.io.readBounded(join(authority.directory, "checkpoints", `checkpoint-${head.checkpoint.checkpointId}.bin`),
        PERSISTENCE_LIMITS.checkpointHeaderBytes + 1 + PERSISTENCE_LIMITS.checkpointPayloadBytes);
      required(verifyCheckpoint(checkpoint, head));
      const path = join(authority.directory, "wal", `wal-${head.checkpoint.digest}.bin`);
      const kind = await this.io.kind(path);
      if (kind === "directory") return err("RECOVERY_REQUIRED", "Unsafe WAL path.");
      if (kind !== "file") return err("PERSISTENCE_CORRUPTION", "Committed mutation effects absent from the active WAL.");
      let handle: WalFileHandle | undefined;
      const effects: SemanticOperation[] = [];
      let seen: string | undefined;
      try {
        handle = await this.files.open(path, false);
        const scan = required(await WalFileScan.open(path, handle, head, productionRegistry, this.files,
          { mode: "authority-held", verifyAuthority: authority.verify }));
        let cursor = scan.cursor();
        do {
          const batch = required(await scan.next(cursor));
          cursor = batch.continuation;
          for (const tx of batch.transactions) {
            if (tx.mutation.mutationId !== mutationId) continue;
            if (seen !== undefined && tx.identity.txId !== seen) {
              return err("PERSISTENCE_CORRUPTION", "Mutation identity reused by distinct committed transactions.");
            }
            seen = tx.identity.txId;
            for (const operation of tx.operations) {
              const semantic = required(await resolveOperation(operation, authority, this.objects));
              effects.push({ type: operation.type as ProductionOperationType, version: "1", payload: semantic });
            }
          }
        } while (!cursor.ended);
      } finally {
        if (handle) await handle.close();
      }
      if (seen === undefined || effects.length === 0) {
        return err("PERSISTENCE_CORRUPTION", "Committed mutation effects absent from the active WAL.");
      }
      return ok(effects);
    });
  }

  private async commitOperations(base: CommittedTip, mutationId: MutationId, input: readonly SemanticOperation[],
    mutationDigest?: string): Promise<Result<CommitReceipt>> {
    if (!base || !parseTransactionSequenceId(base.txId).ok) return err("INVALID_INPUT", "Invalid exact transaction base.");
    if (!input.length || input.length > WAL_LIMITS.operations) return err("INVALID_INPUT", "Invalid production operation count.");
    const capturedBase = { ...base };
    const captured = input.map(op => ({ ...op }));
    const references: WalOperation[] = [], inline: WalOperation[] = [];
    let inlinePossible = true, inlineBytes = 0;
    for (const op of captured) {
      if (op.version !== "1") return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported production operation version.");
      const valid = validateSemantic(op.type, op.payload); if (!valid.ok) return valid;
      const encoded = encodeEtherData(op.payload); if (!encoded.ok) return encoded;
      references.push({ type: op.type, version: op.version, payload: referenceFor(encoded.value) });
      if (inlinePossible) {
        const envelope = { encoding: ETHER_DATA_PROFILE, data: Buffer.from(encoded.value).toString("utf8") };
        const size = canonicalJson(envelope, { bytes: WAL_LIMITS.payloadBytes, depth: WAL_LIMITS.metadataDepth, nodes: WAL_LIMITS.jsonNodes });
        if (!size.ok || (inlineBytes += size.value.byteLength) > WAL_LIMITS.aggregatePayloadBytes) {
          inlinePossible = false; inline.length = 0;
        } else inline.push({ type: op.type, version: op.version, payload: envelope });
      }
    }
    // This new production operation convention binds semantic bytes, not transport choice.
    const intent = encodeEtherData(references);
    if (!intent.ok) return intent;
    // The mutation digest represents the caller's STABLE input at this API
    // boundary (pre-preparation command intent via commitMutation, or the
    // exact stable operation set via commit); the transaction digest continues
    // to bind the exact prepared effects.
    const mutation = { mutationId, digest: mutationDigest ?? digestBytes(intent.value) };
    const check = (operations: readonly WalOperation[]) => encodeWalFrame({
      storeId: "preparation", format: { format: "ether.wal", version: "1" },
      expectedBase: capturedBase, identity: { epochId: capturedBase.epochId, txId: (BigInt(capturedBase.txId) + 1n).toString() as CommittedTip["txId"] },
      mutation, operations, audit: null
    }, productionRegistry);
    const operations = inlinePossible && check(inline).ok ? inline : references;
    const valid = check(operations); if (!valid.ok) return valid;
    if (operations === references) {
      const installed = await withRecoveryAuthority(this.directory, this.io, async authority => {
        for (let i = 0; i < captured.length; i++) {
          const bytes = encodeEtherData(captured[i]!.payload);
          if (!bytes.ok) return bytes;
          if (digestBytes(bytes.value) !== references[i]!.payload.digest) return err("INVALID_INPUT", "Semantic input changed during preparation.");
          await this.objects.install(authority, bytes.value);
        }
        return ok(undefined);
      });
      if (!installed.ok) return installed;
    }
    return this.wal.commit({ expectedBase: capturedBase, mutation, operations });
  }
}

export function validateCandidate(state: JsonObject, userId: string): Result<EtherSnapshot> {
  const snapshot = hydrateSnapshot(state, userId);
  if (!snapshot.ok) return snapshot;
  const canonical = snapshotData(snapshot.value);
  return canonical.ok ? snapshot : canonical;
}
