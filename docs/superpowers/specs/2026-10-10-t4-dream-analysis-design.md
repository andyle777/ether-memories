# Ether Memories v0.7.0 — T4 Dream Analysis Design

**Status:** Proposed; awaiting Andy's approval. Production implementation has not started.

**Doctrine:** Dreams propose. Memory remains authoritative. Validate. Capture. Analyze. Propose. Never commit.

## 1. Authority, lineage, and approval

The T4 master handoff, section 4, requires a design specification and implementation plan before production changes, followed by a stop for Andy's approval. This document and [the implementation plan](../plans/2026-10-10-t4-dream-analysis.md) are that review gate. Approval must include the selector recapture ruling in section 3. No production code, dependency installation, implementation tests, release action, or PR publication is part of this design-only step.

| Lineage | Exact commit |
| --- | --- |
| Released v0.6.0 | 493c7b69813e71af749e34bbf950803eb8ee589b |
| Frozen T1 | 438a038f1aafbd636777f0dd7fb2c8eec3597e45 |
| Canonical security-clean T2 | 10ed0855bdee126bebbfa78efaaa2a7db6b26858 |
| Frozen T3; only valid T4 starting commit | a1da07bf65813e0c57e9368dec4c777be8e57cf3 |
| Separate T5 candidate; excluded from T4 | e8c45b8fde108e3d50241d8dd30c67118e460968 |

The isolated branch is `feat/v0.7.0-t4-dream-analysis`, in `.t4-dream-analysis`, created at the exact frozen T3 head. The outer mirror, released `.upstream` checkout, and prior worktrees remain separate. The superseded T2 commit 38876a0571582f79e4ddbc2b95be70f12ede95fc is not a starting point. T5 PR #24 is not merged, cherry-picked, or reproduced. T6 owns integration and the version bump. There are six tranches and no T7.

## 2. Inspected implementation and smallest useful policy

The inspected T3 implementation consists of `dreamRequest.ts`, `dreamSelection.ts`, `dreamPlan.ts`, public Dream plan types, Dream documentation, and Core/Durable delegation. T3 already has fixed-descriptor hostile request parsing, exact selector coverage, bounded source projection, selected-selected graph capture, canonical JSON, and SHA-256 identities. T4 will share those internals without changing public plan fields, hash preimages, selection behavior, or preview return ownership.

Condensation v2 separates pure `analyze` from mutating `commitAnalysis` and `condense`. Core's existing engine has a callback that creates canonical candidates, so Dream execution must use a private analyze-only adapter with a throwing candidate callback. T2's detached plain-data snapshots are the ownership model, but its explanatory inputs include fields Dream did not bind; Dream must not reuse those broader projections. Durable reads use one private readable StateRoot generation and existing CLOSED/RECOVERY_REQUIRED precedence.

Three grouping policies were considered:

| Policy | Tradeoff |
| --- | --- |
| One analysis unit per selected note — chosen | Direct source attribution, bounded existing Condensation semantics, simple ordering and duplicate handling. Short unchanged summaries can correctly produce no proposal. |
| One aggregate unit | Conceals individual source attribution and requires a new joined-text boundary and grouping rule. |
| Graph components or clustering | Introduces grouping semantics and work beyond the smallest useful v1; unnecessary for graph evidence. |

Each selected note is analyzed once, in code-unit ascending note-ID order. Graph relationships do not change grouping, content, or facts. There is no recursive input of generated proposals, candidate notes, previous results, Diary, or history.

## 3. Selector recapture ruling requiring approval

The handoff requires both exact T3 population coverage recapture (sections 11, 18, 19) and no unselected note reads (section 16). Frozen T3 cannot satisfy both literally for population selectors. Its `selectDreamNotes` scans eligible population text for query matching, tags for tag matching, and eligibility/creation fields for other population selectors. Even explicit IDs can require eligibility checks for requested IDs beyond a source-limit prefix. `knownCount` cannot be recomputed from the selected notes alone.

**Proposed ruling:** Permit only the existing bounded T3 selector matching/coverage reads during authoritative recapture. After recapture, retain only the selected dependency projection and coverage counts. Analysis, duplicate suppression, evidence, and returned output may use only that selected snapshot. Do not retain or expose nonselected text, tags, or matching IDs, and do not add any further nonselected reads. Explicit-ID recapture never scans unrelated notes. Graph capture still uses only selected-selected pair lookups.

