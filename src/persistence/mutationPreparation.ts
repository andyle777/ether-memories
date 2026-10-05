/**
 * Deterministic Core mutation preparation (structural detachment + exact capture).
 *
 * canonical committed StateRoot/snapshot
 *   -> construct a fresh ephemeral detached Core internally (no caller Core
 *      reference, no storage, no callbacks, no durable writes)
 *   -> import the base persisted snapshot
 *   -> snapshot the persisted BEFORE state
 *   -> execute the actual existing Core mutation ONCE (all FoundationLinker
 *      policy, generated IDs, conflict resolution and timestamps happen inside
 *      Core, exactly as in live operation)
 *   -> snapshot the persisted AFTER state
 *   -> derive the complete deterministic persisted effect set (notes, diary,
 *      graph nodes, graph edges, identity)
 *   -> WAL that effect set; replay applies the explicit effects only.
 *
 * Isolation is structural: prepareCoreMutation accepts only immutable data
 * (an EtherSnapshot and a plain command object), so no call path can mutate a
 * published canonical Core. The reducer never reconstructs Core policy: if
 * Core retained an existing user edge instead of creating a linker edge, the
 * effect set contains no invented edge.
 *
 * Core may generate values at mutation time (linker edge IDs, note IDs,
 * timestamps). They are generated exactly once, here, and become explicit
 * transaction semantic data. The stable caller intent is the COMMAND; its
 * canonical digest is the mutation intent digest used for durable
 * committed-mutation reconciliation, computed BEFORE any random value exists.
 * The transaction digest continues to bind the exact prepared effects.
 */

import type { DiaryEntry, EtherSnapshot, MemoryNote } from "../types/index.js";
import type { SemanticOperation } from "./productionOperations.js";
import { err, ok, type Result } from "../utils/result.js";
import { EtherMemoriesCore } from "../core/EtherMemories.js";
import type { AddNoteInput, UpdateNoteInput } from "../core/MemoryNotes.js";
import type { AddDiaryInput } from "../core/DiarySystem.js";
import { encodeEtherData, decodeEtherData } from "./etherData.js";
import { digestBytes } from "./payloadObjects.js";

