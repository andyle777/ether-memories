import type { DiaryEntry } from "../types/index.js";
import { createId } from "../utils/ids.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";

export interface AddDiaryInput {
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export class DiarySystem {
  private readonly entries = new Map<string, DiaryEntry>();

  add(input: AddDiaryInput): Result<DiaryEntry> {
    if (!input.content?.trim()) return err("INVALID_INPUT", "Diary content cannot be empty.");
    const now = new Date();
    const entry: DiaryEntry = {
      id: createId("diary"),
      content: input.content.trim(),
      createdAt: now,
      updatedAt: now,
      tags: [...(input.tags ?? [])],
      metadata: cloneValue(input.metadata ?? {})
    };
    this.entries.set(entry.id, entry);
    return ok(cloneEntry(entry));
  }

  get(id: string): Result<DiaryEntry> {
    const e = this.entries.get(id);
    return e ? ok(cloneEntry(e)) : err("NOT_FOUND", `Diary entry not found: ${id}`);
  }

  getAll(): DiaryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(cloneEntry);
  }

  update(id: string, patch: Partial<Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">>): Result<DiaryEntry> {
    const e = this.entries.get(id);
    if (!e) return err("NOT_FOUND", `Diary entry not found: ${id}`);
    if (patch.content !== undefined && !patch.content.trim()) return err("INVALID_INPUT", "Diary content cannot be empty.");
    Object.assign(e, patch, {
      content: patch.content?.trim() ?? e.content,
      tags: patch.tags ? [...patch.tags] : e.tags,
      metadata: patch.metadata !== undefined ? cloneValue(patch.metadata) : e.metadata,
      updatedAt: new Date()
    });
    return ok(cloneEntry(e));
  }

  delete(id: string): Result<void> {
    if (!this.entries.delete(id)) return err("NOT_FOUND", `Diary entry not found: ${id}`);
    return ok(undefined);
  }

  replaceAll(entries: DiaryEntry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.id, cloneEntry(e));
  }

  valuesUnsafe(): DiaryEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }
}

const cloneEntry = (e: DiaryEntry): DiaryEntry => ({
  ...e,
  tags: [...e.tags],
  metadata: cloneValue(e.metadata),
  createdAt: new Date(e.createdAt),
  updatedAt: new Date(e.updatedAt)
});