This is an explicit interpretation for Andy to approve, not an implicit relaxation. A query coverage regression will demonstrate that a new nonselected match causes CONFLICT while its body never reaches analysis or output. Secret sentinels will distinguish coverage scanning from an illegal analysis read.

If every unselected read is prohibited, implementation stops: exact frozen T3 coverage recapture is impossible without a different trusted coverage mechanism or an authorized contract change. T4 must not silently disable selectors, trust caller counts, widen DreamPlan, or weaken freshness.

## 4. Public surface

Exactly one new behavioral method is added to Core and the Durable facade:

~~~ts
runDreamCycle(plan: DreamPlan): Result<DreamCycleResult>;
~~~

It is synchronous. Runtime input is treated as unknown despite the TypeScript parameter type. The root package exports three additional type-only interfaces; there are no new runtime exports or public execution helpers:

~~~ts
export interface DreamProposalEvidence {
  keyFacts: string[];
  relationships: Array<{
    id: string;
    source: string;
    target: string;
    relationship: string;
  }>;
  relationshipKnownCount: number;
  relationshipsTruncated: boolean;
  truncationReasons: Array<"relationship-limit" | "relationship-byte-limit">;
}

export interface DreamProposal {
  proposalId: string;
  content: string;
  sourceIds: string[];
  evidence: DreamProposalEvidence;
}

export interface DreamCycleResult {
  algorithm: "ether.dream.v1";
  planId: string;
  dependencyDigest: string;
  asOf: number;
  sourceCount: number;
  knownProposalCount: number;
  proposalCount: number;
  proposals: DreamProposal[];
  proposalsTruncated: boolean;
  truncationReasons: Array<"proposal-limit" | "result-byte-limit">;
}
~~~

`content` is the proposed summary. Tags, category, confidence, provenance, lifecycle, canonical MemoryNote IDs, and creation timestamps are omitted: none is needed to inspect this first proposal contract. `sourceIds` contains exactly one representative selected note ID. Relationship endpoints are selected note IDs, without a `memory:` prefix. There is no result ID: planId plus deterministic proposals supplies the existing consumer need. The result is not a receipt.

`sourceCount` means the number actually selected, not the total selector population. `knownProposalCount` counts distinct unsuppressed outputs across those selected sources before result admission; it makes no completeness claim about unselected sources. Empty selection succeeds with both proposal counts zero, empty proposals and truncation reasons, and false truncation.

Returned records and arrays are detached and caller-owned. They need not be frozen. No returned object aliases a canonical object, input plan, retained snapshot, or another run's result.

## 5. Hostile input and error precedence

Durable first captures its readable generation using the existing authority path. CLOSED wins before any plan processing. RECOVERY_REQUIRED then wins before any plan processing or clock access. Ready execution uses that single generation's notes and graph; it does not acquire writer authority, enqueue work, open files, or consult another generation. Core has no additional durable lifecycle state.

Plan validation then follows this fixed sequence:

1. Reject a Proxy before any prototype, descriptor, array, or key operation that could trap. Require a plain object with Object.prototype or null prototype.
2. Read only the own enumerable data descriptor for algorithm. Accessors, inherited/hidden fields, missing values, nonstrings, blank strings, and more than 256 UTF-16 code units are INVALID_INPUT. Any other bounded nonblank string than `ether.dream.v1` is UNSUPPORTED_SCHEMA immediately; no other plan field is read.
3. Project the remaining known fields into owned records by fixed descriptor lists. Unknown properties, symbols, accessors on unknown fields, and extra array properties are ignored without enumeration. Every recognized property must be an own enumerable data property. Every container is checked for Proxy before inspection. Arrays require ordinary Array.prototype, a valid own length, and own enumerable data indices; length is checked before touching elements. No iterator is invoked.
4. Check scalar lengths, array counts, positive safe-integer budgets, safe epochs, booleans and nonnegative safe-integer counts before normalization, UTF-8 encoding, or hashing. Hash strings must be exactly 64 lowercase hexadecimal characters. Epoch range is +/-8640000000000000; normalize negative zero to zero using T3 semantics.
5. All nine effective budgets are required and may only reduce the frozen T3 maxima. Normalize the owned selector using `normalizeDreamRequest` with explicit asOf and these budgets. Require canonical recognized selector fields: sorted unique ID/tag arrays, normalized nonempty query, legal date interval, and no incompatible recognized fields. Do not repair a noncanonical selector. Never fill an absent asOf from a clock.
6. Enforce the coverage invariants below. Only after this owned bounded projection exists, encode it with the existing bounded canonical encoder under maxPlanBytes. Never serialize the caller object or enumerate its keys.

