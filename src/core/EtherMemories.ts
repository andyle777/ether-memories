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

export interface EtherMemoriesOptions {
  userId: string;
  displayName?: string;
  storagePath?: string;
  preferences?: Record<string, unknown>;
}

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
    this.retriever = new MemoryRetriever(() => this.notes.valuesUnsafe(), () => this.diary.valuesUnsafe());
    this.linker = new FoundationLinker(this.graph);
    this.condensation = new CondensationEngine(input => {
      const result = this.addMemory(input);
      return result.ok ? result.value : undefined;
    });
    this.storage = options.storagePath ? new FsJsonStorage(options.storagePath) : undefined;
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
    return ok(this.retriever.query(text, options).map(x => x.memory));
  }

  queryMemoriesDetailed(text: string, options?: Parameters<MemoryRetriever["query"]>[1]) {
    return ok(this.retriever.query(text, options));
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
      memoryNotes: this.notes.valuesUnsafe(),
      diary: this.diary.valuesUnsafe(),
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
    if (!isRecord(raw)) {
      return err("INVALID_INPUT", "Invalid Ether Memories snapshot.");
    }
    if (raw.schemaVersion !== STORE_SCHEMA_VERSION) {
      if (typeof raw.schemaVersion === "string") {
        return err("UNSUPPORTED_SCHEMA", `Unsupported snapshot schema: ${raw.schemaVersion}. Expected ${STORE_SCHEMA_VERSION}.`);
      }
      return err("INVALID_INPUT", "Snapshot schemaVersion is required.");
    }
    if (!Array.isArray(raw.memoryNotes) || !Array.isArray(raw.diary) || !isRecord(raw.identity)) {
      return err("INVALID_INPUT", "Invalid Ether Memories snapshot.");
    }
    const incomingUserId = typeof raw.identity.userId === "string" ? raw.identity.userId : undefined;
    if (!incomingUserId) return err("INVALID_INPUT", "Snapshot identity.userId is required.");
    if (incomingUserId !== this.identity.userId) {
      return err("USER_ID_MISMATCH", `Snapshot belongs to ${incomingUserId}, not ${this.identity.userId}.`);
    }

    const notes: MemoryNote[] = raw.memoryNotes.map((n: any) => hydrateNote(n));
    const diary: DiaryEntry[] = raw.diary.map((d: any) => hydrateDiary(d));
    this.notes.replaceAll(notes);
    this.diary.replaceAll(diary);
    this.graph.clear();
    const graph = isRecord(raw.graph) ? raw.graph : {};
    const nodes = Array.isArray(graph.nodes) ? graph.nodes as MindGraphNode[] : [];
    const edges = Array.isArray(graph.edges) ? graph.edges as MindGraphEdge[] : [];
    for (const node of nodes) this.graph.addNode(node);
    for (const edge of edges) this.graph.addEdge(edge.source, edge.target, edge.relationship, edge.data);
    this.identity.createdAt = new Date(String(raw.identity.createdAt));
    this.identity.lastActive = new Date(String(raw.identity.lastActive));
    this.identity.displayName = typeof raw.identity.displayName === "string" ? raw.identity.displayName : this.identity.displayName;
    this.identity.preferences = isRecord(raw.identity.preferences) ? { ...raw.identity.preferences } : {};
    return ok(undefined);
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

const cloneIdentity = (i: UserIdentity): UserIdentity => ({
  ...i,
  createdAt: new Date(i.createdAt),
  lastActive: new Date(i.lastActive),
  preferences: { ...i.preferences }
});

export type EtherMemories = EtherMemoriesCore;
