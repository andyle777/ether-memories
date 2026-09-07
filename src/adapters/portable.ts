import type { MemoryContext, PortableRecord } from "../types/index.js";

export const toPortableRecords = (context: MemoryContext): PortableRecord[] => [
  ...context.notes.map(({ note, cite }) => ({
    schema: "ether.portable_record.v1" as const, id: note.id, kind: "note" as const,
    text: note.content, citation: cite, tags: [...note.tags], category: note.category,
    source: note.source, status: note.status, confidence: note.confidence,
    createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString()
  })),
  ...context.diary.map(({ entry, cite }) => ({
    schema: "ether.portable_record.v1" as const, id: entry.id, kind: "diary" as const,
    text: entry.content, citation: cite, tags: [...entry.tags],
    createdAt: entry.createdAt.toISOString(), updatedAt: entry.updatedAt.toISOString()
  }))
];
