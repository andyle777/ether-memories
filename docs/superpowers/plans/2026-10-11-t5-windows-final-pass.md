# T5 Windows Final Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for Native task-by-task execution. Steps use checkbox syntax. One fresh independent whole-branch hostile reviewer follows all exact-SHA gates.

**Goal:** Reconcile the proven standalone Windows process-recoverability contract onto frozen T4 and freeze a new canonical T5 candidate.

**Architecture:** Intentionally reapply the historical seven-file production diff, preserving all current Durable inspection/Dream methods. Capture the backend once at open; reuse it for bootstrap, recovery, WAL, activation, rotation and maintenance. Persistence formats and ordinary domain Results remain unchanged.

**Tech Stack:** TypeScript, Node22.23.3/24.21.0, Vitest4.1.11, native Windows Server2025 GitHub runner.

**Spec:** `docs/superpowers/specs/2026-10-11-t5-final-reconciliation-handoff.md` (verbatim user handoff); historical audit anchor `e8c45b8fde108e3d50241d8dd30c67118e460968` from released v0.6.

## Global Constraints

- New branch `feat/v0.7.0-t5-windows-final-pass` starts at exact frozen T4 `bf9808c0222bcf66dea54bafef61e5e846f8957b`; historical T5 and PR24 remain immutable/separate.
- Only public addition: `DurableEtherMemoriesOptions.durabilityGuarantee?: "strict" | "recoverable"`. Strict defaults; no downgrade or per-call fallback.
- Recoverability covers application/Node process termination with the OS/filesystem still operating in tested local Windows conditions. No power/kernel/disk/network/universal-filesystem claim.
- Regular-file sync remains mandatory; weak internal acknowledgement/activation says `process-recoverable`, never confirmed/atomic. Ledgerv1 cannot establish an original writer's durability profile.
- No new runtime dependency, receipt/WAL/HEAD/checkpoint version, schema, migration, activation journal, auto-lock takeover or persisted capability history. Architectural contradiction means STOP/RED.
- Preserve all 1017 inherited active tests, exact five fixture blobs, all T1–T4 methods/errors/Dream identities, 32 root runtime exports, version0.6.0, security-clean manifests and standard CI guards.
- No merge, force push, T6, release metadata, or T7. Normal implementation checkpoint pushes/fetch exact identities; final new draft PR against frozen T4.

## Review Focus

1. A caller or injected backend changes its capability/operations after open: later WAL/rotation/recovery must retain the originally captured backend without fallback.
2. A previously recoverable historical receipt is retried by a strict runtime: ledgerv1 must not fabricate the original durability profile; acknowledgement describes only the current invocation.
3. A readable recoverable generation runs inspection/Dream: output must equal equivalent strict/Core logical state, with zero durability I/O and no capability leakage.
4. A crash child exits before its semantic marker or a required probe is unavailable: the native workflow must fail, never count a timeout/optional refusal as successful crash proof.
5. A path contains UNC/device/ADS/DOS/trailing-dot-or-space/U+10FFFF aliases or a junction/hardlink: reject safely while ordinary Unicode/spaces remain usable and file sync failures never publish success.

## Historical semantics map

| Historical behavior | Planned status / owner |
|---|---|
| Explicit option, strict default, POSIX stronger backend | Preserved; Task1 |
| Once-captured coherent backend | Preserved; Task1, strengthened operation-replacement coverage Task2 |
| Weak WAL/new/retry/lookup acknowledgements and HEAD activation | Preserved; Task1 |
| Historical receipt provenance stays unknown | Preserved; Task1; strict-current-invocation regression Task2 |
| Windows DirectoryIO file sync, directory validation, bigint/nanosecond reads | Preserved; Task1 |
| Unsafe path fence, junction/hardlink refusal, valid Unicode/spaces | Preserved; Task1 |
| Rotation, object activation, GC, maintenance, recovery | Preserved; Tasks1–2 |
| Twelve historical production capability cases | Integration-adapted to run actively on every standard platform; Task1 |
| Native filesystem and six synchronized crash probes | Preserved, proof-strengthened where assertions were conditional; Task3 |
| Dedicated Windows Node22/24 workflow | Integration-adapted trigger/actions and exact-SHA reports; Task3 |
| Spike documentation/ignore rule | Integration-adapted final conservative support documentation/report pattern; Task3 |

