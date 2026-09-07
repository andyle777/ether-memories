import type {
  BuildMemoryContextInput, DiaryEntry, EtherSnapshot, MemoryContext, MemoryNote,
  UserIdentity, MindGraphNode, MindGraphEdge
} from "../types/index.js";
import { err, ok, type Result } from "../utils/result.js";
import { FsJsonStorage } from "../utils/persistence.js";
import { MemoryNotes, type AddNoteInput } from "./MemoryNotes.js";
import { DiarySystem, type AddDiaryInput } from "./DiarySystem.js";
import { MindGraphManager } from "./MindGraph.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { FoundationLinker } from "./FoundationLinker.js";
import { CondensationEngine } from "./CondensationEngine.js";
import { MemoryContextBuilder } from "./MemoryContext.js";
import type { StoragePort } from "../types/index.js";
import { LIBRARY_VERSION, STORE_SCHEMA_VERSION } from "../version.js";

type EtherMemoriesBaseOptions = {
  userId: string;
  displayName?: string;
  preferences?: Record<string, unknown>;
};
export type EtherMemoriesOptions = EtherMemoriesBaseOptions & (
  | { storage?: StoragePort; storagePath?: never }
  | { storagePath: string; storage?: never }
  | { storage?: never; storagePath?: never }
);

export class EtherMemoriesCore {
  readonly notes = new MemoryNotes();
  readonly diary = new DiarySystem();
  readonly graph = new MindGraphManager();
  readonly identity: UserIdentity;
  readonly retriever: MemoryRetriever;
  readonly linker: FoundationLinker;
  readonly condensation: CondensationEngine;
  readonly storage?: StoragePort;

  constructor(private readonly options: EtherMemoriesOptions) {
    this.identity = {
      userId: options.userId,
      displayName: options.displayName,
      createdAt: new Date(),
      lastActive: new Date(),
      preferences: { ...(options.preferences ?? {}) }
    };
    this.retriever = new MemoryRetriever(() => this.notes.valuesUnsafe(), () => this.diary.valuesUnsafe(), this.graph);
    this.linker = new FoundationLinker(this.graph);
    this.condensation = new CondensationEngine(input => {
      const result = this.addMemory(input);
      return result.ok ? result.value : undefined;
    });
    if (options.storagePath && options.storage) throw new TypeError("storage and storagePath are mutually exclusive.");
    this.storage = options.storage ?? (options.storagePath ? new FsJsonStorage(options.storagePath) : undefined);
  }

  touch(): void { this.identity.lastActive = new Date(); }

  addMemory(input: AddNoteInput): Result<MemoryNote> {
    const result = this.notes.add(input);
    if (result.ok) { this.linker.linkNote(result.value); this.touch(); }
    return result;
  }

  addDiaryEntry(input: AddDiaryInput): Result<DiaryEntry> {
    const result = this.diary.add(input);
    if (result.ok) { this.linker.linkDiary(result.value); this.touch(); }
    return result;
  }

  updateMemory(id: string, patch: Parameters<MemoryNotes["update"]>[1]): Result<MemoryNote> {
    const result = this.notes.update(id, patch);
    if (result.ok) { this.linker.linkNote(result.value); this.touch(); }
    return result;
  }

  deleteMemory(id: string): Result<void> {
    const result = this.notes.delete(id);
    if (result.ok) { this.linker.removeNote(id); this.touch(); }
    return result;
  }

  purgeExpired(forcePinned = false): number {
    const now = Date.now();
    const ids = this.notes.valuesUnsafe()
      .filter(note => note.expiresAt && note.expiresAt.getTime() <= now && (!note.pinned || forcePinned))
      .map(note => note.id);
    for (const id of ids) this.deleteMemory(id);
    return ids.length;
  }

  updateDiary(id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>): Result<DiaryEntry> {
    const result = this.diary.update(id, patch);
    if (result.ok) { this.linker.linkDiary(result.value); this.touch(); }
    return result;
  }

