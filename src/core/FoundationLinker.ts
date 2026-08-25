import type { DiaryEntry, MemoryNote } from "../types/index.js";
import { MindGraphManager } from "./MindGraph.js";

export class FoundationLinker {
  constructor(private readonly graph: MindGraphManager) {}

  linkNote(note: MemoryNote): void {
    this.graph.ensureNode({ id: `memory:${note.id}`, type: "memory", label: note.summary ?? note.content, data: { status: note.status } });
    if (note.provenance.parentDiaryId) {
      const diaryId = `diary:${note.provenance.parentDiaryId}`;
      if (!this.graph.getNode(diaryId)) {
        this.graph.ensureNode({ id: diaryId, type: "diary", data: {} });
      }
      this.graph.addEdge(`memory:${note.id}`, diaryId, "derived_from", {
        origin: "foundation_linker",
        cause: { type: "note_created", noteId: note.id },
        provenanceKind: note.provenance.kind
      });
    }
  }

  linkDiary(entry: DiaryEntry): void {
    this.graph.ensureNode({ id: `diary:${entry.id}`, type: "diary", label: entry.content, data: {} });
  }

  removeNote(noteId: string): void {
    this.graph.removeNode(`memory:${noteId}`);
  }

  removeDiary(diaryId: string): void {
    this.graph.removeNode(`diary:${diaryId}`);
  }
}
