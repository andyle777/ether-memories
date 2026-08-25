import type { MemoryNote } from "../types/index.js";
import { MemoryNotes } from "./MemoryNotes.js";

export class CondensationEngine {
  constructor(private readonly notes: MemoryNotes) {}

  condense(input: string, parentDiaryId?: string): MemoryNote | undefined {
    if (!input.trim()) return undefined;
    const summary = input.length > 200 ? `${input.slice(0, 197)}...` : input;
    const result = this.notes.add({
      content: summary,
      summary,
      source: "ai",
      status: "candidate",
      provenance: {
        kind: parentDiaryId ? "diary_extract" : "condensed",
        parentDiaryId,
        lastEditKind: "system"
      },
      confidence: parentDiaryId ? 0.8 : 0.75
    });
    return result.ok ? result.value : undefined;
  }
}
