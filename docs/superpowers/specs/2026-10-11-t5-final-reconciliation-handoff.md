# ETHER MEMORIES v0.7.0 — TRANCHE 5 FINAL RECONCILIATION / REVALIDATION HANDOFF

You are performing the **final Tranche 5 pass** for Ether Memories v0.7.0.

This is NOT a new architecture exercise.

T5 has already been independently designed and empirically proven on a standalone branch.

Your job now is to:

1. preserve the proven T5 Windows recoverability contract,
2. rebase/reconcile it onto the current frozen T4 lineage,
3. resolve overlap carefully,
4. rerun the native Windows evidence,
5. rerun the full modern T1–T4 regression/security/package matrix,
6. perform a fresh exact-SHA hostile review,
7. freeze a NEW canonical T5 candidate.

Do NOT redesign T5 unless a concrete correctness contradiction is discovered.

Do NOT widen scope.

Do NOT start T6.

Do NOT merge automatically.

There is NO T7.

---

# 1. Canonical project identity

Project:

**Ether Memories**

Repository:

`andyle777/ether-memories`

Package:

`ether-memories`

Never call the project “Aoife Memories.”

---

# 2. Current canonical lineage

Released v0.6.0:

`493c7b69813e71af749e34bbf950803eb8ee589b`

Frozen T1:

`438a038f1aafbd636777f0dd7fb2c8eec3597e45`

Canonical security-clean T2:

`10ed0855bdee126bebbfa78efaaa2a7db6b26858`

Frozen T3:

`a1da07bf65813e0c57e9368dec4c777be8e57cf3`

Frozen T4:

`bf9808c0222bcf66dea54bafef61e5e846f8957b`

## T5 FINAL PASS MUST START FROM:

`bf9808c0222bcf66dea54bafef61e5e846f8957b`

This is the ONLY valid parent for the final integrated T5 candidate.

---

# 3. Historical standalone T5 proof

Historical T5 candidate:

`e8c45b8fde108e3d50241d8dd30c67118e460968`

Historical draft PR:

`#24`

Historical branch:

`spike/v0.7.0-t5-windows-round11`

Historical base:

`493c7b69813e71af749e34bbf950803eb8ee589b`

Status:

**T5 STANDALONE PROOF — GREEN**

This old candidate remains an immutable comparison/audit anchor.

Do NOT rewrite it.

Do NOT force-push it.

Do NOT pretend it already contains T1–T4.

It explicitly does not.

The final T5 pass must create a new lineage from frozen T4.

---

# 4. New branch

Create a new branch from exact frozen T4:

`feat/v0.7.0-t5-windows-final-pass`

or equivalent clearly named T5 reconciliation branch.

Do NOT branch from PR #24.

Do NOT branch from main.

Do NOT branch from old T5.

Expected lineage:

v0.6
→ T1
→ T2
→ T3
→ T4
→ final reconciled T5

Historical PR #24 stays separate as prior empirical proof.

---

# 5. Preferred reconciliation strategy

Do NOT blindly merge PR #24 wholesale.

Do NOT choose conflict resolution using automatic “ours” or “theirs.”

T4 modifies `DurableEtherMemories.ts` and related public read surfaces, so mechanical merging could silently erase:

- T2 inspection APIs
- T3 previewDreamCycle()
- T4 runDreamCycle()
- exact facade containment
- current T4 tests/security gates

Instead:

1. inspect the complete historical T5 diff,
2. identify every production semantic introduced by T5,
3. reapply those semantics intentionally to the T4 tree,
4. preserve all T1–T4 behavior,
5. compare final T5 behavior against historical T5.

Small cherry-picks are allowed only when proven conflict-free and semantically identical.

Manual reconciliation is preferred where files overlap.

---

# 6. Frozen T5 public contract

The only intentional T5 public API addition is:

```ts
durabilityGuarantee?: "strict" | "recoverable"
```

on the durable-open options.

No new method.

No separate recoverable runtime class.

No second factory.

No T5 public receipt family.

Strict remains the default.

---

# 7. Strict default contract

If:

`durabilityGuarantee`

is omitted:

behavior remains:

`"strict"`

Strict means the existing v0.6 durable contract.

On supported POSIX/local filesystems:

strict may provide full strict confirmation.

On Windows where the required directory-barrier/activation durability cannot be proven:

strict MUST still fail closed.

Do NOT silently downgrade strict to recoverable.

Do NOT fall back per call.

---

# 8. Explicit recoverable mode

Windows recoverability must require explicit caller opt-in:

```ts
durabilityGuarantee: "recoverable"
```

Recoverable mode means:

**state is recoverable across application/Node process termination while the OS/filesystem continue operating.**

It does NOT mean:

- power-loss durability
- kernel crash safety
- BSOD durability
- abrupt hard-reset durability
- controller/cache-loss durability
- disk failure durability
- media corruption durability
- arbitrary external mutation safety
- network filesystem guarantees
- SMB/NAS guarantees
- cloud-sync guarantees

Do not overstate the claim.

---

# 9. Capability selected once

A critical frozen T5 requirement:

The runtime selects/captures its durability capability ONCE before runtime I/O.

That capability/backend selection is then reused consistently across:

- open/bootstrap
- startup recovery
- commit
- WAL acknowledgement
- HEAD activation
- rotation
- GC
- maintenance
- reopen/recovery logic

No per-call capability switching.

No “try strict, then fallback recoverable.”

No platform scatter throughout business logic.

---

# 10. Strict may exceed requested recoverable guarantee

Where a platform/backend can genuinely provide the strict guarantee, requesting:

`"recoverable"`

does not require weakening the implementation.

A backend may deliver a stronger guarantee than requested.

Do NOT intentionally disable strict barriers on supported platforms merely because the caller requested recoverable semantics.

But the observable acknowledgement wording must remain truthful.

---

# 11. Internal weak acknowledgement semantics

Historical T5 introduced weaker internal results where strict durability cannot be established.

Weak commit acknowledgement uses:

`acknowledgment: "process-recoverable"`

Weak activation uses equivalent:

`"process-recoverable"`

Never label weak activation:

`atomic`

Never label weak durability:

`confirmed`

Strict existing semantics retain:

`durability: "confirmed"`

and strict activation semantics such as:

`activation: "atomic"`

where legitimately proven.

Do not blur these categories.

---

# 12. Public mutation return types remain unchanged

Do NOT change ordinary public mutation return types because the backend is recoverable.

The weaker acknowledgement distinction remains internal persistence plumbing.

Do not expose internal acknowledgement unions through the package root.

Public APIs still return the established domain `Result<T>` shapes.

---

# 13. Historical receipt limitation

Receipt ledger v1 does NOT persist the durability profile of the writer that originally created historical state.

Therefore:

**unknown historical durability remains unknown.**

A later strict open must NOT infer that an old receipt was strictly durable.

A later recoverable open must NOT infer the original profile either.

Do not fabricate provenance.

The current runtime may state its current capability.

It may not rewrite history.

---

# 14. No receipt v2

Do NOT solve historical durability ambiguity by introducing:

- receipt v2
- schema migration
- new persisted capability history
- WAL v2
- checkpoint format change
- HEAD v2
- store schema change

Those are outside v0.7.

The frozen T5 proof showed the feature can work without them.

If reconciliation appears to require a persisted format change:

STOP.

That is a RED finding, not permission to expand T5.

---

# 15. Windows recoverable DirectoryIO

Preserve the historical T5 Windows recoverable backend semantics.

Requirements:

- regular-file sync remains required
- directory metadata flush is NOT claimed where Windows cannot prove it
- recoverable `syncDirectory` behavior validates directory existence/entry safety rather than claiming a strict metadata barrier
- same backend/capability used throughout runtime
- no silent strict semantic reuse for weak operations

Do not alter POSIX behavior unnecessarily.

---

# 16. Path safety gate

Preserve the native Windows pre-I/O path safety fence.

Reject unsafe/noncanonical path forms identified during Round 11, including the historical tested classes:

- U+10FFFF problematic path case on affected runtime
- UNC/device namespaces
- ADS
- DOS aliases
- trailing dot components
- trailing space components

Preserve ordinary valid:

- Unicode
- spaces

Do not make the Windows recoverable backend accept path classes the historical T5 candidate intentionally rejected.

---

# 17. Filesystem identity safety

Preserve exact Windows identity/link defenses.

Historical T5 required:

- bigint-capable identity comparison
- high-resolution timestamps where used
- junction ancestors fail closed
- hardlink hazards fail closed
- unsafe aliasing fails closed

Do not weaken these checks for convenience.

---

# 18. No automatic filesystem-type claim

Do not claim universal NTFS detection.

The supported claim remains bounded to the tested local Windows environment.

Do NOT say:

“all Windows filesystems supported”

unless new empirical proof exists.

Do NOT implement speculative filesystem detection during this pass.

---

# 19. Writer authority remains unchanged