Coverage invariants:

- selected IDs are nonblank T3 scalars of at most 256 code units, sorted and unique; array length is at most 128 and at most maxSources.
- selectedCount equals selected IDs length and `min(knownCount, maxSources)`.
- For population selectors, knownCount is at most maxPopulation (hard maximum 4096). For IDs, knownCount equals the normalized requested ID count (maximum 256), and selected IDs are its exact maxSources prefix; maxPopulation does not constrain explicit-ID request count in T3.
- selectionTruncated equals `knownCount > selectedCount`. Reasons are exactly `[]` or `["source-limit"]` correspondingly.
- relationshipCount is an integer from zero through maxRelationships, no greater than selectedCount squared, and zero for empty selection.
- No contradictory field reaches authoritative capture.

| Condition | Existing error code |
| --- | --- |
| Malformed/oversized/noncanonical hostile input or contradictory structure | INVALID_INPUT |
| Bounded well-formed unsupported algorithm discriminator | UNSUPPORTED_SCHEMA |
| Supported structurally valid plan differs from recomputed authoritative plan | CONFLICT |
| Expected recapture failure: missing/ineligible source, changed matching coverage, or bound exceeded by changed authoritative dependencies | CONFLICT |
| Closed Durable runtime | CLOSED |
| Durable runtime needs recovery | RECOVERY_REQUIRED |
| Unexpected internal exception during capture, hashing, or analysis | UNKNOWN_ERROR |

Catch expected DreamInputError at the recapture boundary and collapse it into a fixed stale-plan CONFLICT message. Unexpected exceptions return a fixed UNKNOWN_ERROR message, without raw exception, source content, or intermediate coverage details. No partial proposals escape an error. An unsupported algorithm is classified before all other plan fields, but after Durable authority.

## 6. One captured dependency closure

The execution pipeline is authority check → cheap owned plan validation → bounded T3 recapture → owned plain snapshot → recomputed plan and digest → full comparison → analyze that same snapshot → bounded proposals → detached result.

The snapshot contains only the normalized request, coverage, selected note projections and sorted selected-selected relationships. Notes contain id, content, unique code-unit-sorted tags, active status, createdAt epoch, and expiresAt epoch/null. Relationships contain id, source, target, and relationship. There are no Dates, MemoryNote references, Map, Set, Graphology objects, runtime handles, class instances, or writer objects.

T3 dependency hashing must retain its exact flat preimage:

~~~ts
{
  domain: "ether.dream.dependencies.v1",
  algorithm: "ether.dream.v1",
  ...request,
  coverage,
  notes,
  relationships
}
~~~

The plan hash retains `{ domain: "ether.dream.plan.v1", ...fields }`, where fields is the frozen T3 plan without planId. Do not nest request, insert a snapshot version, add package version, or change either preimage. Compare the complete owned caller plan with the newly built plan, including every coverage, selector, budget and graph value, not only the two hash strings. Hashes are comparison data, not authorization tokens.

Internal capture can be frozen after ownership transfer, but preview must continue returning a separately owned mutable plan as before. Freezing T4 data must never freeze a T3 public return through an alias. The internal analysis function accepts only a snapshot and its recomputed plan; it has no notes/graph/Diary owners or live-read callbacks. No live authoritative read occurs after the identity comparison succeeds.

Excluded fields remain summary, category, source, provenance, importance, confidence, pinning, arbitrary metadata, updatedAt, graph node labels/data, edge data, Diary, persistence metadata, package version and global revision. Their changes cannot influence proposals or scoped freshness. A dependency expiry is interpreted at plan.asOf, never the current wall clock. Population matching counts retain T3 semantics under the explicit ruling in section 3.

