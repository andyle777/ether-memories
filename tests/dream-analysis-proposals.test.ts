import { afterEach, describe, expect, it, vi } from "vitest";
import { CondensationEngine } from "../src/core/CondensationEngine.js";
import { analyzeDreamContent, analyzeDreamSnapshot } from "../src/core/dreamAnalysis.js";
import { admitDreamProposals, buildDreamResult, type DreamAnalysisBinding } from "../src/core/dreamProposals.js";
import type { DreamAnalysisSnapshot, DreamRelationship } from "../src/core/dreamPlan.js";
import type { DreamProposal } from "../src/types/dreamAnalysis.js";

const binding: DreamAnalysisBinding = { algorithm: "ether.dream.v1", planId: "1".repeat(64), dependencyDigest: "2".repeat(64), asOf: 100 };
const snapshot = (sources: Array<{ id: string; content: string }>, relationships: DreamRelationship[] = []): DreamAnalysisSnapshot => ({
  notes: sources.map(source => ({ ...source, tags: [], status: "active", createdAt: 10, expiresAt: null })), relationships
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const edge = { id: "edge", source: "A", target: "é", relationship: "supports" };
afterEach(() => vi.restoreAllMocks());

// Owned, shape-valid generated proposals let the actual fixed admission stage
// meet exact byte endpoints that text condensation does not naturally produce.
function sizedProposal(target: number, index = 0): DreamProposal {
  const result: DreamProposal = { proposalId: index.toString(16).padStart(64, "0"), content: `p${index}`, sourceIds: [`s${index}`],
    evidence: { keyFacts: ["A stable fact."], relationships: Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, source: `s${index}`, target: "t", relationship: "r" })),
      relationshipKnownCount: 8, relationshipsTruncated: false, truncationReasons: [] } };
  for (const relationship of result.evidence.relationships) for (const key of ["id", "relationship"] as const) {
    const count = Math.min(256 - relationship[key].length, Math.floor((target - bytes(result)) / 6));
    if (count > 0) relationship[key] += "\u0001".repeat(count);
  }
  const remaining = target - bytes(result);
  if (remaining < 0 || remaining > 5) throw Error(`Invalid sized fixture: ${target}`);
  result.content += "x".repeat(remaining);
  expect(bytes(result)).toBe(target);
  return result;
}

describe("T4 pure Condensation adapter", () => {
  it.each(["", " ", "\n\t"])("produces no output for blank input %j", content => expect(analyzeDreamContent(content)).toBeUndefined());
  it("projects only exact summary and ordered facts", () => {
    expect(analyzeDreamContent("  Alpha fact is stable. Beta fact is useful.  ")).toEqual({ content: "Alpha fact is stable. Beta fact is useful.",
      keyFacts: ["Alpha fact is stable.", "Beta fact is useful."] });
  });
  it.each([199, 200, 201])("bounds shortened summary at %i source units", length => {
    const output = analyzeDreamContent("x".repeat(length))!;
    expect(output.content).toBe(length <= 200 ? "x".repeat(length) : "x".repeat(197) + "...");
    expect(output.content.length).toBeLessThanOrEqual(200);
  });
  it.each([195, 196, 197])("preserves astral Unicode across summary cut after %i units", prefix => {
    const output = analyzeDreamContent("a".repeat(prefix) + "😀" + "b".repeat(20))!;
    expect(Buffer.from(output.content, "utf8").toString("utf8")).toBe(output.content);
    expect(output.content).toBe(prefix === 195 ? "a".repeat(195) + "😀..." : prefix === 196 ? "a".repeat(196) + "..." : "a".repeat(197) + "...");
  });
  it.each([[7, 0], [8, 1], [9, 1], [239, 1], [240, 1], [241, 0]])("filters %i-unit facts to %i", (length, count) => {
    expect(analyzeDreamContent("a".repeat(length))!.keyFacts.length).toBe(count);
  });
  it.each([4, 5, 6])("admits at most five ordered facts from %i", count => {
    const lines = Array.from({ length: count }, (_, i) => `Fact ${i} is stable.`);
    expect(analyzeDreamContent(lines.join("\n"))!.keyFacts).toEqual(lines.slice(0, 5));
  });
  it("cannot commit, condense or invoke its candidate callback", () => {
    const commit = vi.spyOn(CondensationEngine.prototype, "commitAnalysis").mockImplementation(() => { throw Error("commit forbidden"); });
    const condense = vi.spyOn(CondensationEngine.prototype, "condense").mockImplementation(() => { throw Error("condense forbidden"); });
    let candidates = 0;
    const original = CondensationEngine.prototype.analyze;
    vi.spyOn(CondensationEngine.prototype, "analyze").mockImplementation(function (this: CondensationEngine, text, parent, config) {
      (this as any).createCandidate = () => { candidates++; throw Error("candidate forbidden"); };
      expect(parent).toBeUndefined();
      expect(config).toEqual({ maxFacts: 5, minFactLength: 8, maxFactLength: 240, summaryLength: 200, maxTags: 8 });
      return original.call(this, text, parent, config);
    });
    expect(analyzeDreamContent("  A stable source fact.  ")).toEqual({ content: "A stable source fact.", keyFacts: ["A stable source fact."] });
    expect(commit).not.toHaveBeenCalled(); expect(condense).not.toHaveBeenCalled(); expect(candidates).toBe(0);
  });
});

