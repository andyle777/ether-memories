import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDreamPlan } from "../src/core/dreamValidation.js";
import { DREAM_BUDGETS } from "../src/core/dreamRequest.js";
import { planFor, requireValue, seedDreamCore } from "./helpers/dream-analysis.js";

const plan = () => planFor(seedDreamCore([{ id: "a", content: "alpha" }, { id: "b", content: "beta" }]), { kind: "ids", ids: ["a", "b"] });
const invalid = (input: unknown) => expect(validateDreamPlan(input)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
afterEach(() => vi.restoreAllMocks());

describe("T4 cheap hostile plan validation", () => {
  it("owns every recognized nested field and ignores unknown fields without reading them", () => {
    const input = plan();
    Object.defineProperty(input, "unknown", { get() { throw Error("unknown getter"); } });
    Object.defineProperty(input.selector, Symbol.iterator, { get() { throw Error("unknown symbol"); } });
    Object.defineProperty(input.selectedSourceIds, "unknown", { get() { throw Error("array extra"); } });
    const result = requireValue(validateDreamPlan(input));
    expect(result).toEqual(plan());
    result.selectedSourceIds.push("other"); result.budgets.maxSources = 1;
    expect(input.selectedSourceIds).toEqual(["a", "b"]); expect(input.budgets.maxSources).toBe(128);
  });
  it("accepts null-prototype records", () => {
    const input = plan(); Object.setPrototypeOf(input, null); Object.setPrototypeOf(input.graph, null);
    expect(validateDreamPlan(input).ok).toBe(true);
  });
  it.each([null, undefined, [], 1, "plan", new Date(), new (class Plan {})()])("rejects a non-plain plan %j", invalid);
  it("rejects all proxy containers before any trap, including revoked proxies", () => {
    let traps = 0;
    const wrap = (target: object) => new Proxy(target, { get() { traps++; throw Error("get"); },
      getPrototypeOf() { traps++; throw Error("prototype"); }, ownKeys() { traps++; throw Error("keys"); },
      getOwnPropertyDescriptor() { traps++; throw Error("descriptor"); } });
    invalid(wrap(plan()));
    for (const field of ["selector", "budgets", "graph", "selectedSourceIds", "truncationReasons"] as const) {
      const input: any = plan(); input[field] = wrap(input[field]); invalid(input);
    }
    const input: any = plan(); input.selector.ids = wrap(input.selector.ids); invalid(input);
    const revoked = Proxy.revocable(plan(), {}); revoked.revoke(); invalid(revoked.proxy);
    expect(traps).toBe(0);
  });
  it.each(["algorithm", "planId", "asOf", "selector", "selectedSourceIds", "selectedCount", "knownCount", "selectionTruncated", "truncationReasons", "dependencyDigest", "budgets", "graph"])("rejects accessor, hidden, absent and inherited %s", field => {
    const getter = plan(); Object.defineProperty(getter, field, { get() { throw Error("getter"); } }); invalid(getter);
    const hidden: any = plan(); Object.defineProperty(hidden, field, { value: hidden[field], enumerable: false }); invalid(hidden);
    const absent: any = plan(); delete absent[field]; invalid(absent);
    const inherited: any = plan(); const value = inherited[field]; delete inherited[field]; Object.setPrototypeOf(inherited, { [field]: value }); invalid(inherited);
  });
  it("classifies unsupported algorithms before reading any other field", () => {
    let touches = 0; const input = { algorithm: "ether.dream.v2", get planId() { touches++; throw Error("trap"); } };
    expect(validateDreamPlan(input)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_SCHEMA" } });
    expect(touches).toBe(0);
  });
  it.each([undefined, "", " ", 1, "x".repeat(257)])("rejects malformed algorithm %j", algorithm => invalid({ algorithm }));
  it.each(["planId", "dependencyDigest"])("rejects malformed %s", field => {
    for (const bad of [null, 1, "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), " ".repeat(1000000)]) invalid({ ...plan(), [field]: bad });
  });
  it.each([NaN, Infinity, -Infinity, 1.5, 8640000000000001, "100", null])("rejects impossible epoch %j", asOf => invalid({ ...plan(), asOf }));
  it("normalizes negative zero without consulting a clock", () => {
    const input = plan(); input.asOf = -0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("clock"); });
    expect(Object.is(requireValue(validateDreamPlan(input)).asOf, -0)).toBe(false); expect(clock).not.toHaveBeenCalled();
  });
  it.each(Object.keys(DREAM_BUDGETS))("requires a bounded own data budget %s", key => {
    for (const bad of [undefined, 0, -1, 1.5, NaN, Infinity, "1", (DREAM_BUDGETS as any)[key] + 1]) {
      const input: any = plan(); input.budgets[key] = bad; invalid(input);
    }
    const input: any = plan(); Object.defineProperty(input.budgets, key, { get() { throw Error("budget"); } }); invalid(input);
  });
  it("bounds arrays before reading indices and rejects sparse/hidden/accessor elements", () => {
    for (const [field, count] of [["selectedSourceIds", 129], ["truncationReasons", 2]] as const) {
      const input: any = plan(); const list = Array(count); Object.defineProperty(list, "0", { get() { throw Error("index"); } }); input[field] = list; invalid(input);
    }
    for (const make of [() => Array(2), () => Object.defineProperty(["a", "b"], "0", { get() { throw Error("index"); } }),
      () => Object.defineProperty(["a", "b"], "0", { value: "a", enumerable: false }), () => Object.setPrototypeOf(["a", "b"], null)]) {
      invalid({ ...plan(), selectedSourceIds: make() });
    }
  });
  it.each([["a", "a"], ["b", "a"], ["a", ""], ["a", "x".repeat(257)], ["a", "\ud800"]])("rejects noncanonical selected IDs %j", selectedSourceIds => invalid({ ...plan(), selectedSourceIds }));
  it.each([
    { selectedCount: 1 }, { knownCount: -1 }, { knownCount: 1 }, { knownCount: 3 }, { selectedCount: 2.5 },
    { selectionTruncated: true }, { truncationReasons: ["source-limit"] }, { truncationReasons: ["other"] },
    { graph: { relationshipCount: -1 } }, { graph: { relationshipCount: 5 } }, { graph: { relationshipCount: 1025 } },
    { graph: { relationshipCount: NaN } }, { selectionTruncated: "false" }
  ])("rejects contradictory coverage %j", patch => invalid({ ...plan(), ...patch }));
  it("checks exact source-limit prefix and keeps explicit IDs independent of maxPopulation", () => {
    const core = seedDreamCore([{ id: "a", content: "alpha" }, { id: "b", content: "beta" }]);
    const input = requireValue(core.previewDreamCycle({ kind: "ids", ids: ["a", "b"] }, { asOf: 100, budgets: { maxSources: 1, maxPopulation: 1 } }));
    expect(validateDreamPlan(input).ok).toBe(true);
    invalid({ ...input, selectedSourceIds: ["b"] }); invalid({ ...input, knownCount: 3 });
  });
  it("bounds population coverage and enforces an empty graph for empty selection", () => {
    const core = seedDreamCore([]); const empty = planFor(core, { kind: "all_active" });
    expect(validateDreamPlan(empty).ok).toBe(true); invalid({ ...empty, graph: { relationshipCount: 1 } });
    invalid({ ...empty, knownCount: 4097 });
  });
  it.each([
    { kind: "ids", ids: ["b", "a"] }, { kind: "ids", ids: ["a", "a", "b"] },
    { kind: "tags", tags: ["z", "a"] }, { kind: "query", query: "BETA Alpha" },
    { kind: "all_active", query: "alpha" }, { kind: "date-window", from: 20, to: 10 },
    { kind: "query", query: "x".repeat(4097) }, { kind: "ids", ids: Array(257).fill("a") }
  ])("rejects noncanonical/mixed selectors %j", selector => invalid({ ...plan(), selector }));
  it("requires enumerable own selector array elements before T3 normalization", () => {
    const input = plan(); if (input.selector.kind !== "ids") throw Error("fixture");
    Object.defineProperty(input.selector.ids, "0", { value: "a", enumerable: false }); invalid(input);
  });
  it("ignores a million unknown keys without enumerating caller containers", () => {
    const input: any = plan(); for (let n = 0; n < 1000000; n++) input[`unknown${n}`] = n;
    const original = Object.keys;
    vi.spyOn(Object, "keys").mockImplementation(value => { if (value === input) throw Error("caller enumeration"); return original(value); });
    expect(validateDreamPlan(input).ok).toBe(true);
  });
  it("enforces maxPlanBytes on the bounded projected plan", () => invalid({ ...plan(), budgets: { ...DREAM_BUDGETS, maxPlanBytes: 1 } }));
});