Production MUST NOT automatically break:

`writer.lock`

A stale lock after process death must continue to cause authority refusal until explicit operator/test-harness handling occurs.

Historical native crash tests intentionally demonstrated:

1. killed child leaves stale lock,
2. production reopen refuses it,
3. test harness removes the known stale lock only after known child termination,
4. recovery then proceeds.

Preserve that doctrine.

No automatic stale-lock cleanup.

No timeout takeover.

No PID guessing.

---

# 20. State recoverability != authority reacquisition

This distinction must stay explicit:

**state may be recoverable while writer authority remains unavailable.**

A recoverable store after process death does not automatically mean the runtime may reopen writable if the writer lock is unresolved.

Do not conflate these concepts.

---

# 21. Frozen T5 support statement

The final T5 documentation must retain a conservative support statement equivalent to:

Supported:

- tested local Windows environment
- local NTFS-style behavior exercised by the native probes
- Node 22 and Node 24
- abrupt Node/application-process termination
- operating system and filesystem remain operating

Not claimed:

- power loss
- kernel/BSOD crash
- hard reboot
- disk/controller/media failure
- volume corruption
- network/mapped drives
- SMB/NAS
- arbitrary external mutation
- universal Windows filesystem behavior

---

# 22. Preserve T1–T4 APIs exactly

The final T5 candidate must preserve all current T1–T4 public behaviors.

In particular:

T2:

- `explainMemory()`
- `inspectMemoryHealth()`

T3:

- `previewDreamCycle()`

T4:

- `runDreamCycle()`

No regression.

No method removed.

No changed error precedence unless T5 specifically requires durability-open semantics.

---

# 23. Preserve T4 Dream semantics

T5 must not alter Dream behavior.

Preserve:

`ether.dream.v1`

and all T4 semantics:

- hostile plan validation
- exact recapture
- same-snapshot analysis
- no live reads after validation
- selected-only analysis
- deterministic proposal IDs
- exact duplicate suppression
- zero canonical mutation
- zero persistence mutation

Durability mode must not affect Dream result identity.

Same logical state + same plan must produce identical Dream result under strict/recoverable runtime when both are readable.

---

# 24. Durable authority precedence

Existing T2/T3/T4 read-only authority rules remain:

closed:

`CLOSED`

recovery-required:

`RECOVERY_REQUIRED`

before inspection/Dream processing.

T5 must not let recoverable capability bypass authoritative-state uncertainty.

---

# 25. Package version

Keep package/library version:

`0.6.0`

Do NOT bump to 0.7.0.

T6 owns final release metadata.

---

# 26. Persistence format freeze

Must remain exactly unchanged:

Store:

`ether.memory_store.v0.3`

WAL:

v1

Receipt ledger:

v1

HEAD:

v1

Checkpoint:

v1

MemoryContext:

`ether.memory_context.v1`

Portable Record:

`ether.portable_record.v1`

No migration.

---

# 27. Frozen fixture identity

All five canonical fixtures must remain unchanged:

- `persistence-wire-v1.json`
- `portable-record-v1.json`
- `retrieval-golden-v1.json`
- `store-v0.3.json`
- `wal-wire-v1.json`

Compare exact blob/hash identity against frozen T4 and released v0.6 where appropriate.

---

# 28. Runtime dependencies

T5 historically required no new runtime dependency.

Preserve that unless an unavoidable correctness issue is proven.

Do not introduce a Windows helper package merely for convenience.

Use Node/platform primitives already proven by T5.

---

# 29. Security-clean tooling baseline

Preserve current security-clean T4 toolchain:

- Vitest 4.1.11
- Vite 7.3.6
- source-map-js 1.2.2
- Tinypool absent

Required final audits:

Node 22 full audit = 0

Node 22 production audit = 0

Node 24 full audit = 0

Node 24 production audit = 0

Do not reintroduce dependency debt.

---

# 30. Inherited T4 regression baseline

Frozen T4 contains:

**39 files / 1,017 tests**

All 1,017 inherited tests must remain collected and active.

Zero inherited deletions.

Zero new skips.

Zero new todos.

Do not weaken assertions.

T5 tests are additive.

---

# 31. Historical T5 test inventory

Reconcile/port the complete historical T5 production capability test suite.

Historical evidence included:

- 12 production capability tests
- filesystem probe
- six synchronized crash scenarios
- strict/recoverable open behavior
- active-WAL acknowledgements
- historical retry acknowledgement
- rotation
- GC
- maintenance
- reopen/recovery
- capability capture
- file-sync failure
- unsafe paths
- junctions
- hardlinks