  deleteDiary(id: string): Result<void> {
    const result = this.diary.delete(id);
    if (result.ok) { this.linker.removeDiary(id); this.touch(); }
    return result;
  }

  queryMemories(text: string, options?: Parameters<MemoryRetriever["query"]>[1]): Result<MemoryNote[]> {
    return ok(this.retriever.query(text, options).map(x => cloneNote(x.memory)));
  }

  queryMemoriesDetailed(text: string, options?: Parameters<MemoryRetriever["query"]>[1]) {
    return ok(this.retriever.query(text, options).map(x => ({ ...x, memory: cloneNote(x.memory), graphEvidence: x.graphEvidence ? { ...x.graphEvidence, path: x.graphEvidence.path.map(p => ({ ...p })) } : undefined })));
  }

  buildMemoryContext(input: BuildMemoryContextInput): Result<MemoryContext> {
    try {
      return ok(new MemoryContextBuilder(
        LIBRARY_VERSION, this.identity.userId, this.identity.displayName,
        this.retriever, this.graph, () => this.notes.valuesUnsafe(), () => this.diary.valuesUnsafe()
      ).build(input));
    } catch (e) {
      return err("INVALID_INPUT", e instanceof Error ? e.message : "Unable to build memory context.");
    }
  }

  getSystemState(): UserIdentity { return cloneIdentity(this.identity); }

  exportData(): EtherSnapshot {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      identity: cloneIdentity(this.identity),
      memoryNotes: this.notes.valuesUnsafe().map(cloneNote),
      diary: this.diary.valuesUnsafe().map(cloneDiary),
      graph: { nodes: this.graph.getAllNodes(), edges: this.graph.getAllEdges() }
    };
  }

  async save(): Promise<Result<void>> {
    if (!this.storage) return err("STORAGE_ERROR", "No storagePath configured.");
    try { await this.storage.save(this.exportData()); return ok(undefined); }
    catch (e) { return err("STORAGE_ERROR", e instanceof Error ? e.message : "Save failed."); }
  }

  async load(): Promise<Result<void>> {
    if (!this.storage) return err("STORAGE_ERROR", "No storagePath configured.");
    try {
      const raw = await this.storage.load();
      return this.importData(raw);
    } catch (e) {
      return err("STORAGE_ERROR", e instanceof Error ? e.message : "Load failed.");
    }
  }

  importData(raw: unknown): Result<void> {
    const prepared = prepareSnapshot(raw, this.identity.userId);
    if (!prepared.ok) return prepared;
    const before = this.exportData();
    try { commitSnapshot(this, prepared.value); return ok(undefined); }
    catch (e) {
      try {
        const rollback = prepareSnapshot(before, this.identity.userId);
        if (rollback.ok) commitSnapshot(this, rollback.value);
      } catch { /* best effort rollback */ }
      return err("INVALID_INPUT", e instanceof Error ? e.message : "Snapshot commit failed.");
    }
  }
}

const isRecord = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

const hydrateNote = (n: any): MemoryNote => ({
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
  createdAt: new Date(String(n.createdAt)),
  updatedAt: new Date(String(n.updatedAt)),
  expiresAt: n.expiresAt ? new Date(String(n.expiresAt)) : undefined
});

const hydrateDiary = (d: any): DiaryEntry => ({
  ...d,
  tags: Array.isArray(d.tags) ? d.tags : [],
  metadata: isRecord(d.metadata) ? d.metadata : {},
  createdAt: new Date(String(d.createdAt)),
  updatedAt: new Date(String(d.updatedAt))
});