/** Stable, pre-execution caller intent. Contains no Core-generated values. */
export type ProductionMutationCommand =
  | { readonly kind: "note.put"; readonly input: AddNoteInput }
  | { readonly kind: "note.update"; readonly id: string; readonly patch: UpdateNoteInput }
  | { readonly kind: "note.remove"; readonly id: string }
  | { readonly kind: "diary.put"; readonly input: AddDiaryInput }
  | { readonly kind: "diary.update"; readonly id: string; readonly patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">> }
  | { readonly kind: "diary.remove"; readonly id: string }
  | { readonly kind: "graph-edge.put"; readonly id: string; readonly source: string; readonly target: string;
    readonly relationship: string; readonly data: Record<string, unknown> };

export interface PreparedMutation {
  readonly operations: readonly SemanticOperation[];
  /** The detached execution result as plain data; never aliases a live Core. */
  readonly after: EtherSnapshot;
}

/** Canonical persisted projection: Dates become ISO strings, undefined drops. */
function project(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const projected = project((value as Record<string, unknown>)[key]);
      if (projected === undefined) continue;
      // defineProperty keeps dangerous names ("__proto__") as own data
      // properties; assignment would silently set the prototype instead.
      Object.defineProperty(out, key, { value: projected, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  return value;
}

function signature(value: unknown): Result<string> {
  const encoded = encodeEtherData(project(value));
  return encoded.ok ? ok(Buffer.from(encoded.value).toString("utf8")) : encoded;
}

/**
 * Accessor-safe command validation and canonical snapshot.
 *
 * The command must belong to the established production plain-data domain
 * BEFORE it is hashed, prepared or dispatched: encodeEtherData inspects own
 * property descriptors BEFORE any value is read, so getters/setters, symbol
 * keys, sparse arrays, unsupported prototypes, cycles, undefined, NaN and
 * non-finite numbers are all rejected WITHOUT ever invoking user code. The
 * canonical bytes are then decoded into a fresh plain-data copy; that copy —
 * not the caller's original object — is what is digested and executed, so a
 * caller cannot change intent between validation and preparation.
 */
export function canonicalCommandBytes(command: ProductionMutationCommand): Result<Uint8Array> {
  if (!command || typeof command !== "object") return err("INVALID_INPUT", "Invalid mutation command.");
  return encodeEtherData(command);
}

/** The stable, validated plain-data copy of a mutation command. */
export function validatedCommand(command: ProductionMutationCommand): Result<ProductionMutationCommand> {
  const bytes = canonicalCommandBytes(command);
  if (!bytes.ok) return bytes;
  const decoded = decodeEtherData(bytes.value);
  if (!decoded.ok) return decoded;
  const copy = decoded.value as unknown as ProductionMutationCommand;
  if (!copy || typeof copy !== "object" || typeof (copy as { kind?: unknown }).kind !== "string") {
    return err("INVALID_INPUT", "Invalid mutation command.");
  }
  return ok(Object.freeze(copy));
}

export function intentDigest(command: ProductionMutationCommand): Result<string> {
  const bytes = canonicalCommandBytes(command);
  return bytes.ok ? ok(digestBytes(bytes.value)) : bytes;
}

interface Item { readonly id: string }

function diffById<T extends Item>(before: readonly T[], after: readonly T[],
  put: (item: T) => SemanticOperation, remove: (id: string) => SemanticOperation): Result<SemanticOperation[]> {
  const operations: SemanticOperation[] = [];
  const beforeMap = new Map(before.map(item => [item.id, item]));
  const afterMap = new Map(after.map(item => [item.id, item]));
  for (const id of [...beforeMap.keys()].sort()) {
    if (!afterMap.has(id)) operations.push(remove(id));
  }
  for (const id of [...afterMap.keys()].sort()) {
    const item = afterMap.get(id)!;
    const previous = beforeMap.get(id);
    if (previous) {
      const a = signature(previous), b = signature(item);
      if (!a.ok) return a;
      if (!b.ok) return b;
      if (a.value === b.value) continue;
    }
    operations.push(put(item));
  }
  return ok(operations);
}

const notePut = (note: Item): SemanticOperation => ({ type: "ether.note.put", version: "1", payload: project(note) });
const noteRemove = (id: string): SemanticOperation => ({ type: "ether.note.remove", version: "1", payload: { id } });
const diaryPut = (entry: Item): SemanticOperation => ({ type: "ether.diary.put", version: "1", payload: project(entry) });
const diaryRemove = (id: string): SemanticOperation => ({ type: "ether.diary.remove", version: "1", payload: { id } });
const nodePut = (node: Item): SemanticOperation => ({ type: "ether.graph-node.put", version: "1", payload: project(node) });
const nodeRemove = (id: string): SemanticOperation => ({ type: "ether.graph-node.remove", version: "1", payload: { id } });
const edgePut = (edge: Item): SemanticOperation => ({ type: "ether.graph-edge.put", version: "1", payload: project(edge) });
const edgeRemove = (id: string): SemanticOperation => ({ type: "ether.graph-edge.remove", version: "1", payload: { id } });

/** Executes the real Core mutator once on the detached Core. */
function executeCommand(core: EtherMemoriesCore, command: ProductionMutationCommand): Result<unknown> {
  switch (command.kind) {
    case "note.put": return core.addMemory(command.input);
    case "note.update": return core.updateMemory(command.id, command.patch);
    case "note.remove": return core.deleteMemory(command.id);
    case "diary.put": return core.addDiaryEntry(command.input);
    case "diary.update": return core.updateDiary(command.id, command.patch);
    case "diary.remove": return core.deleteDiary(command.id);
    case "graph-edge.put": return core.graph.addEdgeWithId(command.id, command.source, command.target, command.relationship, command.data);
  }
}

type Persisted = { memoryNotes: Item[]; diary: Item[]; identity: unknown; graph: { nodes: Item[]; edges: Item[] } };

/**
 * Detached preparation. The base is immutable snapshot data; the ephemeral
 * Core is constructed internally with no storage and no callbacks, so the
 * caller has no reference capable of mutating any live canonical Core.
 */
export function prepareCoreMutation(base: EtherSnapshot, command: ProductionMutationCommand): Result<PreparedMutation> {
  if (!base || typeof base !== "object") return err("INVALID_INPUT", "Invalid committed base snapshot.");
  // Accessor-safe validation first; preparation consumes the validated
  // plain-data copy, never the caller's original object.
  const validated = validatedCommand(command);
  if (!validated.ok) return validated;
  const stableCommand = validated.value;
  // Fresh ephemeral detached Core: no storagePath/storage, no callbacks.
  const core = new EtherMemoriesCore({ userId: base.identity.userId });
  const imported = core.importData(base);
  if (!imported.ok) return imported;
  const before = project(core.exportData()) as Persisted;
  const outcome = executeCommand(core, stableCommand);
  if (!outcome.ok) return outcome;
  const after = core.exportData();
  const afterPersisted = project(after) as Persisted;
  const notes = diffById(before.memoryNotes, afterPersisted.memoryNotes, notePut, noteRemove);
  if (!notes.ok) return notes;
  const diary = diffById(before.diary, afterPersisted.diary, diaryPut, diaryRemove);
  if (!diary.ok) return diary;
  const edges = diffById(before.graph.edges, afterPersisted.graph.edges, edgePut, edgeRemove);
  if (!edges.ok) return edges;
  const nodes = diffById(before.graph.nodes, afterPersisted.graph.nodes, nodePut, nodeRemove);
  if (!nodes.ok) return nodes;
  // Deterministic order: edge removals, node removals, node puts (so edge
  // endpoints exist), then edge puts. Removes precede puts so a replaced
  // object never conflicts with its own prior state.
  const operations: SemanticOperation[] = [
    ...notes.value,
    ...diary.value,
    ...edges.value.filter(op => op.type === "ether.graph-edge.remove"),
    ...nodes.value.filter(op => op.type === "ether.graph-node.remove"),
    ...nodes.value.filter(op => op.type === "ether.graph-node.put"),
    ...edges.value.filter(op => op.type === "ether.graph-edge.put")
  ];
  const identityBefore = signature(before.identity), identityAfter = signature(afterPersisted.identity);
  if (!identityBefore.ok) return identityBefore;
  if (!identityAfter.ok) return identityAfter;
  if (identityBefore.value !== identityAfter.value) {
    operations.push({ type: "ether.identity.put", version: "1", payload: afterPersisted.identity as Record<string, unknown> });
  }
  if (operations.length === 0) return err("INVALID_INPUT", "Mutation produced no deterministic effects.");
  return ok({ operations, after });
}