Do NOT drop a historical T5 test merely because integration became inconvenient.

If an old test is genuinely obsolete due to T1–T4 structure, document why and replace it with equivalent or stronger coverage.

---

# 32. Native crash scenarios

Rerun all six historical synchronized native Windows crash scenarios on BOTH Node 22 and Node 24:

1. partial WAL write
2. complete WAL write
3. post-file-sync boundary
4. post-public-ACK boundary
5. immediately before rotation HEAD replacement
6. immediately after rotation HEAD replacement

Use semantic synchronization markers.

Do NOT replace with arbitrary sleeps/timeouts.

Child termination must happen at a known protocol boundary.

---

# 33. Stable identity convergence

Each native crash scenario must prove:

- same stable mutation identity
- restart/reopen path
- exact once-only committed effect
- no duplicate effect
- authoritative logical state converges
- receipts/retry semantics remain correct

Do not accept “store opened” as sufficient evidence.

---

# 34. Native Node versions

Required Windows native evidence:

Node:

`22.23.3`

and:

`24.21.0`

or the exact supported versions installed by the current GitHub Windows runner if those patch versions have legitimately changed.

Record exact runtime versions.

If runner versions changed, document the difference instead of pretending they did not.

---

# 35. Native runner

Use a real Windows GitHub runner for native evidence.

Preferred:

Windows Server 2025 current GitHub-hosted runner.

Do NOT replace native Windows evidence with mocked `process.platform`.

Simulation remains supplemental only.

---

# 36. Process crash vs machine crash

Native tests must continue to test:

**process termination**

not simulated machine power loss.

Do not overclaim what `SIGKILL`/TerminateProcess-style child death proves on Windows.

Use accurate language in final report.

---

# 37. File sync remains mandatory

Recoverable mode still requires regular-file synchronization where historically required.

Inject file-sync failure.

Verify:

- failure is observable
- no false acknowledgement
- no incorrectly “process-recoverable” success
- no state publication beyond proven boundary

Do not make recoverable mean “skip fsync.”

---

# 38. Strict mode native regression

On Windows:

strict must still fail closed with:

`DURABILITY_UNAVAILABLE`

or exact existing equivalent.

Do NOT allow reconciliation to silently make strict succeed by using recoverable semantics underneath.

Test this explicitly on Node 22 and Node 24.

---

# 39. Recoverable mode native success

On supported Windows/native environment:

explicit recoverable mode must open and perform the proven operations.

Test:

- fresh create
- existing open
- mutation
- restart
- lost ACK/retry
- rotation
- GC/maintenance
- recovery
- read-only T2/T3/T4 operations

Do not limit the final pass to one mutation happy path.

---

# 40. T4/T5 overlap regression

Because T4 modified the Durable facade/runtime, add explicit integration tests showing recoverable mode preserves:

- `explainMemory()`
- `inspectMemoryHealth()`
- `previewDreamCycle()`
- `runDreamCycle()`

and their exact read-only semantics.

Verify no durability capability field leaks into Dream identity/results.

Verify no Dream operation performs durability I/O.

---

# 41. Capability capture test

Prove runtime capability is captured once.

Add/retain instrumentation showing later environmental/platform changes or injected backend changes do not cause per-operation capability fallback.

No:

strict commit + recoverable rotate

or equivalent mixed-mode runtime.

The selected capability must remain coherent for the runtime lifetime.

---

# 42. Public API containment

Package-root additions from T5 should be minimal.

Expected public change:

`DurableEtherMemoriesOptions.durabilityGuarantee?`

No internal weak acknowledgement types.

No DirectoryIO capability internals.

No filesystem probes.

No Windows adapter internals.

No RecoverableHeadActivationResult-style internal type unless already public by explicit contract — historical T5 intended these to remain internal.

Audit generated declarations and runtime exports.

---

# 43. Runtime export count

T4 had:

**32 runtime exports**

T5 should not increase runtime exports merely because of internal durability plumbing.

Type declaration changes are expected only where necessary for the option.

Record actual final export count.

Any runtime export increase requires justification.

---

# 44. Packed consumer

Installed package test must prove:

- strict default behavior
- explicit recoverable option compiles
- T2 APIs work
- T3 preview works
- T4 run works
- intended declarations compile
- internal Windows/T5 modules are blocked
- persistence internals remain blocked
- no new public mutation semantics leak

On Windows packed consumer:

