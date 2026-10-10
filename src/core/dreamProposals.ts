import { createHash } from "node:crypto";
import type { DreamPlan } from "../types/dreamPlan.js";
import type { DreamCycleResult, DreamProposal, DreamProposalEvidence } from "../types/dreamAnalysis.js";
import type { DreamAnalysisSnapshot, DreamRelationship } from "./dreamPlan.js";
import { DreamInputError } from "./dreamRequest.js";
import { dreamBytes } from "./dreamSelection.js";
import { codeUnitCompare } from "./Tokenizer.js";

export interface DreamAnalysisOutput { content: string; keyFacts: string[] }
export type DreamAnalysisBinding = Pick<DreamPlan, "algorithm" | "planId" | "dependencyDigest" | "asOf">;

const LIMITS = Object.freeze({ units: 128, proposals: 32, edges: 8, proposalBytes: 16384,
  identityBytes: 32768, arrayBytes: 261120, resultBytes: 262144 });
const tooLarge = (): never => { throw new DreamInputError("Dream analysis exceeds its fixed execution bounds."); };
const edgeOrder = (a: DreamRelationship, b: DreamRelationship) => codeUnitCompare(a.id, b.id) || codeUnitCompare(a.source, b.source)
  || codeUnitCompare(a.target, b.target) || codeUnitCompare(a.relationship, b.relationship);
const fitsProposal = (fields: Omit<DreamProposal, "proposalId">): boolean => {
  try { dreamBytes({ proposalId: "0".repeat(64), ...fields }, LIMITS.proposalBytes); return true; }
  catch (error) { if (error instanceof DreamInputError) return false; throw error; }
};
const proposalFor = (sourceId: string, analysis: DreamAnalysisOutput, relationships: DreamRelationship[], planId: string): DreamProposal => {
  const incident = relationships.filter(edge => edge.source === sourceId || edge.target === sourceId).sort(edgeOrder);
  const max = Math.min(incident.length, LIMITS.edges);
  const fieldsFor = (take: number, byteLimited: boolean): Omit<DreamProposal, "proposalId"> => {
    const truncationReasons: DreamProposalEvidence["truncationReasons"] = [];
    if (incident.length > LIMITS.edges) truncationReasons.push("relationship-limit");
    if (byteLimited) truncationReasons.push("relationship-byte-limit");
    return { content: analysis.content, sourceIds: [sourceId], evidence: { keyFacts: [...analysis.keyFacts],
      relationships: incident.slice(0, take).map(edge => ({ id: edge.id, source: edge.source, target: edge.target, relationship: edge.relationship })),
      relationshipKnownCount: incident.length, relationshipsTruncated: take < incident.length, truncationReasons } };
  };
  let fields = fieldsFor(max, false);
  if (!fitsProposal(fields)) {
    // At most nine bounded encodings. Actual final reason/flag bytes are part
    // of every check, including the byte-limit reason when a prefix is cut.
    let take = max - 1;
    for (; take >= 0; take--) { fields = fieldsFor(take, true); if (fitsProposal(fields)) break; }
    if (take < 0) return tooLarge();
  }
  const proposalId = createHash("sha256").update(dreamBytes({ domain: "ether.dream.proposal.v1", algorithm: "ether.dream.v1",
    planId, ...fields }, LIMITS.identityBytes)).digest("hex");
  const proposal = { proposalId, ...fields }; dreamBytes(proposal, LIMITS.proposalBytes);
  return proposal;
}

/** Actual package-private admission stage; limits cannot be configured. */
export function admitDreamProposals(proposals: DreamProposal[]): Pick<DreamCycleResult, "knownProposalCount" | "proposalCount" | "proposals" | "proposalsTruncated" | "truncationReasons"> {
  if (proposals.length > LIMITS.units) return tooLarge();
  const retained: DreamProposal[] = []; let arrayBytes = 2, byteLimited = false;
  for (const proposal of proposals.slice(0, LIMITS.proposals)) {
    const length = dreamBytes(proposal, LIMITS.proposalBytes).byteLength + (retained.length ? 1 : 0);
    if (arrayBytes + length > LIMITS.arrayBytes) { byteLimited = true; break; }
    arrayBytes += length; retained.push(proposal);
  }
  const truncationReasons: DreamCycleResult["truncationReasons"] = [];
  if (proposals.length > LIMITS.proposals) truncationReasons.push("proposal-limit");
  if (byteLimited) truncationReasons.push("result-byte-limit");
  return { knownProposalCount: proposals.length, proposalCount: retained.length, proposals: retained,
    proposalsTruncated: retained.length < proposals.length, truncationReasons };
}

export function buildDreamResult(snapshot: DreamAnalysisSnapshot, binding: DreamAnalysisBinding,
  outputs: Array<{ sourceId: string; analysis: DreamAnalysisOutput }>): DreamCycleResult {
  if (snapshot.notes.length > LIMITS.units || snapshot.relationships.length > 1024 || outputs.length > LIMITS.units) return tooLarge();
  const sourceContents = new Set(snapshot.notes.map(note => note.content)), sourceIds = new Set(snapshot.notes.map(note => note.id));
  const equalityKeys = new Set<string>(), analyzedIds = new Set<string>(), proposals: DreamProposal[] = [];
  for (const output of [...outputs].sort((a, b) => codeUnitCompare(a.sourceId, b.sourceId))) {
    if (!sourceIds.has(output.sourceId) || analyzedIds.has(output.sourceId)) return tooLarge();
    analyzedIds.add(output.sourceId);
    const { content, keyFacts } = output.analysis;
    if (content.length > 200 || keyFacts.length > 5 || keyFacts.some(fact => fact.length < 8 || fact.length > 240)) return tooLarge();
    if (sourceContents.has(content)) continue;
    const equalityKey = Buffer.from(dreamBytes({ content, keyFacts: [...keyFacts] }, LIMITS.proposalBytes)).toString("utf8");
    if (equalityKeys.has(equalityKey)) continue;
    equalityKeys.add(equalityKey);
    proposals.push(proposalFor(output.sourceId, { content, keyFacts }, snapshot.relationships, binding.planId));
  }
  const result: DreamCycleResult = { algorithm: "ether.dream.v1", planId: binding.planId, dependencyDigest: binding.dependencyDigest,
    asOf: binding.asOf, sourceCount: snapshot.notes.length, ...admitDreamProposals(proposals) };
  dreamBytes(result, LIMITS.resultBytes);
  return result;
}
