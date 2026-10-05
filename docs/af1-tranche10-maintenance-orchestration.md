# AF1 Tranche 10 — Explicit Deterministic Maintenance Orchestration

Project: **Ether Memories** (`ether-memories`).

Status: frozen by explicit owner decision on 5 October 2026, following the final
adversarial referee's GREEN result with zero Critical or Important findings.
Frozen T10 code-lineage SHA: `6f298aea2cd0278078bf49344f75807355a4e09b`.
Frozen parent: T9 `5db87810b60b6693f0953402cdc06f980f5691af`.
Branch: `feat/v0.6.0-af1-tranche10`.

Post-freeze naming/status documentation cleanup is a separate additive commit;
it does not replace the frozen T10 code-lineage SHA. The freeze does not merge
PR #17, mark it ready, tag, publish, or release. Further T10 code changes require
a genuine post-freeze correctness defect; other work is deferred beyond v0.6.0.
This document describes the frozen T10 architecture exactly as implemented.

## Scope (approved)

One public facade member: `runMaintenance()` (facade 19 → 20). No public
`maintenanceStatus()`. No background maintenance of any kind, no timers, no
process/signal handlers, no persisted maintenance policy or counters, no new
persisted formats, no new destructive authority mechanism. The architectural
principle is frozen: POLICY decides WHEN (one explicit deterministic rotation
recommendation derived under the held queue slot); frozen Tranche 7/8 proofs
decide WHETHER an operation is safe.

## Public API

```text
runMaintenance(): Promise<Result<DurableMaintenanceReceipt>>
```

`DurableMaintenanceReceipt` is root-exported (consistent with the recovery,
rotation and GC summary exports). Its `plan` block is an OBSERVATION derived at
decision time under the maintenance queue slot — never a durable snapshot or an
authority receipt: a no-op means maintenance was not recommended from the
active-WAL state observed during this run, NOT that another conforming writer
cannot append afterward. Mutation admission keeps its own exact precommit
envelope check; every destructive operation still acquires the frozen T7/T8
writer authority.

Success and no-op both return `ok(receipt)` (`performed: []` for a no-op). A
genuine failure is NEVER reported through `ok(...)`: the EXISTING underlying
error is returned with its code, message and every original detail, plus only
additive orchestration context — `maintenanceStage: "rotation" | "garbage"`,
and `completedRotation` (the successful rotation summary) when a fully
committed rotation precedes a GC failure, so the committed rotation is never
hidden and never implied to have rolled back. No `stoppedAt` field, no second
public error taxonomy.

## Deterministic rotation recommendation

The source of truth for the envelope is the CONFIGURED instance value
`ProductionWalStore.maxActiveWalBytes` (production default
`MAX_ACTIVE_WAL_BYTES` = 30 MiB) — never an independent constant. A narrow
internal observation, `observeActiveWalEnvelope()`, factored from the precommit
envelope check, performs the same HEAD → selected `wal-<checkpointDigest>.bin`
→ stamp-size read and returns `{ activeWalBytes, envelopeBytes, storeId }`. The
precommit path reuses the identical observation; its exact prospective-frame
encoding and hard admission check are semantically unchanged and remain the
SOLE admission authority. The observation is unlocked and grants no writer or
destructive authority; the decision is recomputed while `runMaintenance` owns
its queue slot.

Threshold proof (frozen invariants only):

1. `WAL_LIMITS.frameBytes = 1 MiB` and `encodeWalFrame()` rejects any frame
   whose declared size exceeds it — every legal WAL v1 frame is ≤ 1 MiB.
2. `effectiveNextFrameBound = min(WAL_LIMITS.frameBytes, envelopeBytes)`.
3. `rotationRecommended` iff `activeWalBytes + effectiveNextFrameBound >
   envelopeBytes` (equivalently `headroomBytes < effectiveNextFrameBound`),
   STRICT, matching the frozen precommit gate where EQUALITY IS ADMITTED:
   exactly enough room for a maximal legal frame is not exhaustion.
4. Under the default 30 MiB envelope the effective bound is exactly 1 MiB.
   A sub-cap configured envelope never recommends for an EMPTY WAL
   (`0 + envelope > envelope` is false), so repeated empty rotations are
   impossible; after a rotation the empty active segment is always a no-op.
5. A frame larger than a configured small envelope can never be made
   admissible by rotation; the exact precommit gate rejects it unchanged.

No wall clock, no counters, no persisted policy. The recommendation is
conservative only: the mutation path still performs its own exact frame
computation.

## Orchestration (one queue slot)

`runMaintenance()` calls `enqueue()` exactly once and NEVER calls the public
`rotate()`/`collectGarbage()` (they enqueue themselves; nested entry would
self-deadlock). Inside the single hold: reject CLOSED; require ready runtime
and published generation; derive the plan; no recommendation → no-op receipt;
otherwise invoke `rotateDurableStore(...)` DIRECTLY (the same non-enqueue
module helper `rotate()` calls); route the outcome through the ONE shared
internal classifier; on failure stop immediately and return the existing error
plus `maintenanceStage: "rotation"`; ONLY after a fully successful rotation
invoke the existing Tranche 8 collector directly; apply the frozen GC
precedence exactly; on GC failure return the existing error plus
`maintenanceStage: "garbage"` and `completedRotation`; on complete success
return the combined receipt with `performed: ["rotation", "garbage"]`. No
priority queue, no nested queue execution, no reordering of queued mutations.

## Shared rotation classifier

