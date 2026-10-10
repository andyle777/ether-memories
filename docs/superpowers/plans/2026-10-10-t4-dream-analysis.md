# Ether Memories T4 Dream Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a frozen T3 DreamPlan as deterministic, bounded, detached proposals with zero canonical or persistence mutation.

**Architecture:** Share T3's exact capture and hashing path, validate caller data through fixed descriptors, and compare a recomputed plan before analyzing the same owned snapshot. One selected note becomes one analysis unit through a private Condensation analyze-only adapter; selected relationships are evidence only. Fixed v1 ceilings bound proposals, exact equality keys, evidence and result bytes.

**Tech Stack:** Existing TypeScript/ESM, Node built-in crypto/util, existing bounded canonical JSON, Condensation v2, codeUnitCompare, Graphology, Vitest 4.1.11. Node 22 and 24 on Windows and Ubuntu; no new dependencies.

**Spec:** [2026-10-10-t4-dream-analysis-design.md](../specs/2026-10-10-t4-dream-analysis-design.md). Read it completely before execution. Status: proposed; Andy's approval is required. No implementation step below is authorized before approval, including the explicit selector recapture ruling.

## Global Constraints

- Start from frozen T3 a1da07bf65813e0c57e9368dec4c777be8e57cf3 on feat/v0.7.0-t4-dream-analysis; use the existing isolated .t4-dream-analysis worktree.
- Package version stays 0.6.0; algorithm stays ether.dream.v1; all T3 public fields, selector behavior and hash identities remain frozen.
- Add exactly runDreamCycle(plan: DreamPlan): Result<DreamCycleResult> on Core/Durable and three type-only exports: DreamCycleResult, DreamProposal, DreamProposalEvidence.
- Approve the spec section-3 ruling before work: existing bounded T3 matching/coverage reads only during recapture; analysis, duplicates, evidence and output strictly selected-only.
- No acceptance, promotion, persistence, history, caching, graph proposals, scheduling, background service, model calls, embeddings, RAG or new dependency.
- Vitest 4.1.11, Vite 7.3.6, source-map-js 1.2.2; Tinypool absent; four Node 22/24 full/production audits zero.
- Preserve store ether.memory_store.v0.3, WAL/receipt/HEAD/checkpoint v1, MemoryContext ether.memory_context.v1 and Portable Record ether.portable_record.v1.
- All 840 inherited tests remain active. Only the two exact facade allowlists may add runDreamCycle and the expected 23-to-24 count; retain every other assertion.
- Frozen fixture blobs persistence-wire-v1, portable-record-v1, retrieval-golden-v1, store-v0.3 and wal-wire-v1 remain identical.
- Do not merge/cherry-pick/reproduce T5 e8c45b8fde108e3d50241d8dd30c67118e460968. No T5 integration, T6 release work, T7 or automatic merge.
- No fresh clock after input: explicit plan.asOf only. No random IDs, localeCompare, unselected graph traversal, unbound metadata, live read after successful comparison, or canonical candidate callback.

## Review Focus

1. An unsupported algorithm alongside hostile remaining getters must return UNSUPPORTED_SCHEMA without touching them; Durable authority wins first. Tasks 1 and 5 pin precedence.
2. An astral character across Condensation's 197-code-unit cut must produce valid bounded Unicode without changing global Condensation. Task 3 pins the adapter rule.
3. Equal semantic outputs with different graph origins must collapse to the lowest-ID representative with truthful representative-only evidence. Task 3 pins equality and source attribution.
4. A canonical change triggered during the first analyze call must not change later units in that same run; a later run must return CONFLICT. Task 4 pins the validated snapshot.
5. Maximum JSON escaping and simultaneous count/byte truncation must leave truthful counts/reasons and no overflowing final encoding. Task 3 pins all final envelopes.

---

## Execution method and initial gate

Recommend Native execution using superpowers:executing-plans: the tasks share tight capture/schema interfaces, and one fresh exact-SHA hostile reviewer supplies the final independent gate. Continue the existing session/worktree after Andy approves. Do not dispatch implementation agents unless Andy chooses subagent-driven execution; the final independent review is explicitly required by the handoff.