No historical production behavior is intentionally removed.

### Task 1: Historical capability semantics with all twelve regressions

**Files:** Create `tests/windows-recoverable.test.ts`; modify `src/core/DurableEtherMemories.ts`, `src/persistence/{directoryIO,FsDurableStore,FsWalStore,checkpointRotation,payloadObjects,productionOperations}.ts`.

**Interfaces:** Public option union above. Package-internal `captureDirectoryIO(io: DirectoryIO): DirectoryIO`, `assertWindowsRecoverablePath(path: string): void`, `activationMatches(io: DirectoryIO, activation: string): boolean`, `acknowledgmentFor(io: DirectoryIO): InternalAcknowledgment`; internal commit/activation unions retain exact strict types and separate weak results. No root exports.

- [ ] Port all12 historical cases first. Remove platform-level skipping: native Windows tests exercise public production behavior; other platforms exercise real strict defaults, direct path guards and the internal real weak adapter where Windows-specific behavior is required. No mocked platform is native evidence.
- [ ] RED: `npm test -- tests/windows-recoverable.test.ts`; expected recoverable/capability/weak acknowledgement cases fail against frozen T4, with strict controls retained.
- [ ] Reapply the exact historical persistence semantics after verifying each persistence file still equals the released base. Reconcile only imports, option and factories in Durable; preserve every T2/T3/T4 method/facade member.
- [ ] GREEN: all12 tests, `npm run typecheck`, `npm test` pass. Confirm no inherited test diff, no formats/fixtures/manifests/version drift.
- [ ] Commit the independently testable capability change; task-done focused suite; normal push/fetch and exact identity.

### Task 2: T4 integration, authority and historical provenance

**Files:** Create `tests/windows-recoverable-integration.test.ts`; production changes only if a reproducing regression proves an integration defect.

**Interfaces:** Consumes Task1 option/capture and existing `explainMemory`, `inspectMemoryHealth`, `previewDreamCycle`, `runDreamCycle`, `recover`, `rotate`, `runMaintenance`, `collectGarbage`, stable-ID domain mutation Results.

- [ ] Write tests pinning all four read surfaces to an equivalent Core/strict generation at fixed asOf, plan/result deep equality, detached outputs, persisted file/tip equality, and throwing DirectoryIO/WalIO after open to prove read-only operations perform no I/O.
- [ ] Preserve `CLOSED` and `RECOVERY_REQUIRED` precedence over hostile inspection/Dream inputs; include recovery-required after a real injected file-sync failure and explicit recovery.
- [ ] Test capability and operation replacement after open, through mutation/rotation/recovery/GC/maintenance; later injected replacements cannot be called. Test weak historical retry and strict current-invocation acknowledgement without any persisted historical capability claim.
- [ ] Run focused tests; where Task1 already implements the intended behavior these are integration characterization gates, not invented RED. Any actual defect: observe RED, minimally correct owning production code, observe GREEN.
- [ ] `npm run typecheck` and `npm test` pass with all1017 inherited plus12 ported and all integration cases active; no skipped/todo cases.
- [ ] Commit integration coverage; task-done focused suite; normal checkpoint push/fetch exact identity.

### Task 3: Native proof, packaging and conservative final documentation

**Files:** Port `scripts/round11-windows-{native,crash}-probe.mjs`; create `scripts/t5-windows-proof-negative-controls.mjs`, `.github/workflows/t5-windows-native.yml`, `docs/t5-windows-recoverability.md`; modify `.gitignore`, `scripts/verify-packed-consumer.mjs`.

