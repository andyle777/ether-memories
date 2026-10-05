import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";
import { encodeSnapshotPayload, hydrateSnapshot } from "../src/persistence/snapshotPayload.js";
import { decodeEtherData } from "../src/persistence/etherData.js";
import { value } from "./helpers/persistence.js";

const raw = () => JSON.parse(readFileSync(new URL("./fixtures/store-v0.3.json", import.meta.url), "utf8"));
const userId = "fixture-user";

const baseNote = () => ({ id: "elision-note", content: "Elision probe note", summary: "Elision",
  category: "probe", source: "user", createdAt: "2020-01-03T00:00:00.000Z", updatedAt: "2020-01-03T00:00:00.000Z" });
const baseDiary = () => ({ id: "elision-diary", content: "Elision probe diary",
  createdAt: "2020-01-03T00:00:00.000Z", updatedAt: "2020-01-03T00:00:00.000Z" });

describe("elided-default equivalence audit", () => {
  it.each([
    ["tags", []],
    ["metadata", {}],
    ["importance", 0.5],
    ["confidence", 0.75],
    ["pinned", false],
    ["status", "active"]
  ] as const)("note field %s: omitted and explicit default persist and hydrate identically", (field, explicit) => {
    const omitted = baseNote();
    const explicitNote = { ...baseNote(), [field]: explicit };
    const a = value(hydrateSnapshot({ ...raw(), memoryNotes: [omitted] }, userId));
    const b = value(hydrateSnapshot({ ...raw(), memoryNotes: [explicitNote] }, userId));
    const bytesA = value(encodeSnapshotPayload(a));
    const bytesB = value(encodeSnapshotPayload(b));
    expect(bytesB).toEqual(bytesA);
    // The canonical persisted projection actually elides the default.
    const persisted = value(decodeEtherData(bytesA, false)) as { data: { memoryNotes: Record<string, unknown>[] } };
    expect(Object.hasOwn(persisted.data.memoryNotes[0]!, field)).toBe(false);
    // Both persisted forms hydrate to identical Core state and behavior.
    const coreA = new EtherMemoriesCore({ userId });
    const coreB = new EtherMemoriesCore({ userId });
    value(coreA.importData(JSON.parse(JSON.stringify(a))));
    value(coreB.importData(JSON.parse(JSON.stringify(b))));
    expect(coreA.exportData()).toEqual(coreB.exportData());
    expect(coreA.queryMemories("Elision")).toEqual(coreB.queryMemories("Elision"));
  });

  it.each([
    ["tags", []],
    ["metadata", {}]
  ] as const)("diary field %s: omitted and explicit default persist and hydrate identically", (field, explicit) => {
    const omitted = baseDiary();
    const explicitEntry = { ...baseDiary(), [field]: explicit };
    const a = value(hydrateSnapshot({ ...raw(), memoryNotes: [], diary: [omitted] }, userId));
    const b = value(hydrateSnapshot({ ...raw(), memoryNotes: [], diary: [explicitEntry] }, userId));
    expect(value(encodeSnapshotPayload(b))).toEqual(value(encodeSnapshotPayload(a)));
    const persisted = value(decodeEtherData(value(encodeSnapshotPayload(a)), false)) as { data: { diary: Record<string, unknown>[] } };
    expect(Object.hasOwn(persisted.data.diary[0]!, field)).toBe(false);
    const coreA = new EtherMemoriesCore({ userId });
    const coreB = new EtherMemoriesCore({ userId });
    value(coreA.importData(JSON.parse(JSON.stringify(a))));
    value(coreB.importData(JSON.parse(JSON.stringify(b))));
    expect(coreA.exportData()).toEqual(coreB.exportData());
  });

  it("default provenance per source is reconstructible and elided safely", () => {
    for (const [source, kind] of [["user", "user_explicit"], ["diary", "diary_extract"], ["imported", "imported"]] as const) {
      const omitted = { ...baseNote(), source };
      const explicitNote = { ...baseNote(), source, provenance: { kind } };
      const a = value(hydrateSnapshot({ ...raw(), memoryNotes: [omitted] }, userId));
      const b = value(hydrateSnapshot({ ...raw(), memoryNotes: [explicitNote] }, userId));
      expect(value(encodeSnapshotPayload(b))).toEqual(value(encodeSnapshotPayload(a)));
      expect(a.memoryNotes[0]!.provenance).toEqual(b.memoryNotes[0]!.provenance);
      expect(a.memoryNotes[0]!.provenance).toEqual({ kind });
    }
  });

  it("provenance with non-reconstructible information is never elided", () => {
    for (const provenance of [{ kind: "user_explicit", parentDiaryId: "diary-one" },
      { kind: "user_explicit", lastEditKind: "user" },
      { kind: "imported" }]) {
      const note = { ...baseNote(), provenance };
      const snapshot = value(hydrateSnapshot({ ...raw(), memoryNotes: [note] }, userId));
      const persisted = value(decodeEtherData(value(encodeSnapshotPayload(snapshot)), false)) as { data: { memoryNotes: Record<string, unknown>[] } };
      expect(persisted.data.memoryNotes[0]!.provenance).toEqual(provenance);
    }
  });

  it("preserves explicit displayName \"\" as historical data; only absent normalizes to absent", () => {
    const omitted = raw();
    delete omitted.identity.displayName;
    const empty = { ...raw(), identity: { ...raw().identity, displayName: "" } };
    const a = value(hydrateSnapshot(omitted, userId));
    const b = value(hydrateSnapshot(empty, userId));
    // The frozen Core preserves the distinction; persistence must not lose it.
    expect(a.identity.displayName).toBeUndefined();
    expect(b.identity.displayName).toBe("");
    const bytesA = value(encodeSnapshotPayload(a));
    const bytesB = value(encodeSnapshotPayload(b));
    expect(bytesB).not.toEqual(bytesA);
    const persistedEmpty = value(decodeEtherData(bytesB, false)) as { data: { identity: Record<string, unknown> } };
    expect(persistedEmpty.data.identity.displayName).toBe("");
    // Roundtrip: the explicit empty string survives persisted decode.
    expect(value(hydrateSnapshot(persistedEmpty.data, userId)).identity.displayName).toBe("");
    const persistedOmitted = value(decodeEtherData(bytesA, false)) as { data: { identity: Record<string, unknown> } };
    expect(Object.hasOwn(persistedOmitted.data.identity, "displayName")).toBe(false);
  });

  it("identity preferences {} and omitted remain equivalent", () => {
    const omitted = raw();
    delete omitted.identity.preferences;
    const explicit = { ...raw(), identity: { ...raw().identity, preferences: {} } };
    const a = value(hydrateSnapshot(omitted, userId));
    const b = value(hydrateSnapshot(explicit, userId));
    expect(value(encodeSnapshotPayload(b))).toEqual(value(encodeSnapshotPayload(a)));
    expect(a.identity.preferences).toEqual(b.identity.preferences);
    const persisted = value(decodeEtherData(value(encodeSnapshotPayload(a)), false)) as { data: { identity: Record<string, unknown> } };
    expect(Object.hasOwn(persisted.data.identity, "preferences")).toBe(false);
  });
});