strict must continue to fail closed if native strict durability is unavailable.

Where practical add recoverable packed consumer coverage separately.

---

# 45. Full modern CI

Run final candidate through:

- Ubuntu Node 22
- Ubuntu Node 24
- Windows Node 22
- Windows Node 24

Each standard CI job must pass:

- npm ci
- toolchain security
- typecheck
- full tests
- worker-exit guard
- build
- npm pack
- packed consumer

No platform skipped.

---

# 46. Native T5 workflow

In addition to ordinary CI, run a dedicated native Windows T5 workflow on exact final candidate SHA.

Both Node 22 and Node 24 must pass:

- production capability tests
- filesystem probe
- six synchronized crash scenarios
- path safety
- strict failure
- recoverable success
- stale-lock refusal
- reopen/recovery convergence

Record workflow run ID and individual job IDs.

---

# 47. T5 historical behavior comparison

Compare the new T4-based T5 candidate against historical T5:

`e8c45b8fde108e3d50241d8dd30c67118e460968`

For every intentional T5 behavior, classify:

- identical
- strengthened
- integration adaptation only
- intentionally removed

“Intentionally removed” requires a concrete correctness reason.

No silent semantic loss.

---

# 48. T4 behavior comparison

Compare final candidate against frozen T4:

`bf9808c0222bcf66dea54bafef61e5e846f8957b`

Verify all T1–T4 behavior remains intact except the deliberate T5 durability-open addition.

Pay special attention to:

- DurableEtherMemories
- facade member list
- open options
- read authority
- Dream execution
- maintenance
- package containment

---

# 49. Do not integrate release metadata

T6 will handle:

- final `0.7.0` version bump
- README final release wording
- CHANGELOG final entry
- RELEASE-MANIFEST
- integration release checks
- tag/release

T5 must not start that work.

---

# 50. Do not merge prior PRs

Do NOT merge:

- PR #24
- PR #25
- PR #26
- PR #27
- PR #28
- PR #29

as part of this pass.

The stacked branch already contains canonical T1–T4 lineage.

Do not reconstruct lineage by merging old PRs.

---

# 51. Draft PR strategy

After final T5 candidate is locally green and pushed:

create a NEW DRAFT PR with:

base:

`feat/v0.7.0-t4-dream-analysis`

head:

the new final T5 branch

Do NOT retarget historical PR #24.

PR #24 remains historical standalone proof.

New PR title suggestion:

`v0.7.0 T5 — reconcile Windows recoverability onto frozen T4`

Keep draft.

Do not merge.

---

# 52. T5 final hostile review

After ALL local, CI and native Windows gates pass, perform a fresh independent hostile review against the exact candidate SHA.

Review specifically for:

- silent strict→recoverable downgrade
- per-call fallback
- capability scatter
- false `durability:"confirmed"`
- weak activation called atomic
- historical provenance upgrade
- receipt v2/schema drift
- WAL format drift
- stale-lock auto-break
- path alias bypass
- junction/hardlink bypass
- recoverable mode skipping file sync
- T4 API loss
- Dream output affected by durability mode
- persistence internals leaked publicly
- runtime export creep
- package version bump
- T5 test removal
- unsupported filesystem claims
- process-recovery claim expanded to power-loss claim
- native workflow false positives
- timeout-based crash synchronization
- fixture drift
- T6 leakage

No unresolved material findings.

---

# 53. Material finding policy

Any material finding must be fixed inside T5.

Do NOT invent T5.5.

Do NOT push it to T6 merely because T6 exists.

T6 is integration/release freeze, not a garbage bin.

If a T5 correctness defect is discovered:

1. reproduce
2. write failing regression
3. fix minimally
4. rerun affected native and standard gates
5. produce a new exact candidate SHA
6. rerun hostile review against that new SHA

---

# 54. RED architectural boundary

If correct Windows recoverable integration now requires:

- WAL v2
- receipt v2
- schema bump
- persisted durability profile
- new activation journal
- automatic lock takeover
- background service
- major persistence redesign

STOP.

Return:

**T5 RED — frozen v0.7 architecture insufficient.**

Do not widen the release.

The original roadmap explicitly required cutting Windows recoverability rather than turning v0.7 into v0.6 Part II.

---

# 55. Expected final status transition

Historical:

**T5 standalone proof GREEN**

`e8c45b8fde108e3d50241d8dd30c67118e460968`

Final desired status:

**T5 CLOSED / GREEN / RECONCILED / FROZEN**

with a NEW exact SHA descended from frozen T4.

