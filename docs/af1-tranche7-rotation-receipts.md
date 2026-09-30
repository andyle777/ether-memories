# AF1 Tranche 7 — Checkpoint Rotation, Durable Receipts and WAL Reclamation

Status: implemented on `feat/v0.6.0-af1-tranche7` (unfrozen). Frozen parents: T6 `77fee0df`,
T5 `86fd96cc`. This document describes the T7 architecture exactly as implemented.

## Invariant

No byte of retired WAL may be deleted until every committed-state fact and
mutation-reconciliation fact needed from it exists durably in the new
authoritative lineage. P6 (atomic HEAD activation) is the sole irreversible
rotation commit point: before P6 every new artifact is inert; after P6 every
retired artifact is inert and reclaimable.

## Frozen formats (unchanged by T7)

- HEAD format and framing (`ether.store_head` v1);
- checkpoint generic framing and the production snapshot payload profile
  (`ether.snapshot.payload.v1`);
- WAL v1 wire format and the frozen WAL scanner (including adjacent
  byte-identical physical duplicate deduplication);
- all frozen fixtures.

T7 adds exactly one new durable artifact family (receipt ledgers) and derives
lineage binding from checkpoint identity instead of changing any frozen format.

## Durable layout addition

```
store/
  receipts/
    receipts-{ledgerDigest}.bin          # authoritative cumulative ledger
    .receipts-{ledgerDigest}.candidate  # candidate (transient, inert)
```

`receipts/` is a permanent durable namespace. `.private/` remains disposable
scratch and is never receipt authority. Rotation scratch uses the frozen T5
deterministic-namespace convention (`rotation-{candidate,checkpoint,head,sort}-{NNNNNN}.{bin,run}`,
128 slots) swept at P0 and P7 of every rotation.

## Receipt ledger wire (stream-framed)

Physical representation (canonical JSON, LF-delimited, never one monolithic
JSON value):

```
canonicalJSON(header) "\n"
[ canonicalJSON(entry) "\n" ] * entryCount
```

- UTF-8; canonical JSON with exact allowed key sets; final LF required
  (truncated tail = corruption).
- header: `{format:"ether.receipts", version:"1", storeId, epochId,
  retiredCheckpointDigest, predecessorLedgerDigest, entryCount, payloadBytes}`.
- entry: `{mutationId, intentDigest, txId, transactionDigest, operations}` —
  operations reuse the frozen WalOperation conventions (inline
  `ether.data` envelope where legal, `OBJECT_REFERENCE` for large effects).
  No second effect/result format exists.
- whole-file SHA-256 = content address = filename = rotated `checkpointId`.
- bounds: header 4096 B; entry line `WAL_LIMITS.aggregatePayloadBytes + 8192`.
- failures (malformed UTF-8/JSON, noncanonical form, extra/missing keys,
  count/payload mismatch, digest mismatch, non-increasing order, duplicate
  mutationId) are all `PERSISTENCE_CORRUPTION`. Authoritative receipt history
  is never truncated or repaired.

## The single comparator

`compareMutationIds` — unsigned lexicographic order over canonical UTF-8
`mutationId` bytes — is used identically by: ledger validation, the retiring
segment external sort, the cumulative two-way merge, lookup early
termination, and source-aware history verification. Never locale order, never
platform collation. An authoritative ledger must be strictly increasing.

## Duplicate semantics (source-aware)

- Adjacent byte-identical physical WAL frames: frozen benign dedup survives
  only inside the WAL scanner (unchanged).
- Once converted to logical receipt history: duplicate `mutationId` within the
  ledger, the same `mutationId` in receipt history AND the active WAL, or
  conflicting identity/digest reuse anywhere = `PERSISTENCE_CORRUPTION`
  (`mutationHistoryVerification.ts`, bounded external sort + two-pointer
  walk against the streamed ledger; fixed resource envelope independent of
  history size).

## Lineage binding and the hex namespace

- Rotation-created checkpointIds are exactly 64 lowercase hex characters and
  equal the content digest of the authoritative cumulative ledger.
- Pre-T7 producers use non-hex ids only (`checkpoint-initial` in the T6 public
  bootstrap, `checkpoint-a` in test bootstrap). By construction no frozen-valid
  store can contain a 64-hex checkpointId, so the pattern is a safe
  discriminator, reserved from T7 onward (permanent regression test).
- Startup rule: hex checkpointId → `receipts/receipts-{checkpointId}.bin` is
  REQUIRED and fully verified (store/epoch binding, digest, order, object
  roots); missing/corrupt/mismatched history = fail closed
  (`PERSISTENCE_CORRUPTION`). Non-hex checkpointId → pre-rotation lineage,
  zero required history. HEAD never mentions receipts.

## Rotation protocol (P0–P7, writer authority held throughout)

- **P0 authority**: acquire writer authority; verify the current HEAD
  lineage matches the runtime's published epoch; sweep rotation scratch.
- **P1 capture**: capture the exact immutable published generation
  (canonical snapshot bytes + committed tip). No state mutation.
- **P2 scan**: frozen WAL scan proving the segment is anchored to exactly the
  current checkpoint AND terminates at exactly the captured tip; entries
  stream into a bounded external sorter (512-entry chunks → sorted runs).