## 7. Pure deterministic analysis

A private adapter constructs CondensationEngine with a candidate callback that throws. It calls only `analyze(content, undefined, config)`, with the fixed configuration:

~~~ts
{
  maxFacts: 5,
  minFactLength: 8,
  maxFactLength: 240,
  summaryLength: 200,
  maxTags: 8
}
~~~

Undefined analysis for blank content produces no proposal. Project only summary and keyFacts; candidate lifecycle, provenance, confidence, category and tags from the internal analysis are not copied. Existing fact extraction and within-source fact deduplication remain Condensation v2 rules. They do not add a cross-proposal fuzzy matcher.

Dream's adapter repairs one derived-text boundary: Condensation's first-197-code-unit summary slice can end with a high surrogate before its appended `...`. For a shortened summary only, remove that one dangling high surrogate before `...`. Do not append the missing low surrogate or read more text; do not change global Condensation behavior. This retains valid Unicode and the maximum 200 code units. T3's canonical encoder already rejects unpaired surrogates in original bound content. Facts are not sliced; their existing length filtering is preserved. An astral character crossing the summary cut is a required golden regression.

No clocks, randomness, localeCompare, network, models, embeddings, RAG, environment options, global revision, or package version participate. All sort operations use codeUnitCompare. Analysis processes at most the selected maxSources, hard maximum 128, with source text already bounded by T3 (65536 UTF-8 bytes per note and 1048576 canonical dependency bytes total).

## 8. Exact duplicates, order, and IDs

Apply two boundary-safe rules:

1. Suppress a proposed content string if it is literally equal to any selected snapshot note's content string. Do not trim, normalize case, tokenize, or inspect unrelated canonical memory for this comparison.
2. Compare output semantics using the canonical JSON bytes of `{ content, keyFacts }`. Equal bytes are duplicates. Different literal content or a different facts array is not a duplicate. Source IDs, proposal IDs and relationship origin evidence are deliberately excluded from this equality key.

The lowest code-unit source ID producing a duplicate output is the retained representative. Do not union origins or imply that every duplicate source contributes evidence. Relationships and sourceIds describe that representative exactly. This avoids growing provenance groups and makes repeated identical units deterministic. Near-but-not-equal outputs remain separate. Canonical bytes, not a hash alone, determine equality.

Retained proposals stay in representative source-ID order. Evidence edges retain T3's sort by id, source, target, relationship. Graph insertion order and hash order are irrelevant.

Compute each proposalId as lowercase SHA-256 of bounded canonical JSON:

~~~ts
{
  domain: "ether.dream.proposal.v1",
  algorithm: "ether.dream.v1",
  planId,
  ...proposalWithoutProposalId
}
~~~

The payload includes content, sourceIds, and the complete final bounded evidence, including known count and truncation. No ordinal, nonce, clock, random value, machine identity, or canonical MemoryNote identity is generated. Domain preimage encoding uses the existing depth/node bounds and a 32768-byte ceiling; final proposal encoding uses the smaller limit below. Different plan binding changes proposal IDs even if proposed text is equal.

## 9. Evidence and exact execution bounds

These fixed limits belong to `ether.dream.v1` and are not configurable or added to DreamBudgets:

| Limit | Exact value |
| --- | --- |
| Analysis units | Actual selected count; at most 128 |
| Returned proposals | 32 |
| Proposed content | At most 200 UTF-16 code units |
| Key facts per proposal | At most 5, each 8–240 UTF-16 code units |
| Source IDs per proposal | Exactly 1, at most 256 code units |
| Evidence relationships per proposal | At most 8 |
| Each relationship scalar | At most 256 UTF-16 code units, inherited from T3 |
| Complete encoded proposal | At most 16384 bytes |
| Proposal-ID preimage encoding | At most 32768 bytes |
| Complete encoded result | At most 262144 bytes |
| Reserved result envelope | 1024 bytes |
| Encoded proposals array admission | At most 261120 bytes, including brackets and commas |
| Canonical encoding depth/nodes | 16 / 65536, existing T3 helper |