**Interfaces:** Same six historical marker phases and stable mutation IDs; reports identify actual platform/runtime and exact candidate. Workflow push trigger only final T5 branch, optional manual dispatch, Windows2025 × Node22/24; modern checkout/setup/upload actions, install/security/typecheck/build, both capability suites and both probes, worker exit, required report uploads.

- [ ] Port both probes without changing production synchronization boundaries. Require every child marker, killed exit, stale-lock refusal before harness-only removal, exactly-once retry and an additional reopen confirming stable identity/effect. Timers fail rather than count as evidence.
- [ ] Strengthen native filesystem proof so required junction support/refusal is mandatory; retain primitive observations, bigint/nanosecond identity, ordinary Unicode/spaces and isolated U+10FFFF child. First run a real child-process negative control injecting unavailable junction creation: historical probe incorrectly succeeds (RED); require rejection (GREEN). A second real-child control exits before a crash marker and must make the crash gate fail. Run controls before positive probes in both native jobs.
- [ ] Add packed positive recoverable option/declarations, full T2/T3/T4 public read checks, strict Windows default refusal, stable retry/reopen/rotation/GC/maintenance; block internal weak acknowledgement/capability types/functions. Existing packed assertions remain.
- [ ] RED: build/pack then `npm run verify:packed` with a positive declaration or runtime control proving the new gate can reject missing/incorrect behavior; existing Task1 implementation may already satisfy positive behavior, so do not manufacture production regressions.
- [ ] Run typecheck, full suite, build, pack, consumer and both native probes locally on Node22/24. Document exact process-failure scope and provenance/authority limitations; package0.6.0 unchanged.
- [ ] Commit final proof/documentation gate; task-done packed consumer; normal push/fetch exact identity. Reports are ignored, never packaged.

### Task 4: Exact candidate freeze, standard/native CI and independent review

**Files:** No planned production change. Retain raw receipts, full historical diff/semantic map, fixture blobs and final section57 report outside tracked package/source.

**Interfaces:** Consumes all tasks and exact final branch-head SHA; produces new canonical T5 freeze, draft PR and evidence. Any material repair requires new exact-SHA gates/review per user.

- [ ] Record clean candidate/tree/ancestry, protected manifests/formats/fixtures/T4 Dream identity; historical anchor unchanged; audit complete diff and every historical behavior classification.
- [ ] At exact candidate, Node22 then Node24: clean `npm ci`, toolchain security, typecheck, full verbose tests, worker exit, build, pack, packed consumer, full audit JSON, production audit JSON, both native probes. All exits0; audits0; actual counts/versions/diagnostics retained.
- [ ] After local GREEN/push, create new DRAFT PR against `feat/v0.7.0-t4-dream-analysis`; never retarget PR24. Inspect all jobs/stages/raw logs of four-job standard CI and two-job native Windows2025 workflow at canonical branch SHA; fetch native JSON artifacts/reports as available. No skipped platforms/probes.
- [ ] Fresh independent exact-SHA hostile review after every gate passes; complete user section52 risk list, Review Focus verbatim, all changed paths, raw gates and rulings. Critical/Important findings reproduce/fix inside T5, new SHA and fresh review; no deferred material findings.
- [ ] Deliver complete section57 report with all lineage/behavior/API/strict/weak/path/authority/test/security/native/CI/package/format/version/review fields. Preserve evidence before deleting only this plan scratch workspace; retain branch/worktree/draft PR.
- [ ] Only all GREEN: `T5 CLOSED / GREEN / RECONCILED / FROZEN.`; historical T5 remains audit anchor but is superseded; new T5 SHA is ONLY valid T6 parent. Then STOP; no T6/merge.

## Self-review

All57 handoff sections map to Tasks1–4. Shared interfaces preserve historical names and T4 signatures. All five Review Focus cases have owning tests/probes; no design change or new architecture is proposed. New platform skips are eliminated through honest supplemental backend coverage plus mandatory native proof. Execution is already authorized by the handoff; continue Native without reopening an approval/design gate.
