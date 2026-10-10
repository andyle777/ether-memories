# T3 Dream Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add only `previewDreamCycle(selector, options): Result<DreamPlan>` on Core and the durable facade.

**Architecture:** Reuse T2's internal WeakMap-owned note/graph access to avoid cloning the store or arbitrary metadata. Separate bounded request normalization, source selection/projection, and induced-graph capture/canonical hashing. The returned plan is detached plain data with no bodies or live handles.

**Tech Stack:** TypeScript, existing Tokenizer/codeUnitCompare/canonicalJson, Node SHA-256, unchanged Vitest4.1.11/Vite7.3.6.

**Spec:** Owner's frozen T3 handoff, attachment `2e19add9-d496-488a-af57-8ac0a587f1f4/Pasted text.txt`. That handoff authorizes implementation and forbids reopening architecture. Native inline execution; fresh independent hostile review after exact-SHA CI.

## Global Constraints

- Sole parent: `10ed0855bdee126bebbfa78efaaa2a7db6b26858`; preserve all743 tests and library0.6.0.
- Algorithm `ether.dream.v1`; no analysis, condensation, proposals, persistence mutation, T4/T5 integration or T7.
- Full/prod audits0 on Node22/24; Ubuntu/Windows × Node22/24 all stages green.
- Storev0.3, WAL/receipt/HEAD/checkpointv1 and five frozen fixtures unchanged.
- Exactly one new public behavioral operation; only invocation/consumption types added.

## Concrete contract

Selectors: `{kind:'ids',ids:string[]}`, `{kind:'tags',tags:string[]}` (exact AND), `{kind:'query',query:string}` (existing NFC/lowercase tokenizer; all query tokens in canonical content, ID ordering), `{kind:'date-window',from:number,to:number}` (createdAt in [from,to)), `{kind:'all_active'}`. Normalize duplicate IDs/tags by code-unit sorting; reject unknown/ineligible explicit IDs. Active notes with createdAt <= asOf and absent/future expiresAt are eligible. Promoted notes are active in this model; candidates, archived/rejected/expired notes never qualify. Query adapter deliberately excludes summary/category/metadata/Diary and ranking because the existing retriever's cloning/rebuild cannot meet this boundary.

One integer epoch asOf, captured once at public planner entry when absent; durable CLOSED/RECOVERY_REQUIRED errors precede that capture and request validation.

Hard ceilings:256 input IDs/tags;256 code units per ID/tag/edge ID/relation;4096 query code units;4096 population for non-ID selectors;128 sources;64 canonical tags per examined note;65536 content UTF8 bytes per note;131072 canonical projected bytes per note;4194304 selector-work bytes;1048576 dependency bytes;1024 induced relationships;65536 output bytes. Configurable `DreamBudgets` permits only positive integer reductions of maxPopulation/maxSources/maxTags/maxContentBytes/maxNoteDependencyBytes/maxSelectionBytes/maxDependencyBytes/maxRelationships/maxPlanBytes. Induced graph pair lookups <=128²; no neighbor traversal. Above population/text/byte/relationship bounds: explicit INVALID_INPUT, no partial dependency binding. Source count truncation selects lowest code-unit IDs and reports knownCount, selectionTruncated and source-limit. Known matching count participates in identity; adding a match beyond the selected cap changes coverage and identity. Unmatched population bodies and global revisions do not.

DreamPlan fields:algorithm,planId,asOf,selector,selectedSourceIds,selectedCount,knownCount,selectionTruncated,truncationReasons,dependencyDigest,budgets,graph:{relationshipCount}. No bodies/edge data/Diary/metadata exposed. Consumed note projection:id,content,tags,status,createdAt,expiresAt; temporal fields are integer milliseconds/null. Exclude updatedAt (metadata-only updates change it), summary/category/source/provenance/importance/confidence/pinned/access/metadata. Selected induced edges:id,source,target,relationship; exclude labels/data/foreign endpoints. Bind algorithm,asOf,selector,budgets,selection/coverage,notes,relationships using existing bounded canonicalJson. Domain-separated SHA256 dependencyDigest and planId; no package/global revision. PlanId hashes the complete plan sans planId in its own domain.

## Review Focus