Evidence keyFacts are the representative source's ordered Condensation facts. Relevant relationships are captured edges whose source or target is that representative; both endpoints must already be selected. A self-edge is counted once. relationshipKnownCount is the exact number of such edges in the bounded snapshot (at most 1024), before evidence admission. No neighboring body, edge metadata, inferred explanation, graph proposal, or invented provenance is included.

Admit a canonical edge prefix, stopping at 8 edges or before the next edge would make the complete final proposal exceed 16384 bytes. For each check, include a reserved 64-character proposalId and the actual final counts, flags, and reason list. Count-limit reason applies when known incident edges exceed 8. Byte-limit reason applies when the byte ceiling shortens the count-limited prefix. Reasons use the fixed order relationship-limit then relationship-byte-limit. relationshipsTruncated equals returned relationship length less than relationshipKnownCount. An empty relationship prefix is legal and truthful.

The base proposal fits 16384 bytes even with the maximum JSON escaping of its bounded content, facts and one source ID; test that bound independently. Compute its ID after final evidence admission. The preimage ceiling includes the domain/algorithm/plan fields as well as the bounded proposal. Never encode caller data or unrestricted analysis objects.

Evaluate all at most 128 sources to establish the exact unsuppressed distinct proposal count. Keep only bounded generated projections and canonical equality keys; the proposal payload bound is at most 128 x 16384 = 2097152 encoded bytes. Equality keys are separately bounded by the same order of work. This is a serialization/work ceiling, not a claim about JavaScript heap allocation. Do not retain unrelated source projections or arbitrary Condensation fields.

Admit the proposal prefix subject first to 32 proposals and then to the 261120-byte encoded-array limit. Include both array brackets and each comma. Stop at the first proposal that cannot fit; do not skip it to pack later smaller proposals. The 1024-byte envelope reserve exceeds the fixed field/hash/count/reason maximum; verify its worst case with a test and finally encode the whole result under 262144 bytes. If knownProposalCount exceeds 32, include proposal-limit. If the byte bound shortens the count-limited prefix, include result-byte-limit. Reasons use that fixed order. proposalCount equals proposals.length; proposalsTruncated equals proposalCount less than knownProposalCount. Evidence truncation is nested and does not itself imply proposalsTruncated.

N-1/N/N+1 tests apply to reachable count, evidence and byte admission boundaries. For derived summary/fact limits test the exact transformation/filter, including Unicode boundaries; do not expand public limits just to reach an otherwise impossible internal envelope overflow.

## 10. Internal file and interface boundaries

| File | Responsibility |
| --- | --- |
| `src/types/dreamAnalysis.ts` | The three public type-only interfaces |
| `src/core/dreamPlan.ts` | Shared T3 capture and exact plan construction; existing preview stays unchanged |
| `src/core/dreamValidation.ts` | Fixed-descriptor hostile plan validation and owned canonical projection |
| `src/core/dreamAnalysis.ts` | Private analyze-only adapter and selected-only proposal traversal |
| `src/core/dreamProposals.ts` | Fixed output limits, exact deduplication, evidence admission, proposal identity, result admission |
| `src/core/dreamExecution.ts` | Recapture, recomputation, full comparison and error boundary |
| Core, Durable and root type index | One method delegation and three type exports |

Internal types are DreamRelationship, DreamCapturedDependencies, and DreamAnalysisOutput. DreamCapturedDependencies has `{ request: DreamRequest; coverage: Pick<DreamPlan, "selectedSourceIds" | "selectedCount" | "knownCount" | "selectionTruncated" | "truncationReasons">; notes: DreamNoteDependency[]; relationships: DreamRelationship[] }`. DreamAnalysisOutput has `{ content: string; keyFacts: string[] }`. They are not public exports or package subpaths.

Exact internal signatures:

~~~ts
captureDreamDependencies(notesOwner: object, graphOwner: object,
  request: DreamRequest): DreamCapturedDependencies;
buildDreamPlan(capture: DreamCapturedDependencies): DreamPlan;
validateDreamPlan(input: unknown): Result<DreamPlan>;
analyzeDreamContent(content: string): DreamAnalysisOutput | undefined;
buildDreamResult(capture: DreamCapturedDependencies, plan: DreamPlan,
  outputs: Array<{ sourceId: string; analysis: DreamAnalysisOutput }>): DreamCycleResult;
