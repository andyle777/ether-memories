import { afterEach, describe, expect, it, vi } from "vitest";
import { EtherMemoriesCore, CondensationEngine, type DreamPlan, type MemoryNote } from "../src/index.js";
import type { DreamCycleResult } from "../src/types/dreamAnalysis.js";
import type { Result } from "../src/utils/result.js";
import { inspectionGraph, inspectionNotes } from "../src/core/inspectionSources.js";
import * as analysisModule from "../src/core/dreamAnalysis.js";
import * as encodingModule from "../src/core/dreamSelection.js";
import { DREAM_AS_OF, planFor, requireValue, seedDreamCore } from "./helpers/dream-analysis.js";

const fixture = () => seedDreamCore([{ id: "a", content: "  Alpha source carries stable facts.  " },
  { id: "b", content: "  Beta source carries different facts.  " }], [{ id: "ab", source: "a", target: "b", relationship: "supports" }]);
const run = (core: EtherMemoriesCore, input: unknown): Result<DreamCycleResult> => core.runDreamCycle(input as DreamPlan);
const idsPlan = (core: EtherMemoriesCore) => planFor(core, { kind: "ids", ids: ["a", "b"] });
const note = (core: EtherMemoriesCore, id = "a") => inspectionNotes(core.notes).get(id)!;
const fail = (result: Result<DreamCycleResult>, code: string) => expect(result).toMatchObject({ ok: false, error: { code } });
afterEach(() => vi.restoreAllMocks());

