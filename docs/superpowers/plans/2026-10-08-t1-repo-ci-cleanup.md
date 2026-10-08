# Ether Memories v0.7.0 T1 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The owner supplied the frozen scope and explicitly requested implementation; no architecture redesign or additional design approval is needed.

**Goal:** Improve repository, test and CI hygiene from the exact released v0.6.0 base.

**Architecture:** Keep production source, formats, fixtures and exports unchanged except a proven small resource-cleanup defect. Replace test sleeps with instrumentation markers and run packed-consumer checks from an isolated temporary directory on all four existing CI platforms.

**Tech Stack:** Node 22/24, npm, TypeScript, Vitest, GitHub Actions. No added dependencies.

**Spec:** Owner's pasted "Ether Memories v0.7.0 — Tranche 1 (Repository + CI Cleanup)" request, supplied 8 October 2026. Its exact attachment is retained outside this checkout in the session attachments.

## Global Constraints

- Base: `493c7b69813e71af749e34bbf950803eb8ee589b`; branch `feat/v0.7.0-t1-repo-ci-cleanup`.
- Keep library/package/lock versions at `0.6.0`.
- Keep `ether.memory_store.v0.3`, WAL v1, receipt v1, HEAD/checkpoint formats and all five frozen fixtures unchanged.
- No new public API, runtime dependency, warning suppression, timeout increase or strict-durability change.
- PR #24 is a separate unmerged T5 reference, never the T1 base.
- Roadmap has exactly T1–T6; no T7 and no automatic start of T2.

## Review Focus

- Clean checkout without dist: full tests must precede build and remain self-contained.
- Windows unsupported directory sync: close successfully opened handles even when sync rejects; preserve best-effort legacy snapshot behavior.
- Fault-injected close rejection: assert the production failure before test teardown closes the intentionally stranded real handle.
- Slow scheduling: authority tests wait for reached protocol markers, release gates in finally and await in-flight operations.
- Installed-package boundaries: compile declarations and reject deep imports through the exports map; test durable facade with real platform semantics.

## Candidate classification

| Finding | Owner | Action |
| --- | --- | --- |
| Current-facing release docs say publication pending / unfrozen | T1 | Correct against release/tag receipts; preserve historical lineage |
| CI packed consumer lacks declarations/durable facade/export-boundary checks | T1 | Extract a cross-platform verification script; retain four matrix jobs |
| Three authority tests use arbitrary startup sleeps | T1 | Instrument explicit reached markers; no timeout increase |
| DEP0137 / GC-close warnings in clean baseline | T1 | Trace origins; add regression and fix only proven resource cleanup |
| Unmerged Windows recoverable candidate | T5 | Preserve separate PR #24; no integration |
| v0.7 metadata/release integration | T6 | Defer; keep 0.6.0 |
| Old probe scripts and engineering records | T1 audit | Retain: useful historical release evidence, not dead artifacts |

### Task 1: Release documentation accuracy

**Files:** README.md, RELEASE-MANIFEST.md, docs/v0.6.0-integration.md, docs/af1-tranche7-rotation-receipts.md, docs/af1-tranche8-object-reclamation.md.

- [x] Correct current status with released integration SHA and published GitHub release; distinguish npm publication.
- [x] Preserve dated T10 verification counts and receipts; correct the blanket byte-identity claim after release-integrity/lockfile fixes.
- [x] Use npm ci in development instructions and document the packed-consumer command when available.
- [x] Run release-integrity tests; expected all existing metadata, fixture and README declaration gates pass.
- [x] Commit focused documentation correction.

### Task 2: Warning investigation and test synchronization

**Files:** tests/startup-recovery.test.ts, tests/durable-rotation.test.ts, tests/object-reclamation.test.ts; narrowly scoped src/utils/persistence.ts and its regression tests only if the leak is proven.

- [x] Reproduce warnings with traced fs.open/close origins; record exact paths and fault conditions.
- [x] Add failing regression for a successfully opened legacy directory handle whose sync rejects; assert exactly one close and successful snapshot roundtrip.
- [x] If confirmed, wrap only that best-effort sync in finally; preserve the enclosing catch and error semantics.
- [x] Close intentionally stranded fault-injection handles in test-owned teardown after assertions, preserving injected failures and close-attempt counts.
- [x] Replace the 50/150/300 ms authority sleeps with reached promises; always release and await in-flight operations.
- [ ] Run affected suites and typecheck; expected no failures or GC-close warning.
- [x] Commit the resource repair and test harness changes independently where practical.

### Task 3: Packed-consumer CI gate

**Files:** scripts/verify-packed-consumer.mjs, .github/workflows/ci.yml, package.json (script only).

- [ ] Accept one explicit tarball path or require exactly one tarball matching package name/version in cwd; create a temporary isolated consumer and remove it in finally.
- [ ] Install the actual tarball, verify packed file allowlist, ESM named exports, snapshot save/load and native public durable factory behavior (Windows strict fails closed).
- [ ] Compile an installed-package TypeScript consumer; assert internal root types and deep modules are inaccessible.
- [ ] Replace inline bash consumer in CI with the same Node script; keep npm ci, typecheck, full tests before build, build, pack and all four matrix jobs.
- [ ] Run npm pack and the gate locally plus negative-control packages; expected positive pass and damaged packages fail.
- [ ] Commit focused CI change.

### Task 4: Exact candidate verification and freeze report

- [ ] Commit implementation, then use a separate fresh checkout of the exact candidate for npm ci, typecheck, full tests, build, npm pack and isolated packed consumer.
- [ ] Compare five fixture Git blobs, production source (except proven repair), exports and declaration bytes to released base.
- [ ] Push isolated branch, create draft PR, inspect all four CI jobs and record exact candidate/run/job IDs and counts.
- [ ] Obtain adversarial whole-branch review of the exact SHA; resolve material findings and repeat required verification if changed.
- [ ] Write evidence report. Only say GREEN / CLOSED / FROZEN if every required gate passes; otherwise record AMBER with precise outstanding evidence. Stop before T2.

## Execution ledger

- Baseline: clean isolated worktree at exact base; npm ci passed; Windows Node 24.19.0 full suite 29 files / 689 passed / 0 failed / 0 skipped. GC FileHandle warnings reproduced. npm 11.17.0 reports unapproved esbuild install-script notice; no install failure.
- Remote verification: main and v0.6.0 tag both at base; published GitHub Release receipt confirms release, with npm publication separate. PR #24 draft/unmerged at e8c45b8fde108e3d50241d8dd30c67118e460968.
- Task 1: complete at 6881933; release-integrity suite 14/14 passed, including isolated README declaration generation, fixture/lockfile/version gates and link checks.
- Task 2: regression RED (sync-rejection path close called zero times), GREEN 4/4; typecheck passed. Resource-only repair committed 3cf6565. Explicit reached-marker and fault-handle teardown checks passed 6 targeted tests (169 deliberately filtered tests); committed af318f3. Full affected suites remain part of final exact-SHA verification.
- Task 3: initial consumer check rejected JSON omission of undefined optional fields. Ruling: compare serialized legacy snapshots, matching the released JSON contract; no runtime or persistence change. Cost if wrong: the gate could miss an in-memory-only optional-property difference; persisted contents remain checked exactly.
- Packed gate local positive: 104 files, 32 named exports, 51 blocked module paths, snapshot roundtrip, Windows strict fail-closed facade, declarations all passed.
- Workflow tooling ruling: use native PowerShell/Node verification and ledger instead of skill Bash helper scripts on this Windows host; preserve the requested evidence and exact-SHA review gates.
