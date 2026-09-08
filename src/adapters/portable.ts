import type { MemoryContext, PortableRecord } from "../types/index.js";
import { PORTABLE_RECORD_SCHEMA_VERSION } from "../version.js";

export const toPortableRecords = (context: MemoryContext): PortableRecord[] => [
  ...context.notes.map(({ note, cite }) => ({
    schema: PORTABLE_RECORD_SCHEMA_VERSION, id: note.id, kind: "note" as const,
    text: note.content, citation: cite, tags: [...note.tags], category: note.category,
    source: note.source, status: note.status, confidence: note.confidence,
    createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString()
  })),
  ...context.diary.map(({ entry, cite }) => ({
    schema: PORTABLE_RECORD_SCHEMA_VERSION, id: entry.id, kind: "diary" as const,
    text: entry.content, citation: cite, tags: [...entry.tags],
    createdAt: entry.createdAt.toISOString(), updatedAt: entry.updatedAt.toISOString()
  }))
];
