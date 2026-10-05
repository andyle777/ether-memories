import type { EtherSnapshot, GraphRelation, MindGraphEdge } from "../types/index.js";
import type { CommittedTip } from "../types/persistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { MemoryNotes } from "../core/MemoryNotes.js";
import { DiarySystem } from "../core/DiarySystem.js";
import { MindGraphManager, STARTER_RELATIONS } from "../core/MindGraph.js";
import { MemoryRetriever } from "../core/MemoryRetriever.js";
import { encodeSnapshotPayload } from "./snapshotPayload.js";
import { DirectoryIoError } from "./directoryIO.js";
import { required } from "./recoveryAuthority.js";

/**
 * Shared committed-generation construction (Tranche 6).
 *
 * StartupRecovery and the live durable runtime both build their published
 * generation through this single path so recovery publication and live
 * publication cannot drift: one normalized semantic graph feeds the published
 * persisted snapshot, the published read() state and the runtime Graph
 * representation, exactly as frozen in Tranche 5.
 */

/** Normalize graph relationships to ensure consistency between snapshot and Graph module (RED 4A/4B) */
function normalizeEdgeRelationship(relationship: string): GraphRelation {
  return STARTER_RELATIONS.includes(relationship as GraphRelation) ? relationship as GraphRelation : "related_to";
}

/** Normalize snapshot graph edges to use canonical relationships */
/** Internal deterministic graph normalization; idempotent by construction (RED 4). */
export function normalizeSnapshotGraph(snapshot: EtherSnapshot): EtherSnapshot {
  return {
    ...snapshot,
    graph: {
      nodes: [...snapshot.graph.nodes],
      edges: snapshot.graph.edges.map(edge => ({
        ...edge,
        relationship: normalizeEdgeRelationship(edge.relationship)
      }))
    }
  };
}

/** Verify that the normalized snapshot graph matches the Graph module representation (RED 4C) */
export function verifyGraphConsistency(snapshot: EtherSnapshot, graph: MindGraphManager): void {
  // Get all edges from the Graph module
  const graphEdges = graph.getAllEdges();
  const graphNodes = graph.getAllNodes();

  // Compare edge relationships - they should all be normalized
  for (const edge of graphEdges) {
    const normalized = normalizeEdgeRelationship(edge.relationship);
    if (edge.relationship !== normalized) {
      throw new DirectoryIoError("PERSISTENCE_CORRUPTION",
        `Graph edge has non-normalized relationship: ${edge.relationship} should be ${normalized}`);
    }
  }

  // Verify that the snapshot edges, when normalized, match the graph edges
  const snapshotEdges = snapshot.graph.edges;
  for (const edge of snapshotEdges) {
    const normalized = normalizeEdgeRelationship(edge.relationship);
    if (edge.relationship !== normalized) {
      throw new DirectoryIoError("PERSISTENCE_CORRUPTION",
        `Snapshot edge has non-normalized relationship: ${edge.relationship} should be ${normalized}`);
    }
  }
}

export interface StateRoot {
  readonly snapshot: EtherSnapshot;
  readonly bytes: Uint8Array;
  readonly tip: CommittedTip;
  readonly notes: MemoryNotes;
  readonly diary: DiarySystem;
  readonly graph: MindGraphManager;
  readonly retriever: MemoryRetriever;
}

/**
 * Construct one frozen committed generation from a live-shaped snapshot and
 * its exact committed tip. Pure construction only: no I/O, no authority
 * verification, no publication. The caller owns the publication boundary.
 */
export function buildStateRoot(snapshot: EtherSnapshot, tip: CommittedTip): Result<StateRoot> {
  const root = validateStateRoot(snapshot);
  return root.ok ? ok(attachTip(root.value, tip)) : root;
}

/**
 * Provisional tip used only as metadata during precommit validation. Nothing
 * in deterministic state validation depends on the committed tip: the same
 * construction path validates a prospective post-state before any durable
 * commitment and builds the generation recovery publishes afterwards.
 */
const PROVISIONAL_TIP: CommittedTip = { epochId: "", txId: "0" as CommittedTip["txId"], digest: "0".repeat(64) };

/**
 * Full deterministic validation and construction of a candidate generation
 * (RED 1): production canonical snapshot size, StateRoot resource bound,
 * graph normalization/consistency, Notes/Diary reconstruction and
 * committed retrieval-index rebuild — every deterministic condition that
 * could make recovery reject the committed state. Recovery, live publication
 * and precommit validation all use this single construction path. Total:
 * deterministic construction failures surface as Results, never as throws.
 */
export function validateStateRoot(snapshot: EtherSnapshot): Result<StateRoot> {
  try {
    const normalizedSnapshot = normalizeSnapshotGraph(snapshot);
    const bytes = required(encodeSnapshotPayload(normalizedSnapshot));
    const notes = new MemoryNotes(), diary = new DiarySystem(), graph = new MindGraphManager();
    notes.replaceAll(normalizedSnapshot.memoryNotes);
    diary.replaceAll(normalizedSnapshot.diary);
    for (const node of normalizedSnapshot.graph.nodes) required(graph.addNode(node));
    for (const edge of normalizedSnapshot.graph.edges) required(graph.addEdgeWithId(edge.id, edge.source, edge.target, edge.relationship, edge.data));

    // Verify that the normalized snapshot produces the same graph as what we built
    verifyGraphConsistency(normalizedSnapshot, graph);
    const retriever = new MemoryRetriever(() => notes.valuesUnsafe(), () => diary.valuesUnsafe(), graph, () => notes.revision, () => diary.revision);
    retriever.rebuildIndex();
    const root: StateRoot = Object.freeze({ snapshot: normalizedSnapshot, bytes, tip: Object.freeze({ ...PROVISIONAL_TIP }), notes, diary, graph, retriever });
    return ok(root);
  } catch (error) {
    if (error instanceof DirectoryIoError) return err(error.code, error.message, error.details);
    return err("INVALID_INPUT", "Candidate generation validation failed.");
  }
}

/**
 * Attach the final committed tip to a fully validated generation. Metadata
 * only: the snapshot, canonical bytes, modules and rebuilt indexes are the
 * exact prevalidated construction.
 */
export function attachTip(root: StateRoot, tip: CommittedTip): StateRoot {
  return Object.freeze({ ...root, tip: Object.freeze({ ...tip }) });
}

/** Type-only re-export so callers can reference the committed edge shape. */
export type { MindGraphEdge };
