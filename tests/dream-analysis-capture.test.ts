import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDreamPlan, captureDreamDependencies } from "../src/core/dreamPlan.js";
import { normalizeDreamRequest } from "../src/core/dreamRequest.js";
import type { DreamSelector } from "../src/types/dreamPlan.js";
import { requireValue, seedDreamCore } from "./helpers/dream-analysis.js";

const sources = [{ id: "b", content: "alpha beta", tags: ["shared", "shared"] }, { id: "a", content: "alpha beta", tags: ["shared"] }];
const edges = [{ id: "z", source: "a", target: "a", relationship: "related_to" }, { id: "ab", source: "a", target: "b", relationship: "supports" }];
// Independent test encoder for small, owned golden objects. It does not call
// the production Dream canonical/hash builders and spells out the flat shape.
const canonical = (input: any): string => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
  : input !== null && typeof input === "object" ? `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`
  : JSON.stringify(input);
const sha = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");

describe("T4 exact shared frozen T3 capture", () => {
  it.each([
    { kind: "ids", ids: ["b", "a"] }, { kind: "tags", tags: ["shared"] }, { kind: "query", query: "ALPHA beta" },
    { kind: "date-window", from: 10, to: 11 }, { kind: "all_active" }
  ] as DreamSelector[])("rebuilds the unchanged preview for %j", selector => {
    const core = seedDreamCore(sources, edges), request = normalizeDreamRequest(selector, { asOf: 100 });
    const preview = requireValue(core.previewDreamCycle(selector, { asOf: 100 }));
    const captured = captureDreamDependencies(core.notes, core.graph, request);
    expect(buildDreamPlan(captured)).toEqual(preview);
    expect(captured.notes).toEqual([
      { id: "a", content: "alpha beta", tags: ["shared"], status: "active", createdAt: 10, expiresAt: null },
      { id: "b", content: "alpha beta", tags: ["shared"], status: "active", createdAt: 10, expiresAt: null }
    ]);
    expect(captured.relationships).toEqual([{ id: "ab", source: "a", target: "b", relationship: "supports" },
      { id: "z", source: "a", target: "a", relationship: "related_to" }]);
  });
  it("preserves the exact flat dependency and plan preimages independently", () => {
    const core = seedDreamCore(sources, edges), request = normalizeDreamRequest({ kind: "ids", ids: ["a", "b"] }, { asOf: 100 });
    const plan = buildDreamPlan(captureDreamDependencies(core.notes, core.graph, request));
    const budgets = { maxPopulation: 4096, maxSources: 128, maxTags: 64, maxContentBytes: 65536,
      maxNoteDependencyBytes: 131072, maxSelectionBytes: 4194304, maxDependencyBytes: 1048576, maxRelationships: 1024, maxPlanBytes: 65536 };
    const coverage = { selectedSourceIds: ["a", "b"], selectedCount: 2, knownCount: 2, selectionTruncated: false, truncationReasons: [] };
    const dependencyDigest = sha({ domain: "ether.dream.dependencies.v1", algorithm: "ether.dream.v1",
      selector: { kind: "ids", ids: ["a", "b"] }, asOf: 100, budgets, coverage,
      notes: [{ id: "a", content: "alpha beta", tags: ["shared"], status: "active", createdAt: 10, expiresAt: null },
        { id: "b", content: "alpha beta", tags: ["shared"], status: "active", createdAt: 10, expiresAt: null }],
      relationships: [{ id: "ab", source: "a", target: "b", relationship: "supports" }, { id: "z", source: "a", target: "a", relationship: "related_to" }] });
    const fields = { algorithm: "ether.dream.v1", asOf: 100, selector: { kind: "ids", ids: ["a", "b"] }, ...coverage,
      dependencyDigest, budgets, graph: { relationshipCount: 2 } };
    expect(plan.dependencyDigest).toBe(dependencyDigest);
    expect(plan.planId).toBe(sha({ domain: "ether.dream.plan.v1", ...fields }));
  });
  it("owns capture and every public plan independently of request, state and each other", () => {
    const core = seedDreamCore(sources, edges), before = core.exportData();
    const request = normalizeDreamRequest({ kind: "ids", ids: ["a", "b"] }, { asOf: 100 });
    const capture = captureDreamDependencies(core.notes, core.graph, request), original = structuredClone(capture);
    const first = buildDreamPlan(capture), second = buildDreamPlan(capture);
    first.selectedSourceIds.push("foreign"); first.budgets.maxSources = 1; first.graph.relationshipCount = 0;
    if (first.selector.kind === "ids") first.selector.ids.push("other");
    expect(buildDreamPlan(capture)).toEqual(second); expect(capture).toEqual(original);
    if (request.selector.kind === "ids") request.selector.ids.push("unowned"); request.budgets.maxSources = 1;
    expect(capture).toEqual(original);
    capture.notes[0].content = "changed"; capture.notes[0].tags.push("changed"); capture.relationships[0].relationship = "changed";
    expect(core.exportData()).toEqual(before);
    expect(requireValue(core.previewDreamCycle({ kind: "ids", ids: ["a", "b"] }, { asOf: 100 }))).toEqual(second);
  });
  it("keeps source-limit coverage and excludes nonselected projections and edges", () => {
    const core = seedDreamCore(sources, edges), request = normalizeDreamRequest({ kind: "all_active" }, { asOf: 100, budgets: { maxSources: 1 } });
    const capture = captureDreamDependencies(core.notes, core.graph, request);
    expect(capture.coverage).toEqual({ selectedSourceIds: ["a"], selectedCount: 1, knownCount: 2, selectionTruncated: true, truncationReasons: ["source-limit"] });
    expect(capture.notes.map(note => note.id)).toEqual(["a"]);
    expect(capture.relationships).toEqual([{ id: "z", source: "a", target: "a", relationship: "related_to" }]);
    expect(buildDreamPlan(capture)).toEqual(requireValue(core.previewDreamCycle({ kind: "all_active" }, { asOf: 100, budgets: { maxSources: 1 } })));
  });
  it("preserves empty selection and full downward budget normalization", () => {
    const core = seedDreamCore([]), request = normalizeDreamRequest({ kind: "all_active" }, { asOf: 100,
      budgets: { maxPopulation: 1, maxSources: 1, maxTags: 1, maxContentBytes: 1, maxNoteDependencyBytes: 256,
        maxSelectionBytes: 1, maxDependencyBytes: 1024, maxRelationships: 1, maxPlanBytes: 1024 } });
    const capture = captureDreamDependencies(core.notes, core.graph, request);
    expect(capture.notes).toEqual([]); expect(capture.relationships).toEqual([]);
    expect(buildDreamPlan(capture)).toEqual(requireValue(core.previewDreamCycle(request.selector, { asOf: request.asOf, budgets: request.budgets })));
  });
  it("ignores insertion order and preserves code-unit edge order", () => {
    const first = seedDreamCore(sources, edges), second = seedDreamCore([...sources].reverse(), [...edges].reverse());
    const request = normalizeDreamRequest({ kind: "all_active" }, { asOf: 100 });
    expect(captureDreamDependencies(first.notes, first.graph, request)).toEqual(captureDreamDependencies(second.notes, second.graph, request));
  });
});