`classifyRotationFailure` is the ONE internal routing table, factored from the
frozen `rotate()` wrapper branches and consumed by BOTH public `rotate()` and
public `runMaintenance()` — no duplicated branch logic. Cases: ordinary
pre-activation failure (runtime stays ready, error returned verbatim);
`details.activated === true` → committed-pending-cleanup (additive
`rotationCommitted: true`, runtime stays ready);
`activationState === "head-renamed-durability-unconfirmed"` → additive
`rotationDurabilityUncertain: true`, recovery-required; `RECOVERY_REQUIRED`;
`STALE_TRANSACTION_BASE` → recovery-required. Public `rotate()` remains
observable-equivalent to frozen Tranche 7: unmarked failures are returned
verbatim; marked failures keep code, message and details with only the
additive marks. Committed-pending-cleanup STOPS maintenance before GC: only a
fully successful rotation proceeds.

## GC failure routing (frozen Tranche 8 precedence, unchanged)

`gcFailureRequiresRecovery` is the shared internal statement of the frozen
precedence — authority-release uncertainty > authoritative data uncertainty >
ordinary maintenance failure, with the conservative code-based classification
when no GC disposition exists — consumed by both `collectGarbage()` and
`runMaintenance()`. GC maintenance failures alone leave the runtime READY with
exact partial-reclaim details; authoritative corruption and authority-release
failures move it to recovery-required. No T8 algorithm, phase, root-set proof,
authentication or lifecycle semantic changed. GC runs through `runMaintenance`
ONLY as the follow-on to a fully successful rotation; no GC threshold exists;
public `collectGarbage()` remains unchanged and independently callable.

## Cross-runtime observation semantics

The plan is an observation, not a durable authority receipt. Another conforming
runtime may append after a no-op; the exact precommit gate still rejects
crossing frames; destructive operations still acquire the frozen authority. A
stale `writer.lock` is NEVER broken automatically: `WRITER_BUSY` passes
through with the runtime remaining ready, until explicit operator handling.

## Crash model

ZERO new persisted formats, artifacts, counters or state machines.
Interruption mid-`runMaintenance` is exactly interruption inside the frozen
T7 rotation crash model (pre-P6 inert, post-P6 idempotent, scratch swept by the
next rotation/recovery) or the frozen T8 GC crash model (already-dead files,
idempotent retry, ephemeral per-record authentication discarded on restart).
A lost maintenance receipt has no reconciliation semantics; retry is a plain
new invocation. Crash recovery remains Tranche 5 startup recovery.

## Verification

`tests/maintenance-orchestration.test.ts` (21 tests): 20-member facade pin;
direct classifier unit matrix (all rotation cases + GC precedence); default
envelope; exact equality boundary; first byte beyond headroom; 1 MiB envelope;
sub-cap envelope; empty-WAL no-op; successful rotation→GC; ordinary rotation
failure (stops before GC, disarmed retry succeeds); committed-pending-cleanup;
HEAD durability uncertainty; rotate()/runMaintenance() routing equivalence;
GC maintenance failure with `completedRotation`; GC authoritative failure; GC
authority-release failure; single-flight queue serialization with mutations;
foreign `writer.lock` contention; exact precommit envelope admission
unchanged (crossing mutation rejected, same identity succeeds after
maintenance); a frame individually larger than an empty tiny envelope remains
rejected; a no-op under a foreign lock acquires no authority; a stale generation
fails closed before GC, requires explicit recovery, and rejects after close.

Compiled probe: `node scripts/af1-tranche10-probe.mjs
--simulate-directory-barriers` — 10,000+ durable mutations with maintenance
after every batch, repeated threshold→rotation→GC cycles, cold restart after
every batch, fault injections before P6 / after P6 / between rotation and GC /
in GC phases with asserted hook counts and retry-after-interruption. The hard-kill
child signals only after the original mutation's actual WAL write, file sync,
and directory barrier, then blocks before ACK. Recovery refuses its retained
writer lock until explicit operator handling; two retries of the original ID
must reproduce the original generated note with unchanged full tip and bytes.
The soak preserves the acknowledged seed, captures the last live snapshot and
full tip before close, and compares the first cold recovery against them.
Actual WAL/scratch opens and successful closes are tracked, with a real idle
file-handle positive control; active-resource counts are diagnostics only, not
descriptor evidence. This is not process-wide native handle enumeration.
Memory and timing data are diagnostic only. `--tail-only` is an explicitly
labeled debugging mode and never evidence for the 10,000-mutation soak.

## Verification receipt correction

ORION hashes frozen fixture text in canonical LF form, using the committed-blob
digests pinned by the release-integrity tests. LF and synthetic CRLF inputs must
produce the same identities; changed content must still fail verification.
This does not normalize or change any decoded persistence wire bytes.

The containment audit imports every emitted `dist/**/*.js` module. A clean build
emits **50 modules**, not the earlier receipt's 51. The earlier local `dist`
included a stale `core/foundationEffects.js` with no current source counterpart;
TypeScript build does not remove stale outputs. Clean-build/package inventory
verification excludes that artifact and the probe reports its actual audit count.

## Non-goals (out of T10 scope)

Background or implicit threshold-triggered maintenance; automatic/background
rotation; automatic GC thresholds; public maintenanceStatus(); persisted
maintenance policy/counters; timers, intervals, schedulers, microtask or
setImmediate background maintenance; process/signal handlers; automatic
writer-lock breaking; receipt/P7 ORPHAN-debris sweeping (known P7 cleanup is
solved; orphan-debris sweeping remains deferred); WAL v2; backup/restore;
migration; tombstones; snapshot compaction; distributed writers; any new
destructive authority mechanism; any native Windows power-loss claim.