describe("T4 selected-only proposals, exact equality and semantic golden", () => {
  it("matches the literal cross-platform golden and does not consult clocks/randomness/locales", () => {
    const input = snapshot([{ id: "é", content: "  Gamma fact is clear.  " }, { id: "A", content: "  Alpha fact is stable. Beta fact is useful.  " }], [edge]);
    vi.spyOn(Date, "now").mockImplementation(() => { throw Error("clock"); });
    vi.spyOn(Math, "random").mockImplementation(() => { throw Error("random"); });
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw Error("locale"); });
    const result = analyzeDreamSnapshot(input, binding);
    expect(result).toEqual({ ...binding, sourceCount: 2, knownProposalCount: 2, proposalCount: 2, proposalsTruncated: false, truncationReasons: [], proposals: [
      { proposalId: "cfd9456ca0056b5ba695d7bc788a7972dc22a397c8a2bb60dfcc4fe887e880cc", content: "Alpha fact is stable. Beta fact is useful.", sourceIds: ["A"],
        evidence: { keyFacts: ["Alpha fact is stable.", "Beta fact is useful."], relationships: [edge], relationshipKnownCount: 1, relationshipsTruncated: false, truncationReasons: [] } },
      { proposalId: "b098868d876ae692b785670415c614dcbd1664abb502133cda799a1fc6b85f40", content: "Gamma fact is clear.", sourceIds: ["é"],
        evidence: { keyFacts: ["Gamma fact is clear."], relationships: [edge], relationshipKnownCount: 1, relationshipsTruncated: false, truncationReasons: [] } }
    ] });
    expect(analyzeDreamSnapshot({ notes: [...input.notes].reverse(), relationships: [...input.relationships].reverse() }, binding)).toEqual(result);
    expect(analyzeDreamSnapshot(input, binding)).toEqual(result);
  });
  it("collapses exact outputs to the lowest-ID representative without merging graph origins", () => {
    const input = snapshot([{ id: "b", content: " A stable source fact. " }, { id: "a", content: "  A stable source fact.  " }, { id: "c", content: "target" }],
      [{ id: "ac", source: "a", target: "c", relationship: "supports" }, { id: "bc", source: "b", target: "c", relationship: "mentions" }]);
    const result = analyzeDreamSnapshot(input, binding);
    expect(result.proposalCount).toBe(1); expect(result.knownProposalCount).toBe(1);
    expect(result.proposals[0].sourceIds).toEqual(["a"]);
    expect(result.proposals[0].evidence.relationships).toEqual([{ id: "ac", source: "a", target: "c", relationship: "supports" }]);
  });
  it("suppresses content exactly equal to any selected source", () => {
    const input = snapshot([{ id: "a", content: "  A stable source fact.  " }, { id: "b", content: "A stable source fact." }]);
    expect(analyzeDreamSnapshot(input, binding).proposals).toEqual([]);
  });
  it("preserves near outputs and different literal fact arrays", () => {
    const input = snapshot([{ id: "a", content: "  A stable source fact.  " }, { id: "b", content: "  A stable source fact!  " }]);
    expect(analyzeDreamSnapshot(input, binding).proposalCount).toBe(2);
    const outputs = [{ sourceId: "a", analysis: { content: "Shared proposed output", keyFacts: ["First source fact."] } },
      { sourceId: "b", analysis: { content: "Shared proposed output", keyFacts: ["Second source fact."] } }];
    expect(buildDreamResult(input, binding, outputs).proposalCount).toBe(2);
  });
  it("owns all nested output and binds IDs to the validated plan", () => {
    const input = snapshot([{ id: "A", content: "  A stable source fact.  " }, { id: "é", content: "target" }], [edge]);
    const before = structuredClone(input), first = analyzeDreamSnapshot(input, binding), saved = structuredClone(first);
    first.proposals[0].sourceIds.push("other"); first.proposals[0].evidence.keyFacts[0] = "changed";
    first.proposals[0].evidence.relationships[0].relationship = "changed"; first.proposals[0].evidence.truncationReasons.push("relationship-limit");
    expect(input).toEqual(before); expect(analyzeDreamSnapshot(input, binding)).toEqual(saved);
    expect(analyzeDreamSnapshot(input, { ...binding, planId: "3".repeat(64) }).proposals[0].proposalId).not.toBe(saved.proposals[0].proposalId);
  });
  it("succeeds deterministically with empty selection", () => expect(analyzeDreamSnapshot(snapshot([]), binding)).toEqual({ ...binding,
    sourceCount: 0, knownProposalCount: 0, proposalCount: 0, proposals: [], proposalsTruncated: false, truncationReasons: [] }));
});