describe("T4 Core validated read-only execution", () => {
  it("returns detached deterministic proposals and preserves every logical field/revision on replay", () => {
    const core = fixture(); requireValue(core.addDiaryEntry({ content: "Diary secret sentinel" }));
    const plan = idsPlan(core), before = core.exportData(), revision = core.notes.revision, diaryRevision = core.diary.revision;
    const first = requireValue(run(core, plan));
    expect(first).toMatchObject({ algorithm: "ether.dream.v1", planId: plan.planId, dependencyDigest: plan.dependencyDigest,
      asOf: DREAM_AS_OF, sourceCount: 2, knownProposalCount: 2, proposalCount: 2, proposalsTruncated: false });
    expect(first.proposals.map(proposal => proposal.content)).toEqual(["Alpha source carries stable facts.", "Beta source carries different facts."]);
    expect(run(core, plan)).toEqual({ ok: true, value: first });
    expect(core.exportData()).toEqual(before); expect(core.notes.revision).toBe(revision); expect(core.diary.revision).toBe(diaryRevision);
    expect(JSON.stringify(first)).not.toContain("Diary secret sentinel");
  });
  it("executes an empty valid plan without fake output or mutation", () => {
    const core = fixture(), plan = planFor(core, { kind: "tags", tags: ["missing"] }), before = core.exportData();
    expect(requireValue(run(core, plan))).toMatchObject({ sourceCount: 0, knownProposalCount: 0, proposalCount: 0, proposals: [], proposalsTruncated: false, truncationReasons: [] });
    expect(run(core, plan)).toEqual(run(core, plan)); expect(core.exportData()).toEqual(before);
  });
  it("validates hostile shape and algorithm before any authoritative capture", () => {
    const core = fixture(), good = idsPlan(core), source = inspectionNotes(core.notes);
    const get = vi.spyOn(source, "get").mockImplementation(() => { throw Error("capture forbidden"); });
    fail(run(core, null), "INVALID_INPUT"); fail(run(core, { ...good, selectedCount: 99 }), "INVALID_INPUT");
    fail(run(core, { algorithm: "ether.dream.v2", get planId() { throw Error("getter"); } }), "UNSUPPORTED_SCHEMA");
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["planId", "dependencyDigest"] as const)("recomputes and rejects a forged %s without analysis", field => {
    const core = fixture(), plan = idsPlan(core), before = core.exportData(); plan[field] = "f".repeat(64);
    const analyze = vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(() => { throw Error("analysis forbidden"); });
    fail(run(core, plan), "CONFLICT"); expect(analyze).not.toHaveBeenCalled(); expect(core.exportData()).toEqual(before);
  });
  it("compares every field even when caller hashes are unchanged", () => {
    const core = fixture(), plan = idsPlan(core);
    fail(run(core, { ...plan, graph: { relationshipCount: 0 } }), "CONFLICT");
    fail(run(core, { ...plan, budgets: { ...plan.budgets, maxPopulation: 4095 } }), "CONFLICT");
    fail(run(core, { ...plan, selector: { kind: "query", query: "missing" } }), "CONFLICT");
  });
  it("never uses Core's candidate-capable Condensation engine or any canonical mutator", () => {
    const core = fixture(), plan = idsPlan(core), before = core.exportData();
    const engine = vi.spyOn(core.condensation, "analyze").mockImplementation(() => { throw Error("authority engine forbidden"); });
    const traps = ["addMemory", "promoteCandidate", "updateMemory", "deleteMemory", "addDiaryEntry", "updateDiary", "deleteDiary", "touch", "save", "previewDreamCycle"] as const;
    for (const key of traps) vi.spyOn(core, key).mockImplementation((() => { throw Error(`mutation ${key}`); }) as any);
    expect(run(core, plan).ok).toBe(true); expect(engine).not.toHaveBeenCalled(); expect(core.exportData()).toEqual(before);
  });
  it("contains unexpected capture exceptions without revealing source details", () => {
    const core = fixture(), plan = idsPlan(core);
    vi.spyOn(inspectionNotes(core.notes), "get").mockImplementation(() => { throw Error("secret exception body"); });
    const result = run(core, plan); fail(result, "UNKNOWN_ERROR"); expect(JSON.stringify(result)).not.toContain("secret exception body");
  });
  it("contains unexpected analyze exceptions without partial output", () => {
    const core = fixture(), plan = idsPlan(core);
    vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(() => { throw Error("secret analysis failure"); });
    const result = run(core, plan); fail(result, "UNKNOWN_ERROR"); expect(JSON.stringify(result)).not.toContain("secret analysis failure"); expect(result).not.toHaveProperty("value");
  });
});

describe("T4 exact staleness and scoped freshness", () => {
  const changes: Array<[string, (core: EtherMemoriesCore) => void]> = [
    ["content", core => { note(core).content = "Changed source text"; }],
    ["tags", core => { note(core).tags.push("changed"); }],
    ["createdAt", core => { note(core).createdAt = new Date(11); }],
    ["eligible expiry", core => { note(core).expiresAt = new Date(DREAM_AS_OF + 1); }],
    ["expired source", core => { note(core).expiresAt = new Date(DREAM_AS_OF); }],
    ["candidate", core => { note(core).status = "candidate"; }],
    ["archived", core => { note(core).status = "archived"; }],
    ["rejected", core => { note(core).status = "rejected"; }],
    ["deletion", core => { requireValue(core.deleteMemory("a")); }],
    ["relationship removal", core => { inspectionGraph(core.graph).dropEdge("ab"); }],
    ["relationship change", core => { inspectionGraph(core.graph).setEdgeAttribute("ab", "relationship", "mentions"); }],
    ["relationship addition", core => { requireValue(core.graph.addEdgeWithId("ba", "memory:b", "memory:a", "supports")); }],
    ["source byte ceiling", core => { note(core).content = "x".repeat(65537); }],
    ["canonical source encoding", core => { note(core).content = "\ud800"; }]
  ];
  it.each(changes)("returns CONFLICT after bound %s changes and leaves current state untouched", (_name, change) => {
    const core = fixture(), plan = idsPlan(core); change(core); const before = core.exportData();
    fail(run(core, plan), "CONFLICT"); expect(core.exportData()).toEqual(before);
  });
  it("preserves results after all unbound fields and unrelated explicit-ID state change", () => {
    const core = seedDreamCore([{ id: "a", content: "  A stable source fact.  " }, { id: "secret", content: "secret unrelated text" }],
      [{ id: "foreign", source: "a", target: "secret", relationship: "supports" }]);
    const plan = planFor(core, { kind: "ids", ids: ["a"] }), expected = run(core, plan), selected = note(core);
    Object.assign(selected, { summary: "different", category: "different", source: "ai", provenance: { kind: "condensed" }, importance: 0.1,
      confidence: 0.2, pinned: true, metadata: { secret: "unused" }, updatedAt: new Date(999) });
    note(core, "secret").content = "different unrelated body";
    inspectionGraph(core.graph).setNodeAttribute("memory:a", "label", "different");
    inspectionGraph(core.graph).setEdgeAttribute("foreign", "relationship", "mentions");
    expect(run(core, plan)).toEqual(expected);
  });
  it("does not even read unbound selected fields or nonselected bodies/tags for explicit IDs", () => {
    const core = seedDreamCore([{ id: "a", content: "  A stable source fact.  " }, { id: "secret", content: "secret body" }]);
    const plan = planFor(core, { kind: "ids", ids: ["a"] }), selected = note(core), unselected = note(core, "secret");
    for (const key of ["summary", "category", "source", "provenance", "importance", "confidence", "pinned", "metadata", "updatedAt"]) {
      Object.defineProperty(selected, key, { configurable: true, enumerable: true, get() { throw Error(`unbound ${key}`); } });
    }
    for (const key of ["content", "tags"]) Object.defineProperty(unselected, key, { configurable: true, get() { throw Error(`unselected ${key}`); } });
    expect(run(core, plan).ok).toBe(true);
  });
  it("does not stale a plan because actual wall time has advanced", () => {
    const core = fixture(); note(core).expiresAt = new Date(DREAM_AS_OF + 1); const plan = idsPlan(core);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("wall clock forbidden"); });
    expect(run(core, plan).ok).toBe(true); expect(clock).not.toHaveBeenCalled();
  });
  it.each(["tags", "query", "all_active", "date-window"] as const)("rejects changed %s coverage or membership", kind => {
    const core = fixture(), selector = kind === "tags" ? { kind, tags: ["shared"] } : kind === "query" ? { kind, query: "source" }
      : kind === "date-window" ? { kind, from: 10, to: 11 } : { kind };
    const plan = requireValue(core.previewDreamCycle(selector, { asOf: DREAM_AS_OF, budgets: { maxSources: 1 } }));
    core.notes.replaceAll([...core.notes.valuesUnsafe(), { ...note(core), id: "c", content: "Another source match" }]);
    fail(run(core, plan), "CONFLICT");
  });
  it("rejects changed selector membership even when matching count remains equal", () => {
    const core = fixture(); note(core, "b").tags = ["other"];
    const plan = planFor(core, { kind: "tags", tags: ["shared"] }); note(core).tags = ["other"]; note(core, "b").tags = ["shared"];
    fail(run(core, plan), "CONFLICT");
  });
});