type PreparedSnapshot = { identity: UserIdentity; notes: MemoryNote[]; diary: DiaryEntry[]; nodes: MindGraphNode[]; edges: MindGraphEdge[] };
const validDate = (v: unknown): Date | undefined => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v);
  if (typeof v === "number" && Number.isFinite(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
  if (typeof v === "string") { const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
  return undefined;
};
const prepareSnapshot = (raw: unknown, userId: string): Result<PreparedSnapshot> => {
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
    if (!isRecord(n) || typeof n.content !== "string" || !Array.isArray(n.tags) || n.tags.some(x => typeof x !== "string") ||
      (n.source !== undefined && !["user", "conversation", "diary", "ai", "imported", "system"].includes(String(n.source))) ||
      (n.status !== undefined && !["candidate", "active", "archived", "rejected"].includes(String(n.status))) ||
      typeof n.importance !== "number" || !Number.isFinite(n.importance) || n.importance < 0 || n.importance > 1 ||
      typeof n.confidence !== "number" || !Number.isFinite(n.confidence) || n.confidence < 0 || n.confidence > 1 ||
      (n.metadata !== undefined && !isRecord(n.metadata)) || (n.provenance !== undefined && !isRecord(n.provenance))) return err("INVALID_INPUT", "Invalid note fields.");
    const c = validDate(n.createdAt), u = validDate(n.updatedAt); if (!c || !u) return err("INVALID_INPUT", "Invalid note date.");
    const ex = n.expiresAt == null ? undefined : validDate(n.expiresAt); if (n.expiresAt != null && !ex) return err("INVALID_INPUT", "Invalid note expiry date.");
    notes.push(hydrateNote({ ...n, createdAt: c, updatedAt: u, expiresAt: ex }));
  }
  const diary: DiaryEntry[] = [];
  for (const d of raw.diary) { if (!isRecord(d) || typeof d.content !== "string" || !Array.isArray(d.tags) || d.tags.some(x => typeof x !== "string") || (d.metadata !== undefined && !isRecord(d.metadata))) return err("INVALID_INPUT", "Invalid diary fields."); const c = validDate(d.createdAt), u = validDate(d.updatedAt); if (!c || !u) return err("INVALID_INPUT", "Invalid diary date."); diary.push(hydrateDiary({ ...d, createdAt: c, updatedAt: u })); }
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
  return ok({ identity: { userId, displayName: typeof raw.identity.displayName === "string" ? raw.identity.displayName : undefined, createdAt, lastActive, preferences: isRecord(raw.identity.preferences) ? { ...raw.identity.preferences } : {} }, notes, diary, nodes: cleanNodes, edges: cleanEdges });
};
const commitSnapshot = (core: EtherMemoriesCore, prepared: PreparedSnapshot): void => {
  core.notes.replaceAll(prepared.notes); core.diary.replaceAll(prepared.diary); core.graph.clear();
  for (const n of prepared.nodes) core.graph.addNode(n);
  for (const e of prepared.edges) { const r = core.graph.addEdgeWithId(e.id, e.source, e.target, e.relationship, e.data); if (!r.ok) throw new Error(r.error.message); }
  core.identity.createdAt = new Date(prepared.identity.createdAt); core.identity.lastActive = new Date(prepared.identity.lastActive); core.identity.displayName = prepared.identity.displayName; core.identity.preferences = { ...prepared.identity.preferences };
};

const cloneIdentity = (i: UserIdentity): UserIdentity => ({
  ...i,
  createdAt: new Date(i.createdAt),
  lastActive: new Date(i.lastActive),
  preferences: { ...i.preferences }
});
const cloneNote = (n: MemoryNote): MemoryNote => ({ ...n, tags: [...n.tags], provenance: cloneValue(n.provenance), metadata: cloneValue(n.metadata), createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt), expiresAt: n.expiresAt ? new Date(n.expiresAt) : undefined });
const cloneDiary = (d: DiaryEntry): DiaryEntry => ({ ...d, tags: [...d.tags], metadata: cloneValue(d.metadata), createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt) });
const cloneValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cloneValue(v)])) as T;
};

export type EtherMemories = EtherMemoriesCore;