That new SHA supersedes historical T5 as the canonical T5 implementation candidate for v0.7 integration.

Historical T5 remains an audit/provenance anchor.

---

# 56. ONLY VALID T6 PARENT

If T5 freezes GREEN:

the new reconciled T5 SHA becomes:

**THE ONLY VALID PARENT FOR T6**

T6 must not branch from:

- T4
- old T5
- main
- a PR synthetic merge SHA

unless explicitly authorized later.

---

# 57. Required final report

Return:

## T5 VERDICT

GREEN / AMBER / RED

## T5 STATUS

If successful:

**T5 CLOSED / GREEN / RECONCILED / FROZEN**

## EXACT LINEAGE

v0.6:

`493c7b69813e71af749e34bbf950803eb8ee589b`

T1:

`438a038f1aafbd636777f0dd7fb2c8eec3597e45`

T2:

`10ed0855bdee126bebbfa78efaaa2a7db6b26858`

T3:

`a1da07bf65813e0c57e9368dec4c777be8e57cf3`

T4:

`bf9808c0222bcf66dea54bafef61e5e846f8957b`

Historical standalone T5:

`e8c45b8fde108e3d50241d8dd30c67118e460968`

New T5 candidate:

Branch:

PR:

## HISTORICAL T5 RECONCILIATION

List each historical T5 production behavior and its final status:

- preserved
- strengthened
- integration-adapted
- removed with justification

## PUBLIC API

Exact new public option/type changes.

Confirm no unexpected runtime exports.

## STRICT CONTRACT

Default:

Windows behavior:

POSIX behavior:

Fallback:

## RECOVERABLE CONTRACT

Capability semantics:

Acknowledgement semantics:

Activation semantics:

Historical provenance limitations:

## FILESYSTEM SAFETY

Path guards:

junctions:

hardlinks:

identity checks:

filesystem claim scope:

## WRITER AUTHORITY

Stale-lock behavior:

Automatic lock breaking:

Authority reacquisition:

## TESTS

Inherited T4:

`1017`

Historical T5 ported:

New reconciliation tests:

Final total:

Files:

Failures:

Skips:

Todos:

Warnings:

## SECURITY

Node22 full audit:

Node22 production:

Node24 full audit:

Node24 production:

## STANDARD CI

Run ID:

Ubuntu22:

Ubuntu24:

Windows22:

Windows24:

## NATIVE WINDOWS T5

Run ID:

Windows Node22:

Windows Node24:

Production capability tests:

Filesystem probe:

Crash scenario 1:

Crash scenario 2:

Crash scenario 3:

Crash scenario 4:

Crash scenario 5:

Crash scenario 6:

## STRICT WINDOWS RESULT

Expected:

`DURABILITY_UNAVAILABLE`

## RECOVERABLE WINDOWS RESULT

Fresh create:

commit:

restart:

lost ACK retry:

rotation:

GC:

maintenance:

T2 inspection:

T3 preview:

T4 run:

## PACKED CONSUMER

Files:

Runtime exports:

Blocked internal paths:

Declarations:

## PERSISTENCE IDENTITY

Store:

WAL:

Receipt:

HEAD:

Checkpoint:

MemoryContext:

Portable Record:

Five fixture identities:

## VERSION

Expected:

`0.6.0`

## HOSTILE REVIEW

Critical:

Important:

Minor:

Unresolved material:

## DEFERRED SCOPE

Only:

- T6
- post-v0.7

NO T7.

## FREEZE DECLARATION

If every gate is GREEN state exactly:

**T5 CLOSED / GREEN / RECONCILED / FROZEN.**

**Historical standalone T5 `e8c45b8fde108e3d50241d8dd30c67118e460968` remains an audit anchor but is superseded as the canonical v0.7 T5 implementation.**

**The new T5 candidate is the ONLY valid parent for T6.**

Then STOP.

Do not begin T6.

Do not merge.

---

# FINAL INSTRUCTION

This is a reconciliation and proof pass, not a redesign.

Preserve the proven T5 contract.

Preserve all frozen T1–T4 behavior.

Do not weaken strict durability.

Do not overclaim recoverability.

Do not fabricate historical durability provenance.

Do not change persisted formats.

Do not break writer authority.

Do not auto-break stale locks.

Do not make Dream behavior depend on durability mode.

Do not defer T5 correctness bugs to T6.

Do not start T6.

Do not invent T7.

**Old T5 proved the concept.**

**This pass proves it belongs safely on the final v0.7 lineage.**