import type { DiaryEntry, MemoryNote } from "../types/index.js";
import { tokenize } from "./Tokenizer.js";

export interface LexicalDocument {
  id: string;
  tokens: string[];
  tokenSet: Set<string>;
  phraseText: string;
  tagTokens: Set<string>;
  metadataTokens: Set<string>;
}

export class LexicalIndex {
  private notes = new Map<string, LexicalDocument>();
  private diary = new Map<string, LexicalDocument>();
  private notesRevision = -1;
  private diaryRevision = -1;

  constructor(
    private readonly getNotes: () => MemoryNote[],
    private readonly getDiaryEntries: () => DiaryEntry[],
    private readonly getNotesRevision: () => number,
    private readonly getDiaryRevision: () => number
  ) {}

  ensureFresh(): void {
    if (this.notesRevision !== this.getNotesRevision()) this.rebuildNotes();
    if (this.diaryRevision !== this.getDiaryRevision()) this.rebuildDiary();
  }

  rebuild(): void {
    this.rebuildNotes();
    this.rebuildDiary();
  }

  getNote(id: string): LexicalDocument | undefined {
    this.ensureFresh();
    return this.notes.get(id);
  }

  getDiary(id: string): LexicalDocument | undefined {
    this.ensureFresh();
    return this.diary.get(id);
  }

  allNotes(): LexicalDocument[] {
    this.ensureFresh();
    return [...this.notes.values()];
  }

  allDiary(): LexicalDocument[] {
    this.ensureFresh();
    return [...this.diary.values()];
  }

  private rebuildNotes(): void {
    this.notes = new Map(this.getNotes().map(note => [note.id, documentForNote(note)]));
    this.notesRevision = this.getNotesRevision();
  }

  private rebuildDiary(): void {
    this.diary = new Map(this.getDiaryEntries().map(entry => [entry.id, documentForDiary(entry)]));
    this.diaryRevision = this.getDiaryRevision();
  }
}

const documentForNote = (note: MemoryNote): LexicalDocument => {
  const primary = tokenize(`${note.content} ${note.summary ?? ""}`);
  const tagTokens = new Set(tokenize(`${note.tags.join(" ")} ${note.category ?? ""}`));
  const metadataTokens = new Set(tokenize(stringifyMetadata(note.metadata)));
  return {
    id: note.id,
    tokens: primary,
    tokenSet: new Set(primary),
    phraseText: primary.join(" "),
    tagTokens,
    metadataTokens
  };
};

const documentForDiary = (entry: DiaryEntry): LexicalDocument => {
  const primary = tokenize(`${entry.content} ${entry.tags.join(" ")}`);
  return {
    id: entry.id,
    tokens: primary,
    tokenSet: new Set(primary),
    phraseText: primary.join(" "),
    tagTokens: new Set(tokenize(entry.tags.join(" "))),
    metadataTokens: new Set(tokenize(stringifyMetadata(entry.metadata)))
  };
};

const stringifyMetadata = (value: Record<string, unknown>): string =>
  Object.entries(value)
    .map(([key, item]) => `${key} ${typeof item === "string" ? item : JSON.stringify(item)}`)
    .join(" ");