- Accessor-bearing requests fail Result validation without invoking getters; array count checked before elements.
- Expiry and future creation evaluated against one asOf without purging canonical notes.
- Tiny selected subsets of huge stores work through direct ID lookup; non-ID population over ceiling fails before enumeration.
- Invalid canonical consumed values fail boundedly; irrelevant metadata can be enormous/cyclic without being read.
- Unselected graph edges cannot affect identity or work; induced graph pair lookups avoid neighborhood-degree dependence.

### Task1: Bounded selectors and note dependency plans

**Files:** Create src/types/dreamPlan.ts, src/core/dreamRequest.ts, src/core/dreamSelection.ts, src/core/dreamPlan.ts, tests/dream-plan.test.ts. Modify src/types/index.ts and src/core/EtherMemories.ts.
**Interfaces:** normalizeDreamRequest(selector,options) produces normalized selector/asOf/effective budgets; selectDreamNotes(notesOwner,request) produces bounded detached notes + selection counts; previewDreamCycle(notesOwner,graphOwner,selector,options) produces Result<DreamPlan>.

- [ ] Write tests for all five selectors, deterministic empty plan, explicit IDs unknown/ineligible, malformed/accessor requests, duplicates/permutations, one clock, expiry/date boundaries, integer epochs and hard ceilings.
- [ ] Run `npm test -- tests/dream-plan.test.ts`; expect missing preview behavior failures; save RED log.
- [ ] Implement request normalization, bounded selection/projection and canonical dependency/plan hashing; expose only minimal types and Core method.
- [ ] Run focused tests + typecheck; expect all task1 tests pass. Commit.

### Task2: Induced graph closure, identity and resource attacks

**Files:** Modify src/core/dreamPlan.ts, tests/dream-plan.test.ts; add docs/dream-plan.md.
**Interfaces:** Task1 projected selection feeds graph pair lookup and complete canonical dependency closure.

- [ ] Add secret-sentinel neighbor/Diary tests, selected edge semantics, insertion/locale determinism, independent canonical digest golden, relevant vs irrelevant changes, all-active/query population changes, graph/dependency/output ceiling failures and clone isolation.
- [ ] Run focused tests; expect missing induced graph dependency failures; preserve RED.
- [ ] Capture only bounded selected-selected directed edges, project/sort and bind them; keep summaries small. Document all exact fields, eligibility, query adaptation, ceilings and selector-specific staleness contract.
- [ ] Run focused tests + typecheck, expect pass; commit.

### Task3: Durable read-only facade and installed package

**Files:** Modify src/core/DurableEtherMemories.ts, scripts/verify-packed-consumer.mjs, README.md; create tests/dream-plan-durable.test.ts.
**Interfaces:** Core's internal planner is reused against committed StateRoot notes/graph; public DurableEtherMemories gets the same method signature.

- [ ] Write ready/parity/all-I/O-forbidden/file hashes/tip/revision/no-analysis and closed/recovery-required precedence tests.
- [ ] Run durable tests; expect missing public method failures; preserve RED.
- [ ] Add interface/private implementation/public facade forwarding with existing authoritative-state precedence.
- [ ] Extend installed runtime/type consumer to exercise all minimal Dream public types and preview method, prohibit planning/hash/internal exports and T4 operations; add concise usage docs.
- [ ] Run Core+durable focused tests, typecheck/build/pack/verify:packed; expect all pass. Commit.

### Task4: Exact-candidate freeze proof

**Files:** Evidence outside candidate at ../.t3-evidence; no dependency changes.

- [ ] Fresh clean installs, toolchain/typecheck/all743 inherited + new tests/worker exit/build/pack/consumer on Node22 and Node24 sequentially, include seed743 shuffle where useful.
- [ ] Commit final candidate; rerun clean exact-SHA full/prod audits both Nodes and verify unchanged lock/runtime graph/format/fixture blobs.
- [ ] Push isolated branch, create draft PR based on corrected T2 branch, run all four CI jobs; bind CI merge tree to candidate and inspect all logs.
- [ ] Fresh exact-SHA hostile review after green CI; reproduce/material findings test-first and reverify affected gates after fixes.
- [ ] Write all requested freeze-report fields and exact T3 declaration only if every gate green. Keep PR unmerged; stop before T4.
