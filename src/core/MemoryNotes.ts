import type { MemoryNote, MemoryStatus } from "../types/index.js";
import { createId } from "../utils/ids.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";

export interface AddNoteInput {
  content: string;
  summary?: string;
  category?: string;
  tags?: string[];
  source?: MemoryNote["source"];
  provenance?: MemoryNote["provenance"];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  status?: MemoryStatus;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface UpdateNoteInput extends Partial<AddNoteInput> {
  allowPinnedEdit?: boolean;
}

export class MemoryNotes {
  private readonly notes = new Map<string, MemoryNote>();

  add(input: AddNoteInput): Result<MemoryNote> {
    if (!input.content?.trim()) return err("INVALID_INPUT", "Memory content cannot be empty.");
    const now = new Date();
    const note: MemoryNote = {
      id: createId("mem"),
      content: input.content.trim(),
      summary: input.summary,
      category: input.category,
      tags: [...(input.tags ?? [])],
      source: input.source ?? "user",
      provenance: cloneValue(input.provenance ?? { kind: "user_explicit", lastEditKind: "user" }),
      importance: clamp(input.importance ?? 0.5),
      confidence: clamp(input.confidence ?? 0.75),
      pinned: input.pinned ?? false,
      status: input.status ?? "active",
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      createdAt: now,
      updatedAt: now,
      metadata: cloneValue(input.metadata ?? {})
    };
    this.notes.set(note.id, note);
    return ok(cloneNote(note));
  }

  get(id: string): Result<MemoryNote> {
    const note = this.notes.get(id);
    return note ? ok(cloneNote(note)) : err("NOT_FOUND", `Memory note not found: ${id}`);
  }

  getAll(options?: { includeExpired?: boolean; includeArchived?: boolean; includeCandidate?: boolean }): MemoryNote[] {
    const now = Date.now();
    return [...this.notes.values()]
      .filter(n => options?.includeExpired || !n.expiresAt || n.expiresAt.getTime() > now)
      .filter(n => options?.includeArchived || n.status !== "archived")
      .filter(n => options?.includeCandidate || n.status !== "candidate")
      .map(cloneNote);
  }

  update(id: string, input: UpdateNoteInput): Result<MemoryNote> {
    const note = this.notes.get(id);
    if (!note) return err("NOT_FOUND", `Memory note not found: ${id}`);
    if (note.pinned && input.content !== undefined && !input.allowPinnedEdit) {
      return err("CONFLICT", "Pinned memory cannot be edited without allowPinnedEdit=true.");
    }
    if (input.content !== undefined && !input.content.trim()) {
      return err("INVALID_INPUT", "Memory content cannot be empty.");
    }
    if (input.content !== undefined) note.content = input.content.trim();
    if (input.summary !== undefined) note.summary = input.summary;
    if (input.category !== undefined) note.category = input.category;
    if (input.tags !== undefined) note.tags = [...input.tags];
    if (input.source !== undefined) note.source = input.source;
    if (input.provenance !== undefined) note.provenance = cloneValue(input.provenance);
    if (input.importance !== undefined) note.importance = clamp(input.importance);
    if (input.confidence !== undefined) note.confidence = clamp(input.confidence);
    if (input.pinned !== undefined) note.pinned = input.pinned;
    if (input.status !== undefined) note.status = input.status;
    if (input.expiresAt !== undefined) note.expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (input.metadata !== undefined) note.metadata = cloneValue(input.metadata);
    note.updatedAt = new Date();
    note.provenance = { ...note.provenance, lastEditKind: "user" };
    return ok(cloneNote(note));
  }

  delete(id: string): Result<void> {
    if (!this.notes.delete(id)) return err("NOT_FOUND", `Memory note not found: ${id}`);
    return ok(undefined);
  }

  promoteCandidate(id: string): Result<MemoryNote> {
    const note = this.notes.get(id);
    if (!note) return err("NOT_FOUND", `Memory note not found: ${id}`);
    note.status = "active";
    note.updatedAt = new Date();
    return ok(cloneNote(note));
  }

  purgeExpired(forcePinned = false): number {
    const now = Date.now();
    let count = 0;
    for (const [id, note] of this.notes) {
      if (note.expiresAt && note.expiresAt.getTime() <= now && (!note.pinned || forcePinned)) {
        this.notes.delete(id);
        count++;
      }
    }
    return count;
  }

  replaceAll(notes: MemoryNote[]): void {
    this.notes.clear();
    for (const note of notes) this.notes.set(note.id, cloneNote(note));
  }

  valuesUnsafe(): MemoryNote[] {
    return [...this.notes.values()].map(cloneNote);
  }
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

const cloneNote = (n: MemoryNote): MemoryNote => ({
  ...n,
  tags: [...n.tags],
  provenance: cloneValue(n.provenance),
  metadata: cloneValue(n.metadata),
  createdAt: new Date(n.createdAt),
  updatedAt: new Date(n.updatedAt),
  expiresAt: n.expiresAt ? new Date(n.expiresAt) : undefined
});
