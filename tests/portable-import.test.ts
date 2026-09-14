import { describe, expect, it } from "vitest";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { toPortableRecords } from "../src/adapters/portable.js";
import type { PortableRecord } from "../src/types/index.js";

const noteRecord = (overrides: Partial<PortableRecord> = {}): PortableRecord => ({
  schema: "ether.portable_record.v1",
  id: "portable-note",
  kind: "note",
  text: "  Imported note  ",
  citation: { kind: "note", id: "portable-note", ref: "note:portable-note" },
  tags: ["one", "two"],
  category: "work",
  source: "conversation",
  status: "candidate",
  confidence: 0.6,
  createdAt: "2024-01-01T00:00:00.123Z",
  updatedAt: "2024-01-02T00:00:00.456Z",
  ...overrides
});

const diaryRecord = (overrides: Partial<PortableRecord> = {}): PortableRecord => ({
  schema: "ether.portable_record.v1",
  id: "portable-diary",
  kind: "diary",
  text: "  Imported diary  ",
  citation: { kind: "diary", id: "portable-diary", ref: "diary:portable-diary" },
  tags: ["journal"],
  createdAt: "2024-02-01T00:00:00.123Z",
  updatedAt: "2024-02-01T00:00:00.456Z",
  ...overrides
});

describe("Portable Record v1 import", () => {
  it("imports Notes and Diary atomically with documented defaults", async () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const receipt = await core.importPortableRecords([noteRecord(), diaryRecord()]);
    expect(receipt).toEqual({ imported: 2, issues: [] });
    const note = core.notes.get("portable-note");
    expect(note.ok && note.value).toMatchObject({
      id: "portable-note", content: "Imported note", category: "work",
      tags: ["one", "two"], source: "conversation", status: "candidate",
      confidence: 0.6, importance: 0.5, pinned: false, metadata: {},
      provenance: { kind: "imported", lastEditKind: "import" }
    });
    expect(note.ok && note.value.createdAt.toISOString()).toBe("2024-01-01T00:00:00.123Z");
    const diary = core.diary.get("portable-diary");
    expect(diary.ok && diary.value).toMatchObject({ id: "portable-diary", content: "Imported diary", tags: ["journal"], metadata: {} });
    expect(core.graph.getNode("memory:portable-note")).toBeTruthy();
    expect(core.graph.getNode("diary:portable-diary")).toBeTruthy();
  });

  it("rejects the whole collection and leaves state unchanged", async () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addMemory({ content: "existing" });
    const before = JSON.stringify(core.exportData());
    const receipt = await core.importPortableRecords([
      noteRecord({ id: "good", citation: { kind: "note", id: "good", ref: "note:good" } }),
      noteRecord({ id: "bad", citation: { kind: "diary", id: "bad", ref: "diary:bad" } })
    ]);
    expect(receipt.imported).toBe(0);
    expect(receipt.issues.some(issue => issue.code === "INVALID_CITATION")).toBe(true);
    expect(JSON.stringify(core.exportData())).toBe(before);
    const repeated = await core.importPortableRecords([
      noteRecord({ id: "good", citation: { kind: "note", id: "good", ref: "note:good" } }),
      noteRecord({ id: "bad", citation: { kind: "diary", id: "bad", ref: "diary:bad" } })
    ]);
    expect(repeated).toEqual(receipt);
    expect(JSON.stringify(core.exportData())).toBe(before);
  });

  it("rejects duplicate and existing IDs without overwrite", async () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    core.addMemory({ content: "existing", metadata: { keep: true } });
    const existing = core.notes.getAll()[0].id;
    const record = noteRecord({ id: existing, citation: { kind: "note", id: existing, ref: `note:${existing}` } });
    const receipt = await core.importPortableRecords([record, record]);
    expect(receipt.imported).toBe(0);
    expect(receipt.issues.map(issue => issue.code)).toEqual(["EXISTING_ID_CONFLICT", "DUPLICATE_PAYLOAD_ID", "EXISTING_ID_CONFLICT"]);
    const stored = core.notes.get(existing);
    expect(stored.ok && stored.value.content).toBe("existing");
  });

  it("validates timestamps, chronology, enum values, citations, and numeric input", async () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const receipt = await core.importPortableRecords([
      noteRecord({
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "invalid" as never,
        confidence: 2,
        citation: { kind: "note", id: "portable-note", ref: "wrong" }
      })
    ]);
    expect(receipt.imported).toBe(0);
    expect(receipt.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      "INVALID_TIMESTAMP", "INVALID_STATUS", "MALFORMED_RECORD", "INVALID_CITATION"
    ]));
  });

  it("enforces raw byte limits before parsing, including async streams", async () => {
    const core = new EtherMemoriesCore({ userId: "u1" });
    const raw = JSON.stringify([noteRecord()]);
    const direct = await core.importPortableRecords(raw, { maxBytes: raw.length - 1 });
    expect(direct.issues[0].code).toBe("INPUT_LIMIT_EXCEEDED");
    const stream = (async function* () {
      yield raw.slice(0, 10);
      yield raw.slice(10);
    })();
    const streamed = await core.importPortableRecords(stream, { maxBytes: 10 });
    expect(streamed.issues[0].code).toBe("INPUT_LIMIT_EXCEEDED");
    expect(core.notes.get("portable-note").ok).toBe(false);
  });

  it("round-trips only fields represented by Portable Record v1", async () => {
    const source = new EtherMemoriesCore({ userId: "source" });
    const first = await source.importPortableRecords([noteRecord(), diaryRecord()]);
    expect(first.imported).toBe(2);
    const context = source.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["portable-note"], diaryIds: ["portable-diary"], filters: { includeCandidate: true }, budget: { maxNotes: 2, maxDiary: 2, maxNodes: 0, maxEdges: 0 } }
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const records = toPortableRecords(context.value);
    const target = new EtherMemoriesCore({ userId: "target" });
    expect((await target.importPortableRecords(records)).imported).toBe(2);
    const exported = target.buildMemoryContext({
      purpose: "debug",
      query: { noteIds: ["portable-note"], diaryIds: ["portable-diary"], filters: { includeCandidate: true }, budget: { maxNotes: 2, maxDiary: 2, maxNodes: 0, maxEdges: 0 } }
    });
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(toPortableRecords(exported.value)).toEqual(records);
  });
});