analyzeDreamSnapshot(capture: DreamCapturedDependencies,
  plan: DreamPlan): DreamCycleResult;
runDreamCycle(notesOwner: object, graphOwner: object,
  input: unknown): Result<DreamCycleResult>;
~~~

Capture/build may throw expected DreamInputError as existing preview does. The public execution boundary maps errors per section 5. The analysis/output modules cannot import inspectionSources, Notes, Diary, MindGraph, Durable, or persistence authority; canonical encoding is the only existing persistence utility used through dreamBytes. A new public hook or analysis configuration is not needed for tests.

## 11. Preservation and verification

Package version stays 0.6.0. Dream algorithm stays ether.dream.v1. Zero new dependencies; Vitest 4.1.11, Vite 7.3.6 and source-map-js 1.2.2 remain, with Tinypool absent. Package and lockfile changes are unnecessary. Preserve store ether.memory_store.v0.3, WAL/receipt/HEAD/checkpoint v1, MemoryContext ether.memory_context.v1, Portable Record ether.portable_record.v1. No migrations, persisted Dream fields, WAL operations, cache, receipts, history, scheduler, background work, accept/reject/commit/promote APIs or graph proposals.

All 840 inherited T3 tests remain collected, active and substantively unchanged. Two existing exact facade-member allowlists may add only runDreamCycle and update the explicit expected member count from 23 to 24; this is required contract extension, not generic allowlist relaxation. No inherited skips/todos or weaker assertions are permitted. Existing Dream plan goldens and all five frozen fixture blobs must remain identical: persistence-wire-v1, portable-record-v1, retrieval-golden-v1, store-v0.3 and wal-wire-v1.

New tests must cover hostile parsing without getter/proxy traps or caller key enumeration; algorithm and Durable authority precedence; structural contradictions; selected and population staleness; irrelevant fields and unrelated explicit-ID edits; single snapshot TOCTOU; no second authoritative read; secret boundary sentinels; replay; insertion order and locale independence; fixed semantic ID goldens across Node 22/24 and Windows/Linux; duplicates and near duplicates; empty success; byte/count/evidence limits; caller ownership; complete logical mutation equality; and Condensation commit/candidate traps.

Durable tests additionally compare exact store-file hashes, tip, WAL bytes, receipt/checkpoint identity, export state, lifecycle, writer and GC state before/after successful, empty, repeated, rejected and truncated execution. Instrument existing internal IO and file operations to fail if Dream opens/reads/writes/syncs/renames files or acquires writer authority. Reuse existing internal test injection patterns; no production diagnostic API.

Packed consumer verification must exercise preview and run on Core/Durable, compile the three result types, retain T2 checks, verify every new internal module is blocked, and retain persistence and T5 containment. Runtime export names stay unchanged. Facade own members increase only by runDreamCycle. Update exact packed inventory only for actual new built files; record that delta rather than guessing a package count.

After approval and implementation, the exact final candidate must pass clean installs and all local gates on Node 22 and Node 24: verify:toolchain, typecheck, all tests, verify:workers, build, pack, verify:packed, full audit and production audit. Both audits must report zero on both Node versions. Every stage of all four Ubuntu/Windows x Node 22/24 CI jobs must pass. A fresh independent hostile review must review that exact branch-head SHA after gates pass. Material fixes require a new SHA, affected verification and refreshed exact-SHA review; a green receipt for an earlier candidate is insufficient.

The eventual section-72 report must include exact lineage/candidate/branch/PR, public schema, all design decisions and limits, freshness and TOCTOU proof, analyze-only proof, determinism, mutation evidence, inherited/new/total tests and skips/todos/warnings, four audits, four CI outcomes and run ID, packed containment, persistence/fixture identity, review findings and deferred scope. Only then may the final declaration be T4 CLOSED / GREEN / FROZEN. Record the canonical T4 SHA and stop without a merge or T5/T6 work.

## 12. Review outcome for this document

The design fixes the public schema, grouping, source representation, graph evidence, exact equality, proposal ID preimage, every new execution bound, truncation semantics, empty success, error mapping, Unicode summary cut, ownership and internal interfaces. The sole unresolved authority decision is the recapture interpretation in section 3; it must be approved with this design before execution. No new T3 schema or persistence change is proposed.
