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
import { cloneValue } from "../utils/clone.js";
import { preparePortableImport, type PortableImportInput, type PortableImportLimits } from "../adapters/portableImport.js";
import type { PortableImportReceipt } from "../types/index.js";
import { prepareSnapshot, commitSnapshot } from "./snapshotPreparation.js";
import type { MemoryExplanation, MemoryHealthReport, MemoryInspectionOptions } from "../types/index.js";
import { explainMemory, inspectMemoryHealth } from "./memoryInspection.js";
import type { DreamSelector, DreamCyclePreviewOptions, DreamPlan } from "../types/dreamPlan.js";
import { previewDreamCycle } from "./dreamPlan.js";
import type { DreamCycleResult } from "../types/dreamAnalysis.js";
import { runDreamCycle } from "./dreamExecution.js";

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
      preferences: cloneValue(options.preferences ?? {})
    };
    this.retriever = new MemoryRetriever(
      () => this.notes.valuesUnsafe(),
      () => this.diary.valuesUnsafe(),
      this.graph,
      () => this.notes.revision,
      () => this.diary.revision
    );
    this.linker = new FoundationLinker(this.graph);
    this.condensation = new CondensationEngine(input => {
      const result = this.addMemory(input);
      return result.ok ? result.value : undefined;
    });
    if (options.storagePath && options.storage) throw new TypeError("storage and storagePath are mutually exclusive.");
    this.storage = options.storage ?? (options.storagePath ? new FsJsonStorage(options.storagePath) : undefined);
  }

  touch(): void { this.identity.lastActive = new Date(); }

  explainMemory(id: string, options?: MemoryInspectionOptions): Result<MemoryExplanation> {
    return explainMemory(this.notes, this.graph, id, options);
  }

  inspectMemoryHealth(options?: MemoryInspectionOptions): Result<MemoryHealthReport> {
    return inspectMemoryHealth(this.notes, this.graph, options);
  }

  previewDreamCycle(selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> {
    return previewDreamCycle(this.notes, this.graph, selector, options);
  }

  runDreamCycle(plan: DreamPlan): Result<DreamCycleResult> {
    return runDreamCycle(this.notes, this.graph, plan);
  }

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

  promoteCandidate(id: string): Result<MemoryNote> {
    const result = this.notes.promoteCandidate(id);
    if (result.ok) { this.linker.linkNote(result.value); this.touch(); }
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
    return ok(this.retriever.query(text, options).map(x => ({
      ...x,
      memory: cloneNote(x.memory),
      matchedBy: [...x.matchedBy],
      evidence: cloneRetrievalEvidence(x.evidence),
      graphEvidence: x.graphEvidence ? { ...x.graphEvidence, path: x.graphEvidence.path.map(p => ({ ...p })) } : undefined
    })));
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

  async importPortableRecords(input: PortableImportInput, limits?: Partial<PortableImportLimits>): Promise<PortableImportReceipt> {
      const prepared = await preparePortableImport(
        input,
        new Set(this.notes.valuesUnsafe().map(note => note.id)),
        new Set(this.diary.valuesUnsafe().map(entry => entry.id)),
        limits
      );
      if (prepared.receipt.issues.some(issue => issue.blocking)) return prepared.receipt;
      this.notes.replaceAll([...this.notes.valuesUnsafe(), ...prepared.notes]);
      this.diary.replaceAll([...this.diary.valuesUnsafe(), ...prepared.diary]);
      for (const note of prepared.notes) this.linker.linkNote(note);
      for (const entry of prepared.diary) this.linker.linkDiary(entry);
      return prepared.receipt;
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
const cloneIdentity = (i: UserIdentity): UserIdentity => ({
  ...i,
  createdAt: new Date(i.createdAt),
  lastActive: new Date(i.lastActive),
  preferences: cloneValue(i.preferences)
});
const cloneNote = (n: MemoryNote): MemoryNote => ({ ...n, tags: [...n.tags], provenance: cloneValue(n.provenance), metadata: cloneValue(n.metadata), createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt), expiresAt: n.expiresAt ? new Date(n.expiresAt) : undefined });
const cloneDiary = (d: DiaryEntry): DiaryEntry => ({ ...d, tags: [...d.tags], metadata: cloneValue(d.metadata), createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt) });
const cloneRetrievalEvidence = (e: import("../types/index.js").RetrievalEvidence): import("../types/index.js").RetrievalEvidence => ({
  ...e,
  matchedTokens: [...e.matchedTokens],
  tags: [...e.tags],
  metadataFields: [...e.metadataFields],
  graph: e.graph ? { ...e.graph, edgeIds: [...e.graph.edgeIds], path: e.graph.path.map(step => ({ ...step })) } : undefined,
  contributions: { ...e.contributions }
});

export type EtherMemories = EtherMemoriesCore;