describe("T4 approved recapture boundary and same-snapshot execution", () => {
  it.each(["ids", "query", "tags", "all_active"] as const)("keeps unselected %s matching data out of analysis, identity preimage and output", kind => {
    const secret = "UNSELECTED_SECRET_SENTINEL";
    const core = seedDreamCore([{ id: "a", content: "  Target source carries selected facts.  " }, { id: secret, content: `target ${secret}`, tags: ["shared", secret] }],
      [{ id: `edge_${secret}`, source: "a", target: secret, relationship: "supports" }]);
    const selector = kind === "ids" ? { kind, ids: ["a", secret] } : kind === "query" ? { kind, query: "target" }
      : kind === "tags" ? { kind, tags: ["shared"] } : { kind };
    // Code-unit order places the sentinel before a unless it has a lower-case
    // prefix. Select a explicitly for the non-ID population cases below.
    const raw = note(core, secret); raw.id = `z_${secret}`;
    core.notes.replaceAll([note(core), raw]);
    const actualSecret = raw.id;
    const actualSelector = kind === "ids" ? { kind, ids: ["a", actualSecret] } : selector;
    const plan = requireValue(core.previewDreamCycle(actualSelector, { asOf: DREAM_AS_OF, budgets: { maxSources: 1 } }));
    let phase = "capture", bodyReads = 0, tagReads = 0; const body = raw.content, tags = [...raw.tags];
    const authoritative = note(core, actualSecret);
    Object.defineProperty(authoritative, "content", { configurable: true, get() { if (phase !== "capture" || kind !== "query") throw Error("illegal secret body read"); bodyReads++; return body; } });
    Object.defineProperty(authoritative, "tags", { configurable: true, get() { if (phase !== "capture" || kind !== "tags") throw Error("illegal secret tag read"); tagReads++; return tags; } });
    const original = analysisModule.analyzeDreamSnapshot;
    let proposalPreimages = 0;
    const encode = encodingModule.dreamBytes;
    vi.spyOn(encodingModule, "dreamBytes").mockImplementation((value, limit) => {
      if (typeof value === "object" && value !== null && Object.getOwnPropertyDescriptor(value, "domain")?.value === "ether.dream.proposal.v1") {
        proposalPreimages++;
        expect(JSON.stringify(value)).not.toContain(secret);
      }
      return encode(value, limit);
    });
    vi.spyOn(analysisModule, "analyzeDreamSnapshot").mockImplementation((selectedSnapshot, minimalBinding) => {
      phase = "analysis";
      expect(Object.keys(selectedSnapshot).sort()).toEqual(["notes", "relationships"]);
      expect(Object.keys(minimalBinding).sort()).toEqual(["algorithm", "asOf", "dependencyDigest", "planId"]);
      expect(JSON.stringify([selectedSnapshot, minimalBinding])).not.toContain(secret);
      return original(selectedSnapshot, minimalBinding);
    });
    const result = requireValue(run(core, plan));
    expect(result.sourceCount).toBe(1); expect(JSON.stringify(result)).not.toContain(secret);
    expect(proposalPreimages).toBe(1);
    // Frozen T3 validates content through four property accesses and tags
    // through three; every access stays within the single recapture phase.
    expect(bodyReads).toBe(kind === "query" ? 4 : 0); expect(tagReads).toBe(kind === "tags" ? 3 : 0);
  });
  it("analyzes pre-mutation bytes for every unit and performs no second live read", () => {
    const core = fixture(), plan = idsPlan(core), replayPlan = structuredClone(plan), source = inspectionNotes(core.notes), second = source.get("b")!;
    const graph = inspectionGraph(core.graph); let compared = false;
    const get = source.get.bind(source);
    vi.spyOn(source, "get").mockImplementation(id => { if (compared) throw Error("second live note read"); return get(id); });
    for (const key of ["hasNode", "directedEdge", "getEdgeAttribute"] as const) {
      const original: any = graph[key].bind(graph);
      vi.spyOn(graph, key).mockImplementation(((...args: unknown[]) => { if (compared) throw Error("second live graph read"); return original(...args); }) as any);
    }
    const originalSnapshotAnalysis = analysisModule.analyzeDreamSnapshot;
    vi.spyOn(analysisModule, "analyzeDreamSnapshot").mockImplementation((input, minimalBinding) => { compared = true; return originalSnapshotAnalysis(input, minimalBinding); });
    const original = CondensationEngine.prototype.analyze; let calls = 0;
    vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(function (this: CondensationEngine, ...args) {
      if (++calls === 1) { second.content = "Changed authoritative bytes during analysis"; plan.asOf = 0; plan.selectedSourceIds.length = 0; }
      return original.apply(this, args);
    });
    const result = requireValue(run(core, plan));
    expect(result.asOf).toBe(DREAM_AS_OF); expect(result.proposals.map(proposal => proposal.content)).toEqual(["Alpha source carries stable facts.", "Beta source carries different facts."]);
    compared = false; vi.restoreAllMocks();
    fail(run(core, replayPlan), "CONFLICT");
  });
  it("isolates caller output mutation and later canonical edits from all prior/future results", () => {
    const core = fixture(), plan = idsPlan(core), before = core.exportData();
    const result = requireValue(run(core, plan)), expected = structuredClone(result);
    result.proposals[0].content = "caller"; result.proposals[0].sourceIds.push("caller"); result.proposals[0].evidence.keyFacts.push("caller fact");
    result.proposals[0].evidence.relationships[0].relationship = "caller"; result.proposals[0].evidence.truncationReasons.push("relationship-limit");
    result.truncationReasons.push("proposal-limit");
    expect(core.exportData()).toEqual(before); expect(requireValue(run(core, plan))).toEqual(expected);
    const retained = requireValue(run(core, plan)); note(core).content = "Later canonical text"; expect(retained).toEqual(expected); fail(run(core, plan), "CONFLICT");
  });
});
