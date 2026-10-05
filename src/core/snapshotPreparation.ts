/**
 * Internal snapshot preparation module.
 * This is NOT part of the public API.
 */

import type { UserIdentity, EtherSnapshot, MemoryNote, DiaryEntry, MindGraphNode, MindGraphEdge } from "../types/index.js";
import { err, ok, type Result } from "../utils/result.js";
import { STORE_SCHEMA_VERSION } from "../version.js";
import { cloneValue } from "../utils/clone.js";

const isRecord = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const hydrateTimestamp = (value: unknown): Date => {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "number") return new Date(value);
  return new Date(String(value));
};

export const hydrateNote = (n: any): MemoryNote => ({
  ...n,
  tags: Array.isArray(n.tags) ? n.tags : [],
  provenance: n.provenance ?? {
    kind: n.source === "diary" ? "diary_extract" : n.source === "imported" ? "imported" : "user_explicit"
  },
  status: n.status ?? "active",
  importance: typeof n.importance === "number" ? n.importance : 0.5,
  confidence: typeof n.confidence === "number" ? n.confidence : 0.75,
  pinned: !!n.pinned,
  metadata: isRecord(n.metadata) ? n.metadata : {},
  createdAt: hydrateTimestamp(n.createdAt),
  updatedAt: hydrateTimestamp(n.updatedAt),
  expiresAt: n.expiresAt ? hydrateTimestamp(n.expiresAt) : undefined
});

export const hydrateDiary = (d: any): DiaryEntry => ({
  ...d,
  tags: Array.isArray(d.tags) ? d.tags : [],
  metadata: isRecord(d.metadata) ? d.metadata : {},
  createdAt: hydrateTimestamp(d.createdAt),
  updatedAt: hydrateTimestamp(d.updatedAt)
});