describe("T4 actual fixed work/output admission", () => {
  it.each([31, 32, 33])("reports exact completeness with %i distinct units", count => {
    const input = snapshot(Array.from({ length: count }, (_, i) => ({ id: `s${i.toString().padStart(3, "0")}`, content: `  Source ${i} has stable facts.  ` })));
    const result = analyzeDreamSnapshot(input, binding);
    expect(result.knownProposalCount).toBe(count); expect(result.proposalCount).toBe(Math.min(count, 32));
    expect(result.proposalsTruncated).toBe(count > 32); expect(result.truncationReasons).toEqual(count > 32 ? ["proposal-limit"] : []);
    expect(result.proposals.every(proposal => proposal.sourceIds.length === 1)).toBe(true);
  });
  it.each([127, 128])("bounds %i source units without inventing output", count => {
    const input = snapshot(Array.from({ length: count }, (_, i) => ({ id: `s${i}`, content: "unchanged" })));
    expect(analyzeDreamSnapshot(input, binding)).toMatchObject({ sourceCount: count, proposals: [] });
  });
  it("rejects 129 internal analysis units before any Condensation call", () => {
    const analyze = vi.spyOn(CondensationEngine.prototype, "analyze");
    expect(() => analyzeDreamSnapshot(snapshot(Array.from({ length: 129 }, (_, i) => ({ id: `s${i}`, content: "text" }))), binding)).toThrow();
    expect(analyze).not.toHaveBeenCalled();
  });
  it.each([7, 8, 9])("reports canonical evidence completeness with %i incident edges", count => {
    const sources = [{ id: "a", content: "  A stable source fact.  " }, ...Array.from({ length: count }, (_, i) => ({ id: `b${i}`, content: "unchanged" }))];
    const relationships = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, source: "a", target: `b${i}`, relationship: "supports" })).reverse();
    const evidence = analyzeDreamSnapshot(snapshot(sources, relationships), binding).proposals[0].evidence;
    expect(evidence.relationshipKnownCount).toBe(count); expect(evidence.relationships.length).toBe(Math.min(count, 8));
    expect(evidence.relationships.map(item => item.id)).toEqual(Array.from({ length: Math.min(count, 8) }, (_, i) => `e${i}`));
    expect(evidence.relationshipsTruncated).toBe(count > 8); expect(evidence.truncationReasons).toEqual(count > 8 ? ["relationship-limit"] : []);
  });
  it("counts a selected self-edge once", () => {
    const input = snapshot([{ id: "a", content: "  A stable source fact.  " }], [{ id: "self", source: "a", target: "a", relationship: "supports" }]);
    expect(analyzeDreamSnapshot(input, binding).proposals[0].evidence).toMatchObject({ relationshipKnownCount: 1, relationshipsTruncated: false });
  });
  it.each([16383, 16384])("admits a complete %i-byte generated proposal", size => expect(admitDreamProposals([sizedProposal(size)]).proposalCount).toBe(1));
  it("rejects an internally generated 16385-byte proposal", () => expect(() => admitDreamProposals([sizedProposal(16385)])).toThrow());
  it.each([261119, 261120, 261121])("enforces exact encoded-array endpoint %i", total => {
    const proposals = Array.from({ length: 16 }, (_, i) => sizedProposal(16000, i));
    proposals.push(sizedProposal(total - 16 * 16000 - 18, 16)); // 17 elements: 16 commas + 2 brackets.
    const result = admitDreamProposals(proposals);
    expect(result.knownProposalCount).toBe(17); expect(result.proposalCount).toBe(total <= 261120 ? 17 : 16);
    expect(result.truncationReasons).toEqual(total <= 261120 ? [] : ["result-byte-limit"]);
    expect(bytes(result.proposals)).toBeLessThanOrEqual(261120);
  });
  it("reports both count and byte reasons and stops at the first unfit proposal", () => {
    const proposals = Array.from({ length: 33 }, (_, i) => sizedProposal(i === 17 ? 2000 : 16000, i));
    const result = admitDreamProposals(proposals);
    expect(result.proposalCount).toBe(16); expect(result.knownProposalCount).toBe(33);
    expect(result.truncationReasons).toEqual(["proposal-limit", "result-byte-limit"]);
    expect(result.proposals.some(item => item.proposalId === proposals[17].proposalId)).toBe(false);
  });
  it("bounds worst escaping, evidence bytes and the final result envelope truthfully", () => {
    const id = (i: number) => `s${i.toString().padStart(2, "0")}` + "\u0001".repeat(250);
    const content = Array.from({ length: 5 }, (_, i) => `fact${i}` + "\u0001".repeat(234) + ".").join("\n");
    const sources = Array.from({ length: 33 }, (_, i) => ({ id: id(i), content }));
    const relationships: DreamRelationship[] = [];
    for (let i = 0; i < 33; i++) for (let distance = 1; distance <= 5; distance++) relationships.push({
      id: `e${i.toString().padStart(2, "0")}${distance}` + "\u0001".repeat(250), source: id(i), target: id((i + distance) % 33), relationship: "supports" });
    const input = snapshot(sources, relationships);
    // Distinct bounded outputs avoid accidental equality from the shared text.
    const outputs = input.notes.map((note, i) => ({ sourceId: note.id, analysis: { content: `proposal${i}` + "\u0001".repeat(190),
      keyFacts: Array.from({ length: 5 }, (_, n) => `fact${n}` + "\u0001".repeat(234) + ".") } }));
    const result = buildDreamResult(input, binding, outputs);
    expect(result.knownProposalCount).toBe(33); expect(result.proposalCount).toBeLessThan(32);
    expect(result.truncationReasons).toEqual(["proposal-limit", "result-byte-limit"]);
    for (const proposal of result.proposals) {
      expect(bytes(proposal)).toBeLessThanOrEqual(16384);
      expect(proposal.evidence.relationshipKnownCount).toBe(10);
      expect(proposal.evidence.truncationReasons).toEqual(["relationship-limit", "relationship-byte-limit"]);
      const { proposalId, ...fields } = proposal;
      expect(bytes({ domain: "ether.dream.proposal.v1", algorithm: binding.algorithm, planId: binding.planId, ...fields })).toBeLessThan(32768);
    }
    expect(bytes(result)).toBeLessThanOrEqual(262144);
    expect(bytes({ ...result, sourceCount: 128, knownProposalCount: 128, proposalCount: 32, proposals: [] }) - 2).toBeLessThan(1024);
  });
});