- [ ] Record Andy's approval of both documents and the recapture interpretation. If every unselected read is forbidden, stop with the frozen-T3 coverage impossibility proof; do not implement a partial selector set.
- [ ] Confirm branch, frozen base ancestor, clean starting docs-only diff, toolchain locations and no T5 commit in ancestry. Preserve all existing worktrees and the outer mirror.
- [ ] Install with npm ci after approval, run the inherited baseline, and record 840 tests with no failures/skips/todos. Check both Node majors before later freeze gates; never replace the lockfile to make installation work.
- [ ] Record exact baseline blobs/hashes for the five tests/fixtures/*.json files and package/lockfile; retain those outside the package deliverable as evidence.

## File map

| File | Action and responsibility |
| --- | --- |
| src/types/dreamAnalysis.ts | Create the three public interfaces from spec section 4 |
| src/core/dreamValidation.ts | Create cheap owned hostile plan validation |
| src/core/dreamPlan.ts | Extract shared capture/build with exact T3 preimages |
| src/core/dreamAnalysis.ts | Create safe Condensation adapter and snapshot traversal |
| src/core/dreamProposals.ts | Create bounds, evidence, exact duplicates, identities and result admission |
| src/core/dreamExecution.ts | Create recomputation/comparison/error orchestration |
| src/core/EtherMemoriesCore.ts | Add only public method delegation/imports |
| src/core/DurableEtherMemories.ts | Add interface, authority-checked implementation and facade delegation |
| src/types/index.ts | Re-export only the three new type interfaces |
| tests/helpers/dream-analysis.ts | New deterministic test fixtures; no production test hooks |
| tests/dream-analysis-validation.test.ts | New hostile input and cheap-work tests |
| tests/dream-analysis-capture.test.ts | New shared-capture and exact T3 identity regressions |
| tests/dream-analysis-proposals.test.ts | New pure adapter/evidence/duplicate/bound/golden tests |
| tests/dream-analysis.test.ts | New Core execution/staleness/TOCTOU/ownership tests |
| tests/dream-analysis-durable.test.ts | New lifecycle/parity/no-IO/mutation tests |
| tests/durable-runtime.test.ts | Narrow approved-method allowlist addition only |
| tests/maintenance-orchestration.test.ts | Narrow approved-method/count addition only |
| scripts/verify-packed-consumer.mjs | Extend existing installed consumer and internal-path containment |
| docs/dream-analysis.md, README.md, docs/dream-plan.md | Explain public workflow and link detailed analysis contract |

No persistence module, T2 snapshot projection, package manifest, lockfile, CI configuration or frozen fixture change is planned. Existing canonical encoding is consumed through dreamBytes. The design and this plan are retained alongside implementation.

### Task 1: Public data contract and bounded hostile plan validation

**Files:** Create src/types/dreamAnalysis.ts, src/core/dreamValidation.ts, tests/helpers/dream-analysis.ts, tests/dream-analysis-validation.test.ts. Public re-exports wait for Task 5.

**Interfaces:**

- Consumes: normalizeDreamRequest(selectorInput: unknown, optionsInput: unknown): DreamRequest; dreamEpoch(value: unknown): number; dreamScalar(value: unknown, limit?: number): string; dreamBytes(value: unknown, limit: number): Uint8Array; existing DreamPlan/Result.
- Produces: validateDreamPlan(input: unknown): Result<DreamPlan>; DreamCycleResult, DreamProposal and DreamProposalEvidence exactly as spec section 4.
- Test helpers: requireValue<T>(result: Result<T>): T; seedDreamCore(sources: Array<{ id: string; content: string; tags?: string[] }>, relationships?: Array<{ id: string; source: string; target: string; relationship: string }>): EtherMemoriesCore; planFor(core: EtherMemoriesCore, selector: DreamSelector): DreamPlan. Fixtures use deterministic IDs and creation epochs through existing importData setup, and planFor supplies asOf 1700000000000 explicitly. No helper executes production analysis.

- [ ] **RED — write validator tests with fixed assertions.** Plain/null-prototype valid preview plans succeed as detached projections. null, array, class instances, Proxy/revoked Proxy, accessor/hidden/inherited required fields, sparse/proxy/oversized arrays, malformed hashes, epochs, all budgets, selectors and coverage contradictions return INVALID_INPUT. Oversized length rejects before index/getter access. Unknown million-key records and symbol fields do not cause whole-object enumeration or getter access. Negative zero epoch follows T3 normalization; malformed Unicode fails only on the bounded owned encoding.

~~~ts
expect(validateDreamPlan(null)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
let touches = 0;
const foreign = { algorithm: "ether.dream.v2", get planId() { touches++; throw Error("trap"); } };
expect(validateDreamPlan(foreign)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_SCHEMA" } });
expect(touches).toBe(0);
~~~

- [ ] **Run RED.** npm test -- tests/dream-analysis-validation.test.ts. Confirm the missing validateDreamPlan/interface behavior fails; an unrelated setup failure is not a valid red result.
- [ ] **Implement validateDreamPlan(input: unknown): Result<DreamPlan> in src/core/dreamValidation.ts.** Use node:util types.isProxy before inspection, fixed known descriptors, maximum string/count checks before normalization, nine required downward budgets, canonical selector comparison and all spec section-5 invariants. Ignore unknown fields without enumerating them. Return fixed INVALID_INPUT/UNSUPPORTED_SCHEMA messages; never encode or retain original caller records. Add the exact three type interfaces and fixture helper signatures.
- [ ] **Run GREEN.** npm test -- tests/dream-analysis-validation.test.ts, then npm run typecheck. All cases pass; trap counters remain zero. Verify validation never accesses inspectionSources or a clock.
- [ ] **Commit the validator, types and its tests together.** git add only the five task paths; git commit -m "feat: validate bounded Dream execution plans".

### Task 2: Share exact T3 dependency capture and identity construction

**Files:** Modify src/core/dreamPlan.ts; create tests/dream-analysis-capture.test.ts. Read, but do not weaken, tests/dream-plan.test.ts and tests/dream-plan-durable.test.ts.

**Interfaces:**

- Consumes: DreamRequest, selectDreamNotes(owner: object, request: DreamRequest): DreamSelection, dreamBytes, existing selected-pair graph capture, Task 1 helpers.
- Produces: internal DreamRelationship and DreamCapturedDependencies exactly as spec section 10; captureDreamDependencies(notesOwner: object, graphOwner: object, request: DreamRequest): DreamCapturedDependencies; buildDreamPlan(capture: DreamCapturedDependencies): DreamPlan.
- Preserves: previewDreamCycle(notesOwner: object, graphOwner: object, selector: DreamSelector, options?: DreamCyclePreviewOptions): Result<DreamPlan> and public Core/Durable preview signatures unchanged.

- [ ] **RED — pin shared capture equivalence.** For all five selectors, compare buildDreamPlan(captureDreamDependencies(...)) with current preview output, including exact planId/digest and source-limit coverage. Hand-canonicalize the existing flat dependency preimage and plan preimage to independently recompute both hashes. Include empty selection, induced self-edge, reversed insertion order and maximum downward budgets. Assert snapshot fields are plain projected data; edits to captured content/tags/relationships never alter canonical state. Confirm mutating a public preview plan remains possible and cannot change another preview or private capture.

~~~ts
expect(rebuiltPlan).toEqual(originalPreview);
expect(rebuiltPlan.planId).toBe(originalPreview.planId);
expect(rebuiltPlan.dependencyDigest).toBe(originalPreview.dependencyDigest);
expect(core.exportData()).toEqual(beforeCaptureMutation);
~~~

- [ ] **Run RED.** npm test -- tests/dream-analysis-capture.test.ts. Confirm absent internal capture/build helpers are the failure.
- [ ] **Extract captureDreamDependencies and buildDreamPlan in src/core/dreamPlan.ts.** Preserve the exact existing selectDreamNotes and selected pair lookup algorithms, code-unit order, error mapping and canonical preimages. Capture request/coverage/notes/relationships into owned plain data; separately own public plan arrays/records. Do not add fields to DreamPlan or hash inputs; do not freeze caller data or T3 public results through aliases.
- [ ] **Run GREEN and frozen regressions.** npm test -- tests/dream-analysis-capture.test.ts tests/dream-plan.test.ts tests/dream-plan-durable.test.ts, then npm run typecheck. Every new assertion and all inherited Dream plan identities pass unchanged. Diff-check src/types/dreamPlan.ts and fixtures against frozen T3: no changes.
- [ ] **Commit only the capture extraction and new tests.** git commit -m "refactor: share frozen Dream dependency capture" after staging those two paths.

### Task 3: Pure Condensation adapter and bounded deterministic proposal result

**Files:** Create src/core/dreamAnalysis.ts, src/core/dreamProposals.ts and tests/dream-analysis-proposals.test.ts.

**Interfaces:**

- Consumes: Task 2 DreamCapturedDependencies/DreamRelationship, Task 1 public interfaces, CondensationEngine.analyze(input: string, parentDiaryId?: string, config?: CondensationConfig): CondensationAnalysis | undefined, codeUnitCompare and dreamBytes.
- Produces: internal DreamAnalysisOutput { content: string; keyFacts: string[] }; analyzeDreamContent(content: string): DreamAnalysisOutput | undefined; buildDreamResult(capture: DreamCapturedDependencies, plan: DreamPlan, outputs: Array<{ sourceId: string; analysis: DreamAnalysisOutput }>): DreamCycleResult; analyzeDreamSnapshot(capture: DreamCapturedDependencies, plan: DreamPlan): DreamCycleResult.
- Constants are private to dreamProposals.ts, with exact spec section-9 values. Neither module accepts authoritative owners, live callbacks or caller configuration.

- [ ] **RED — pin pure analysis and representative equality.** Blank source yields no output; trimmed/shortened summaries and ordered facts match fixed Condensation config. Place an astral character at the 197-code-unit cut and assert the shortened summary has no unpaired surrogate and at most 200 code units. Two units with equal content/facts collapse to one lowest-ID source; different origins/edges do not prevent that collapse. Exact selected source content equality suppresses output; a near content/facts difference survives. An unselected source equal to output never suppresses it. CommitAnalysis, condense and every candidate callback throw if invoked; analysis succeeds with zero calls to them.

~~~ts
expect(result.proposalCount).toBe(1);
expect(result.proposals[0].sourceIds).toEqual(["a"]);
expect(result.proposals[0].evidence.relationshipKnownCount).toBe(incidentCountForA);
expect(commitCalls).toBe(0);
expect(condenseCalls).toBe(0);
expect(candidateCalls).toBe(0);
~~~

- [ ] **RED — pin evidence, IDs, order and new limits.** Build table cases for 31/32/33 distinct unsuppressed outputs; 7/8/9 incident edges; 199/200/201 summary units; and fact filter/count boundaries at 7/8/9, 239/240/241 and 4/5/6. Use maximum JSON-escaped scalars to exercise complete proposal encoding at the 16384-byte admission boundary and array admission at 261120 bytes (boundary-1/boundary/boundary+1 where reachable); test admission arithmetic separately with owned bounded generated payloads where exact byte lengths cannot arise from the text adapter. Verify final result <=262144 bytes, independent worst-case envelope <1024, and proposal-ID preimage <=32768. Counts/flags/reasons must be exact, including simultaneous count and byte reasons in fixed order. Evidence endpoints stay selected; no adjacent secret body appears. Self-edge counted once. Prefix admission never skips an oversized item to accept a later one.
- [ ] **RED — write an independent fixed semantic golden.** Use deterministic imported note/edge IDs/epochs, non-ASCII source ordering, and literal expected content/facts/evidence/counts. Derive expected SHA-256 once from the documented hand-written proposal preimage, then store a literal hex expectation in the test; do not derive it with the production builder. Run identical fixtures in opposite note/edge insertion orders, trap localeCompare/random/time APIs, and assert deeply equal outputs. This same golden is collected by every Node/platform job.
- [ ] **Run RED.** npm test -- tests/dream-analysis-proposals.test.ts. Confirm missing adapter/builder behavior, not fixture failure.
- [ ] **Implement the three produced functions in their designated modules.** Construct a private CondensationEngine with a throwing candidate callback; only call analyze with the fixed config and no parentDiaryId. Apply the single trailing-high-surrogate repair only to shortened derived summaries. Project content/facts only. Use canonical byte equality, lowest-ID representative, selected-only exact source suppression, bounded incident-edge prefix, complete final-evidence hashing and result prefix admission. Enforce 128 units, 32 proposals, 5 facts/240 units, 1 source ID, 8 edges, 16384/32768/262144 byte ceilings and 1024-byte envelope reservation. No snapshot owner import or live callback is permitted.
- [ ] **Run GREEN.** npm test -- tests/dream-analysis-proposals.test.ts tests/condensation-v05.test.ts, then npm run typecheck. All limits, golden and commit traps pass; global Condensation behavior is unchanged. Statically inspect imports for live-read authority and forbidden APIs.
- [ ] **Commit only these modules and tests.** git commit -m "feat: generate bounded deterministic Dream proposals".

### Task 4: Core execution, stale-plan rejection and same-snapshot proof

**Files:** Create src/core/dreamExecution.ts, tests/dream-analysis.test.ts; modify src/core/EtherMemoriesCore.ts.

**Interfaces:**

- Consumes: validateDreamPlan(input: unknown): Result<DreamPlan>; captureDreamDependencies and buildDreamPlan; analyzeDreamSnapshot(capture: DreamCapturedDependencies, plan: DreamPlan): DreamCycleResult.
- Produces: internal runDreamCycle(notesOwner: object, graphOwner: object, input: unknown): Result<DreamCycleResult>; Core.runDreamCycle(plan: DreamPlan): Result<DreamCycleResult>.

- [ ] **RED — pin public execution and freshness.** Valid empty, one-source and multi-source plans return detached results; repeated runs are deeply equal and preserve full exportData and logical state (including Diary, graph, lifecycle, confidence/metadata/access/candidates/revisions). Tamper with digest/planId/selector/budget/coverage while preserving every structural invariant and expect CONFLICT after independent recapture, without analysis; structural contradictions remain Task 1 INVALID_INPUT cases. Change each bound field: content, tags, creation/expiry, lifecycle, selected membership/deletion, induced edge relationship/removal/count, and population matching count; expect CONFLICT. A missing/ineligible/now-over-bound recapture also returns CONFLICT. Unexpected injected internal exception returns fixed UNKNOWN_ERROR with no leaked data.

~~~ts
expect(core.runDreamCycle(plan)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
expect(analyzeCalls).toBe(0);
expect(core.exportData()).toEqual(before);
~~~

- [ ] **RED — pin scoped changes and approved recapture boundary.** Unbound summary/category/source/provenance/importance/confidence/pin/metadata/updatedAt/node labels/edge data changes preserve output. Explicit-ID unrelated note body and unrelated edge edits preserve success; changing population matching coverage rejects. Keep an unselected secret sentinel outside graph capture and analysis/output. Instrument selector scans separately so query/tag coverage reads occur only within the approved T3 recapture step. Package version and persistence generation are absent from hand-written identity preimages.
- [ ] **RED — pin TOCTOU and ownership.** During the first private analyze call, mutate canonical selected source two. Results for both units must use captured pre-mutation bytes; the next execution of the old plan must return CONFLICT. Instrument inspectionNotes/inspectionGraph or their returned sources so any authoritative read after comparison/analysis entry throws. Mutate the original caller plan during analysis; returned binding is the detached recomputed plan. Mutate every nested returned field; later results and canonical state remain unchanged. Later canonical edits do not alter already returned output.
- [ ] **Run RED.** npm test -- tests/dream-analysis.test.ts. Confirm Core method/execution behavior is missing.
- [ ] **Implement runDreamCycle in src/core/dreamExecution.ts and Core delegation.** Validate first; recapture with explicit owned request; compute exact plan/digest from that snapshot; compare every recognized plan field using bounded owned encoding; return fixed CONFLICT for expected recapture failures or mismatch. Analyze only the same capture. Catch unexpected exceptions as UNKNOWN_ERROR. Core passes its notes and graph owners once; no second preview plus live reread, auto-refresh, global invalidation or candidate path.
- [ ] **Run GREEN.** npm test -- tests/dream-analysis.test.ts tests/dream-analysis-validation.test.ts tests/dream-analysis-capture.test.ts tests/dream-analysis-proposals.test.ts tests/dream-plan.test.ts, then npm run typecheck. All TOCTOU/read/mutation sentinels pass.
- [ ] **Commit only Task 4 paths.** git commit -m "feat: execute validated Dream plans without mutation".

### Task 5: Durable authority, parity, installed consumer and public documentation

**Files:** Modify src/core/DurableEtherMemories.ts, src/types/index.ts, tests/durable-runtime.test.ts, tests/maintenance-orchestration.test.ts, scripts/verify-packed-consumer.mjs, README.md and docs/dream-plan.md; create tests/dream-analysis-durable.test.ts and docs/dream-analysis.md.

**Interfaces:**

- Consumes: internal runDreamCycle(notesOwner: object, graphOwner: object, input: unknown): Result<DreamCycleResult>; Core public method; existing #readable StateRoot and inspection authority pattern; existing internal openDurableEtherMemoriesInternal test dependencies.
- Produces: DurableEtherMemories.runDreamCycle(plan: DreamPlan): Result<DreamCycleResult>, exact facade forwarding, and three root type-only re-exports. Runtime named exports remain the frozen set; facade member count becomes exactly 24.

- [ ] **RED — pin authority and one generation.** Closed and recovery-required runtimes reject null, Proxy and hostile algorithm/getter plans with CLOSED/RECOVERY_REQUIRED and zero traps/analysis/clock calls. Ready Core and Durable built from the same imported canonical state return deeply equal results and identical IDs. A later generation change cannot alter detached analyzed bytes. No generation/WAL tip/package identity enters proposal binding.
- [ ] **RED — pin complete no-mutation/no-IO equality.** Reuse T3 durable hash and injected io/files patterns. Compare every file hash, WAL/receipt/checkpoint identity, tip, exported logical data, lifecycle, writer state and GC state before/after ordinary, empty, repeated, rejected, duplicate-suppressed and truncated runs. Trap read/open/write/sync/rename/lock/enqueue/candidate authority paths during Dream execution; count zero. Cover returned nested clone isolation. Use existing private test seams only; no new public diagnostics.

~~~ts
expect(durable.runDreamCycle(plan)).toEqual(core.runDreamCycle(plan));
expect(await hashes(directory)).toEqual(beforeHashes);
expect(requireValue(durable.tip)).toEqual(beforeTip);
expect(durable.exportData()).toEqual(beforeExport);
expect(ioCalls).toBe(0);
~~~

- [ ] **RED — extend exact consumer/containment expectations.** Require Core/Durable run, all three type imports, replay/empty success, preview identity and existing T2 APIs from the installed packed package. Block package deep imports and root exports for dreamValidation, dreamExecution, dreamAnalysis, dreamProposals and new capture/build helpers; retain every prior persistence/T5 block. Assert root runtime export names unchanged, no accept/commit/history APIs, and facade exact members are inherited approved members plus runDreamCycle only. Record actual new dist JS/declaration inventory without relaxing package gates.
- [ ] **Run RED.** npm test -- tests/dream-analysis-durable.test.ts tests/durable-runtime.test.ts tests/maintenance-orchestration.test.ts; run npm run build and npm run verify:packed. Confirm missing Durable method/type/consumer behavior fails as intended.
- [ ] **Implement Durable method and facade/type exports.** Call #readable once, check recovery-required before input processing, then pass that generation's notes/graph to shared execution. Add one facade forwarding member. Update only the two inherited exact allowlists, their comment/title and expected 24 count; retain all identity, prototype, symbol, metadata and authority assertions. Extend the packed consumer exact block lists and exercise intended types; do not publish internals.
- [ ] **Write public docs with a concrete preview → run example.** Explain malformed/unsupported/stale errors, re-preview on CONFLICT, selected-only proposal analysis and approved bounded coverage recapture, deterministic summaries/facts/IDs, representative exact duplicates, evidence/counts/reasons/byte caps, no MemoryNote materialization, zero mutation/persistence, replay, empty success and no apply API. Link docs/dream-analysis.md from README and Dream plan docs. Do not imply LLM reasoning or psychological provenance.
- [ ] **Run GREEN.** npm test -- tests/dream-analysis-durable.test.ts tests/durable-runtime.test.ts tests/maintenance-orchestration.test.ts tests/dream-plan-durable.test.ts; npm run typecheck; npm run build; npm pack; npm run verify:packed. Then run the full inherited plus new test suite: all 840 baseline cases remain active, with only the documented additive facade expectations changed. Record exact new/total test and packed inventory counts.
- [ ] **Commit Task 5 paths only.** git commit -m "feat: expose read-only Dream analysis on durable facade". Record and inspect the narrow inherited-test diff independently of new tests.

### Task 6: Exact-candidate security, platform verification and hostile freeze review

**Files:** Read all changed files; no planned production changes. Retain local verification receipts outside tracked package/source files. Material findings return to the owning task's RED/GREEN loop with a small fix commit.

**Interfaces:** Consumes the complete public API and exact branch-head SHA; produces verified evidence and the handoff section-72 final report. No new API or persisted artifact.

- [ ] **Verify scope before the expensive matrix.** Record candidate SHA/tree and ancestry; compare package.json, package-lock.json, src/types/dreamPlan.ts, persistence schema/codec paths and the five frozen fixture blobs against a1da07b. Review the entire diff for T5 leakage, new exports, forbidden mutation APIs, unchecked caller enumeration, live reads after comparison, excluded fields, random/clock/locale use and unbounded encoding. Require git diff --check clean.
- [ ] **Run all clean local gates on Node 22 at that SHA.** npm ci; npm run verify:toolchain; npm run typecheck; npm test; npm run verify:workers; npm run build; npm pack; npm run verify:packed; npm audit --json; npm audit --omit=dev --json. Record actual Node/npm versions, commands, exit codes, all inherited/new/total test counts and warnings. Audit vulnerability counts must each be zero.
- [ ] **Repeat the clean gates on Node 24 at the same SHA.** Use the verified portable runtime paths/session conventions and clean install; do not replace protected lockfile or fixtures. The identical semantic golden must pass. Record the second full/production audit zero results and all exits.
- [ ] **Publish the authorized candidate branch/draft PR and run the existing full CI matrix.** Obtain current remote base/PR state before mutation. The T4 head descends from exact frozen T3; do not use a synthetic CI merge SHA as its parent or final canonical candidate. Preserve stacked-lineage review and request no merge. Record PR URL, run ID and candidate head SHA. If push/CI requires sandbox escalation, use the normal scoped approval mechanism; do not bypass network restrictions.
- [ ] **Inspect every stage of Ubuntu22, Ubuntu24, Windows22 and Windows24.** Install, toolchain security, typecheck, all tests, worker exit, build, pack and packed consumer must pass on all four jobs, with no skipped platform. Compare head SHA to local receipts and record statuses and semantic golden outcomes; waiting or queued is not green.
- [ ] **Perform a fresh independent hostile review of the exact tested branch-head SHA.** Review every section-70 risk plus the approved recapture boundary, Unicode cut, algorithm/authority precedence, exact duplicate evidence, full byte accounting, 840-test integrity and packed API containment. No reuse of prior T3 reviewer conclusions or review of only a merge SHA. Record critical/important/minor findings and unresolved material count.
- [ ] **Repair every material finding inside T4.** Reproduce with a failing regression, implement the smallest correction in its owning task, run affected GREEN checks, commit, and rerun all final exact-candidate gates/matrix/review for the new SHA. Do not mark freeze on stale receipts or invent another tranche.
- [ ] **Deliver the section-72 report.** Include exact lineage, candidate branch/SHA/PR, public method/types, grouping/schema/evidence/bounds/equality/errors, validation/digest/plan recomputation/TOCTOU, Condensation analyze-only and commit traps, deterministic goldens/replay, full logical/durable no-mutation proof, inherited/new/total tests and failures/skips/todos/warnings, four zero audits, all four CI jobs/run ID, packed consumer, persistence formats/fixture identity, review severities/unresolved material findings, and deferred scope limited to T5/T6/post-v0.7.
- [ ] **Freeze only if all evidence is green.** State exactly "T4 CLOSED / GREEN / FROZEN.", record the exact canonical T4 SHA, then stop. Do not merge or start T5/T6. Otherwise report AMBER/RED and the concrete incomplete gate without claiming closure.

## Self-review and requirement coverage

| Spec/handoff requirement group | Owning tasks |
| --- | --- |
| Lineage, section-4 approval and selector conflict | Initial gate; Tasks 2, 4, 6 |
| Hostile shape, algorithm, counts, budget/selector canonicality, bounded parsing | Task 1 |
| Frozen T3 projection/preimages/coverage and one detached capture | Tasks 2, 4 |
| Grouping, pure Condensation, Unicode, exact duplicates, IDs/order/evidence | Task 3 |
| Every fixed work/output bound and truthful count/truncation | Task 3 |
| Core stale/relevant/irrelevant/empty/replay/ownership/TOCTOU | Task 4 |
| Durable authority/generation/parity/zero mutation and no IO | Task 5 |
| Type-only public surface, exact facade members, packed consumer and docs | Task 5 |
| 840 inherited tests, security, version, frozen formats/fixtures | Tasks 2, 5, 6 |
| Four-platform matrix, exact-SHA review, final report and stop | Task 6 |

Self-review confirms every produced signature is consumed with the same name and type, all five Review Focus cases have named owning tests, tasks have independently reviewable RED/GREEN outcomes, and no implementation body or unspecified public design is delegated to chance. The only pending authority decision is explicit approval of the section-3 recapture ruling. This plan is not a claim that any T4 implementation, tests, audits or CI have run.