type PreparedSnapshot = { identity: UserIdentity; notes: MemoryNote[]; diary: DiaryEntry[]; nodes: MindGraphNode[]; edges: MindGraphEdge[] };
const validDate = (v: unknown): Date | undefined => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v);
  if (typeof v === "number" && Number.isFinite(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
  if (typeof v === "string") { const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
  return undefined;
};

/**
 * Internal snapshot preparation function.
 * DO NOT export this from the package root.
 */
export const prepareSnapshot = (raw: unknown, userId: string): Result<PreparedSnapshot> => {
  if (!isRecord(raw)) return err("INVALID_INPUT", "Invalid Ether Memories snapshot.");
  if (raw.schemaVersion !== STORE_SCHEMA_VERSION) return err(typeof raw.schemaVersion === "string" ? "UNSUPPORTED_SCHEMA" : "INVALID_INPUT", `Unsupported snapshot schema: ${String(raw.schemaVersion)}.`);
  if (!isRecord(raw.identity) || !Array.isArray(raw.memoryNotes) || !Array.isArray(raw.diary)) return err("INVALID_INPUT", "Invalid Ether Memories snapshot.");
  if (raw.identity.userId !== userId) return err("USER_ID_MISMATCH", `Snapshot belongs to ${String(raw.identity.userId)}, not ${userId}.`);
  const createdAt = validDate(raw.identity.createdAt), lastActive = validDate(raw.identity.lastActive);
  if (!createdAt || !lastActive) return err("INVALID_INPUT", "Invalid identity timestamps.");
  const ids = (items: unknown[], label: string): Result<void> => {
    const seen = new Set<string>();
    for (const item of items) { if (!isRecord(item) || typeof item.id !== "string" || !item.id || seen.has(item.id)) return err("INVALID_INPUT", `Invalid or duplicate ${label} id.`); seen.add(item.id); }
    return ok(undefined);
  };
  const nids = ids(raw.memoryNotes, "Note"); if (!nids.ok) return nids;
  const dids = ids(raw.diary, "Diary"); if (!dids.ok) return dids;
  if (raw.graph !== undefined && !isRecord(raw.graph)) return err("INVALID_INPUT", "Invalid graph snapshot.");
  if (raw.graph !== undefined && (!Array.isArray(raw.graph.nodes) || !Array.isArray(raw.graph.edges))) return err("INVALID_INPUT", "Graph nodes and edges must be arrays.");
  const graph = isRecord(raw.graph) ? raw.graph : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [], edges = Array.isArray(graph.edges) ? graph.edges : [];
  const gids = ids(nodes, "graph node"); if (!gids.ok) return gids;
  const eids = ids(edges, "graph edge"); if (!eids.ok) return eids;
  const nodeIds = new Set(nodes.map((x: any) => x.id));
  const notes: MemoryNote[] = [];
  for (const n of raw.memoryNotes) {
    if (!isRecord(n) || typeof n.content !== "string") return err("INVALID_INPUT", "Invalid note fields.");
    if (n.tags !== undefined && (!Array.isArray(n.tags) || n.tags.some(x => typeof x !== "string"))) return err("INVALID_INPUT", "Invalid note tags.");
    if (n.source !== undefined && !["user", "conversation", "diary", "ai", "imported", "system"].includes(String(n.source))) return err("INVALID_INPUT", "Invalid note source.");
    if (n.status !== undefined && !["candidate", "active", "archived", "rejected"].includes(String(n.status))) return err("INVALID_INPUT", "Invalid note status.");
    if (n.importance !== undefined && (typeof n.importance !== "number" || !Number.isFinite(n.importance) || n.importance < 0 || n.importance > 1)) return err("INVALID_INPUT", "Invalid note importance.");
    if (n.confidence !== undefined && (typeof n.confidence !== "number" || !Number.isFinite(n.confidence) || n.confidence < 0 || n.confidence > 1)) return err("INVALID_INPUT", "Invalid note confidence.");
    if (n.metadata !== undefined && !isRecord(n.metadata)) return err("INVALID_INPUT", "Invalid note metadata.");
    if (n.provenance !== undefined && !isRecord(n.provenance)) return err("INVALID_INPUT", "Invalid note provenance.");
    const c = validDate(n.createdAt), u = validDate(n.updatedAt); if (!c || !u) return err("INVALID_INPUT", "Invalid note date.");
    const ex = n.expiresAt == null ? undefined : validDate(n.expiresAt); if (n.expiresAt != null && !ex) return err("INVALID_INPUT", "Invalid note expiry date.");
    notes.push(hydrateNote({ ...n, createdAt: c, updatedAt: u, expiresAt: ex }));
  }
  const diary: DiaryEntry[] = [];
  for (const d of raw.diary) {
    if (!isRecord(d) || typeof d.content !== "string") return err("INVALID_INPUT", "Invalid diary fields.");
    if (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.some(x => typeof x !== "string"))) return err("INVALID_INPUT", "Invalid diary tags.");
    if (d.metadata !== undefined && !isRecord(d.metadata)) return err("INVALID_INPUT", "Invalid diary metadata.");
    const c = validDate(d.createdAt), u = validDate(d.updatedAt); if (!c || !u) return err("INVALID_INPUT", "Invalid diary date.");
    diary.push(hydrateDiary({ ...d, createdAt: c, updatedAt: u }));
  }
  const cleanNodes: MindGraphNode[] = [];
  for (const n of nodes) { if (!isRecord(n) || typeof n.id !== "string" || typeof n.type !== "string" || !isRecord(n.data)) return err("INVALID_INPUT", "Invalid graph node."); cleanNodes.push({ id: n.id, type: n.type, label: typeof n.label === "string" ? n.label : undefined, data: { ...n.data } }); }
  const cleanEdges: MindGraphEdge[] = [];
  const endpoints = new Set<string>();
  for (const e of edges) {
    if (!isRecord(e) || typeof e.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string" ||
      !nodeIds.has(e.source) || !nodeIds.has(e.target) || (e.data !== undefined && !isRecord(e.data))) return err("INVALID_INPUT", "Invalid graph edge endpoint.");
    const endpoint = `${e.source}\u0000${e.target}`;
    if (endpoints.has(endpoint)) return err("INVALID_INPUT", "Duplicate directed graph edge endpoints.");
    endpoints.add(endpoint);
    cleanEdges.push({ id: e.id, source: e.source, target: e.target, relationship: typeof e.relationship === "string" ? e.relationship : "related_to", data: isRecord(e.data) ? { ...e.data } : {} });
  }
  return ok({ identity: { userId, displayName: typeof raw.identity.displayName === "string" ? raw.identity.displayName : undefined, createdAt, lastActive,   preferences: isRecord(raw.identity.preferences) ? cloneValue(raw.identity.preferences) : {} }, notes, diary, nodes: cleanNodes, edges: cleanEdges });
};

export const commitSnapshot = (core: any, prepared: PreparedSnapshot): void => {
  core.notes.replaceAll(prepared.notes); core.diary.replaceAll(prepared.diary); core.graph.clear();
  for (const n of prepared.nodes) core.graph.addNode(n);
  for (const e of prepared.edges) { const r = core.graph.addEdgeWithId(e.id, e.source, e.target, e.relationship, e.data); if (!r.ok) throw new Error(r.error.message); }
  core.identity.createdAt = new Date(prepared.identity.createdAt); core.identity.lastActive = new Date(prepared.identity.lastActive); core.identity.displayName = prepared.identity.displayName;   core.identity.preferences = cloneValue(prepared.identity.preferences);
};