- **P3 sort + merge**: finish the sort; stream the two-way merge of the
  previous verified cumulative ledger and the sorted retiring segment into the
  new candidate ledger (precomputed header, strictly increasing under the
  frozen comparator, duplicate anywhere = corruption); compute the ledger
  SHA-256.
- **P4 checkpoint**: `checkpointId := ledgerDigest`; encode the new
  checkpoint exactly once from the same store/epoch, the captured tip and the
  captured generation bytes.
- **P5 activation**: write candidate → fsync → atomic activation into FINAL
  paths (ledger, then checkpoint), byte-exact readback verification, and
  directory syncs — all before HEAD activation. HEAD never references an
  artifact that is not already durable and verified at its final path.
- **P6 HEAD activation (irreversible)**: frozen candidate → byte-exact verify
  → `activateFile` → directory barriers. After P6 the new lineage is
  authoritative and is never reported otherwise.
- **P7 reclamation (idempotent, post-activation)**: remove the retired WAL,
  obsolete checkpoint, predecessor ledger and rotation scratch; barriers.
  Failures (including injected crashes) return
  `{activated: true, phase: "post-activation"}` and never claim old authority;
  the next rotation/recovery sweeps debris safely.

### Crash matrix

Every crash point leads to the old lineage remaining authoritative (pre-P6:
P0/P1/P2/P3-sort/P3-merge/P4/P5-ledger/P5-checkpoint/P6-boundary) or the fully
durable new lineage being authoritative (P6 completed, P7). Never a
half-lineage. Pre-P6 leftovers are inert orphans (unreferenced artifacts and
deterministic scratch swept on the next attempt); cross-named stale artifacts
(e.g. an old WAL left by a P7 failure) are unreferenced and therefore inert
under the frozen orphan semantics.

## Startup recovery integration

After checkpoint decode and before the WAL pass, recovery opens the
authoritative ledger for the lineage (zero history for non-rotated roots),
fully verifies it, and validates every referenced payload object as a
permanent reachability root (missing/corrupt = fail closed). Receipt history
is never replayed into application state; it exists only for mutation
identity/reconciliation. Each scanned WAL transaction is recorded into the
source-aware history verifier (reset across tail-repair passes exactly like
the frozen mutation index); exact receipt↔WAL identity verification completes
before publication.

## Mutation reconciliation after reclamation

The logical mutation-history namespace is active WAL ∪ cumulative receipts.
Lookup order: active WAL first, then the ledger. Same `mutationId` + same
intent digest → the original committed receipt with effects resolved from the
receipt's exact committed operations (`OBJECT_REFERENCE`s resolve through the
immutable payload-object machinery); conflicting intent → corruption; absent
→ detached preparation. All durable mutation kinds reconstruct their original
transaction results after rotation, WAL deletion, later updates/deletions,
restart and multiple rotations. No Core re-execution; no generated IDs.

## Active-WAL envelope

`MAX_ACTIVE_WAL_BYTES = 64 MiB`, derived (see `receiptLedger.ts`) from the
frozen 256 MiB working budget and frozen expansion constants, all pinned by a
derivation test: F_MIN ≥ 500 measured via the frozen encoder; R_IDX = 512
(frozen mutation-index record bound); restart worst scratch
`2 × B × 512/500 = 2.048 × B` (131 MiB at 64 MiB); rotation worst scratch
`1.25 × B` (80 MiB). Any accepted segment can subsequently restart AND rotate
under default budgets.

A commit whose EXACT prospective frame (same transport plan as the commit
performs, encoded with the store's real identity fields) would push the active
segment past the envelope fails precommit — before payload-object durability,
WAL append, tip advancement or generation publication — with
`RECOVERY_REQUIRED` + `{reason: "resource-limit", phase: "precommit-validation"}`,
and requires an explicit `rotate()`. The runtime stays ready.

## Runtime surface

`rotate()` joins the public durable facade (17 → 18 approved members): it
serializes behind the single-flight queue with mutations, reads continue from
the immutable generation, the published generation (state and tip) is
identical across rotation, and a post-activation cleanup failure is reported
with `rotationCommitted: true`. Rotation does not republish the generation and
introduces no lease or coordination beyond the frozen single-writer authority.

## Historical object roots (binding for future GC)

Any payload object referenced by an authoritative historical receipt is an
indefinite reachability root: present + digest-correct = valid; missing or
corrupt = corruption (fail closed). Future object-GC work MUST include the
authoritative receipt ledger in its root set — old mutation reconstruction
depends on these objects surviving forever.

## Non-goals (out of T7 scope)

Payload-object GC; tombstone physical reclaim; legacy migration; backup/restore
and restore epochs; WAL v2; distributed writers; Dream Cycle; graph redesign;
automatic rotation thresholds (rotation is explicit).

## Stop conditions honored

No frozen format, fixture, WAL scanner semantic, T5 index behavior or T6
facade/validation/identity behavior was changed. The only T6-surface change is
the approved addition of the `rotate()` facade member (T7 is unfrozen and this
was pre-approved in the T7 architecture decisions).
