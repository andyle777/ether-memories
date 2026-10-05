# AF1 Tranche 6 — Live Durable Runtime Integration

This document records the Tranche 6 architecture: the frozen T1–T5 persistence
machinery made usable by the actual live runtime, without changing any frozen
persistence wire semantics. It includes the post-review RED repairs
(precommit complete-post-state validation, explicit mutation identity,
cross-runtime race reconciliation and a clean public declaration surface).

## Scope (approved)

Live Core / concurrency integration only. Explicitly excluded (future lifecycle
work, unchanged from T5): checkpoint rotation/replacement, WAL compaction or
reclamation, cross-checkpoint mutation receipts, payload-object GC, tombstone
physical reclaim, migration, backup/restore epochs, distributed writers,
WAL v2, graph redesign, Dream Cycle, FoundationLinker semantic changes, and any
native Windows durability claim.

## Public API

- `openDurableEtherMemories(options)` — explicit asynchronous durable factory.
  Legacy `new EtherMemoriesCore(...)` with `StoragePort`/`storagePath` is
  untouched; durable mode is opt-in and structurally distinct.
- `createMutationId(): string` — narrow convenience helper that generates the
  CALLER's stable logical mutation identity before the durable operation is
  invoked. The runtime never generates an invisible identity on the caller's
  behalf: total-ACK-loss idempotency is only possible for an identity the
  caller already possessed.
- `DurableEtherMemories` — the public runtime interface (methods, state, tip).
  The implementing class, the frozen persistence machinery beneath
  (`StartupRecovery`, `ProductionWalStore`, `prepareCoreMutation`, …) and every
  protocol-testing injection point (`openDurableEtherMemoriesInternal`,
  `DirectoryIO`/`WalIO` dependencies, recovery-index byte budget) are internal
  and absent from the package-root declarations; the T6 probe inspects the
  generated `dist/index.d.ts` to prove it.
- `DurableRuntimeState` is the public observable lifecycle:
  `ready | recovery-required | closed`. "Opening" is factory-internal; no
  runtime object escapes before authoritative recovery succeeds.

`options.openMode` (`"auto"` default, `"create"`, `"existing"`) is the bootstrap
policy. An existing, partial, legacy, unknown or corrupt store is never
overwritten or reinitialized: a legacy snapshot file at the directory path
fails closed as `PERSISTENCE_CORRUPTION`; a fresh open while writer authority
is held elsewhere fails closed as `WRITER_BUSY`.

## Startup sequence

```
durable configuration
  -> FsDurableStore.inspect()
       missing    -> [policy allows] one-time bootstrap: initial snapshot ->
                     production checkpoint payload -> frozen HEAD/checkpoint
                     activation (existing initialize path)
       active    -> continue
       otherwise -> fail closed
  -> StartupRecovery (authoritative, private until complete)
  -> recovered frozen committed generation + exact tip
  -> runtime becomes writable ("ready")
```

No live writable Core, no canonical mutable state exposure, no caller mutation
and no derived indexes exist before successful recovery; recovery failure
fails closed with no runtime object escaping.

## State ownership

Exactly one authoritative in-memory committed generation per runtime
(`StateRoot`: snapshot, canonical payload bytes, exact tip, notes/diary/graph
modules, rebuilt retriever index; frozen). The WAL remains the persistence
authority. No live optimistic mutation and no rollback path exists: the live
Core object only ever executes inside `prepareCoreMutation`'s detached
ephemeral Core (frozen T5 semantics).

Recovery, live publication and PRECOMMIT VALIDATION all construct generations
through the one shared `validateStateRoot` path (extracted from
`StartupRecovery`), so they cannot drift. The T6 probe proves it: the
live-published snapshot payload bytes and tip are byte-identical to what an
independent recovery derives.

The durable runtime does NOT expose the legacy mutable module references
(`notes`, `diary`, `graph`, `linker`, `condensation`): state changes only
through the durable path. This is enforced architecturally, not just at
compile time: the object returned to callers is a frozen plain-object FACADE —
never the implementation instance. Its members are closures over a completely
internal implementation class whose every field is an ECMAScript `#private`
field (canonical generation, store, lifecycle, queue, directory, identity,
injected I/O dependencies). No property, symbol, descriptor, prototype or
constructor path leads from the facade back to the implementation:
`runtime.constructor` resolves to the harmless `Object`; there is no
`readable()`, no `generation`, no store, no injected-I/O handle and no
bootstrap/open capability reachable from the public object. The facade is
created only after approved inspection/bootstrap and successful startup
recovery: no public runtime object can exist in a false ready state. Reads
(`queryMemories`, `queryMemoriesDetailed`, `buildMemoryContext`,
`getSystemState`, `exportData`) serve the committed generation with
legacy-shaped results, and returned values are deep clones: mutating any
returned result never changes canonical state or WAL (asserted by permanent
tests, including Codex's exact prototype-method and constructor attacks and a
bounded object-graph escape scan).

## Mutation identity (required)

Every durable mutator takes a REQUIRED caller-stable logical mutation ID:
`addMemory(input, mutationId)`, `updateMemory(id, patch, mutationId)`,
`promoteCandidate(id, mutationId)`, `deleteMemory(id, mutationId)`,
`addDiaryEntry(input, mutationId)`, `updateDiary(id, patch, mutationId)`,
`deleteDiary(id, mutationId)`, `addGraphEdge(..., mutationId)`. A missing or
empty identity fails with `INVALID_INPUT` and nothing is attempted.

The identity is captured exactly once at the public boundary and never
regenerated; ambiguous outcomes surface it in error details for an exact
retry. Caller mutation identity remains distinct from WAL transaction identity
(frozen T5 distinction). Two intentionally different identities are two logical
commands and commit two transactions.

## Mutation sequence

```
ready state, else predictable failure
  -> capture the caller's required mutationId
  -> in-process single-flight slot
  -> base = committed tip; base snapshot = committed generation
  -> ProductionWalStore.commitMutationDetailed
       command validation / intent digest / detached preparation /
       precommit complete-post-state validation      (all pure precommit)
       already-committed (same intent) -> committed effect set from the active WAL
       conflicting intent             -> PERSISTENCE_CORRUPTION, nothing changes
       absent                          -> payload-object durability when
                                          required -> WAL commit
  -> publication of the prevalidated generation with the exact committed tip
  -> legacy-shaped result reconstructed from the exact committed effects
```

Durability precedes visibility. A failed durable mutation leaves the published
committed generation completely unchanged, including every derived index.

### Precommit complete-post-state validation (RED 1)

No transaction may become durable if its complete deterministic post-state
cannot be reconstructed and published by startup recovery; individual
WAL-operation validity is insufficient. After detached preparation produces the
complete AFTER snapshot and BEFORE payload-object durability or WAL authority
can advance, `validateStateRoot` runs the exact same deterministic construction
recovery and live publication use: production canonical snapshot size, the
frozen 8 MiB StateRoot/checkpoint-compatible resource bound, graph
normalization/consistency, Notes/Diary reconstruction and committed
retrieval-index rebuild. Validation failures carry `phase:
"precommit-validation"` (with the frozen `resource-limit` reason where
applicable): nothing has been written, the WAL/tip/objects are unchanged, the
runtime stays ready, and subsequent valid mutations succeed.

Note on the effective bound: the frozen v0.5 FoundationLinker mirrors an
unsynopsized note's content into its graph node label, so the canonical
post-state is roughly TWICE the note content. A ~4.3M-character multi-byte
note is rejected precommit; cumulative small mutations are rejected at the
exact crossing mutation; the committed history below the bound remains
recoverable.

### Result reconstruction (lost ACK / restart retry)

The original call's result is never derived from current state and never by
re-executing Core. The committed transaction's resolved effect set — already
what deterministic replay consumes — is looked up from the active WAL
(bounded scan under writer authority) and selected by command kind:

| Command | Result source |
|---|---|
| `note.put`, `note.update` | the single committed `ether.note.put` effect |
| `promote` (mapped to `note.update {status:"active"}`) | the single committed `ether.note.put` effect |
| `diary.put`, `diary.update` | the single committed `ether.diary.put` effect |
| `note.remove`, `diary.remove` | void, after verifying the committed remove effect |
| `graph-edge.put` | the single committed `ether.graph-edge.put` effect |

A put-kind effect set without exactly its one effect fails closed as
`PERSISTENCE_CORRUPTION`. No WAL v1 change, no regenerated IDs/timestamps.

### Durable/legacy input distinction

Durable commands belong to the frozen persisted plain-data domain
(descriptor-safe validation). A live-only value such as `expiresAt: Date` is
rejected fail-closed; pass ISO strings. This is an explicit durable-mode
distinction, not a silent conversion.

## Concurrency model

- In-process: one mutation in flight (single-flight). Concurrent submissions
  wait and execute against the then-current committed tip; readiness is
  rechecked when each queued mutation begins, so a queued mutation submitted
  while ready does not execute after an earlier operation moved the runtime to
  `recovery-required`. Public commands carry no base, so this is not a rebase.
- Same mutationId + same intent (concurrent, retried, or racing another
  runtime): the authoritative receipt lookup returns the original committed
  transaction — no second transaction, no new IDs, no new objects.
- Same mutationId + conflicting intent: `PERSISTENCE_CORRUPTION`, fail closed.
- Cross-runtime race (lookup observed absent, another runtime committed the
  same identity before the commit acquired authority): the commit-boundary
  failure is reconciled by an authoritative re-lookup BEFORE classifying
  corruption — same stable intent digest resolves the winner's committed
  receipt (exactly one WAL transaction, never a false corruption result);
  conflicting intent is genuine `PERSISTENCE_CORRUPTION`; a still-absent
  identity yields the genuine stale-base result. Uses the frozen scanner
  machinery only; single-writer authority is not weakened.
- Lost ACK (ambiguous durable outcome): the mutation fails `RECOVERY_REQUIRED`
  and the runtime enters `recovery-required`. Reads keep serving the last
  committed generation; `recover()` is required; the retry with the same
  mutationId then resolves the original receipt. Recovery is never performed
  transparently inside an unrelated mutation.
- Stale base (another runtime advanced the tip): `STALE_TRANSACTION_BASE`,
  retryable, never a silent rebase; `recover()` then retry.
- Already-committed receipts are reported as a normal success ONLY when the
  runtime's published generation already includes that committed transaction
  coherently. If the durable history is ahead of the published generation
  (lost ACK, cross-runtime race), the runtime enters `recovery-required` and
  returns `RECOVERY_REQUIRED` carrying the mutation identity and committed tip
  for a deterministic retry; never a normal success over a stale live
  generation.
- Authority contention: `WRITER_BUSY`/`READ_ONLY_LOCKED` surface unchanged
  from the frozen T4 writer protocol. No new locks, leases or takeover.
- Readers never lock; publication is a single synchronous reference
  assignment, so readers observe the old or the new generation, never a
  mixture.

## Lifecycle states

`ready` — normal operation.
`recovery-required` — committed reads and `recover()` available; durable
mutations fail `RECOVERY_REQUIRED`.
`closed` — deterministic release; every operation fails `CLOSED` (a
deliberate lifecycle error, not a durability failure).

Close is deterministic FIFO drain: it waits for every previously submitted
operation to complete, then closes; operations submitted afterwards fail
`CLOSED` and never execute. Close is idempotent; no durable session leases or
TTL takeover exist. A second runtime may open the store after close.

`recover()` returns the runtime to `ready` by re-running authoritative
recovery and publishing the recovered committed generation.

## Compatibility

- Legacy `EtherMemoriesCore`, `StoragePort`, `FsJsonStorage`, `save()/load()`,
  `importData` rollback semantics: unchanged and still green.
- `StoragePort.durable` (`DurableStorageOperations`) remains an unimplemented
  future contract; durable mode is not a StoragePort.
- No implicit migration: legacy snapshots are never converted by durable open.
- WAL v1, codecs, fixtures, FoundationLinker: exactly frozen.

## Verification receipts

- New suites: `tests/durable-runtime.test.ts` (26 tests, including the
  ~4.3M-character reproducer, cumulative-bound crossing, just-under/just-over
  boundaries, required-identity contract, queue/close/alias attacks, and the
  runtime-encapsulation regressions: no own keys/descriptors, prototype
  traversal, Codex's exact `runtime.generation` attack, bounded object-graph
  escape scan, detached results), `tests/durable-runtime-concurrency.test.ts`
  (8 tests, including the three cross-runtime pause-race reproducers).
- Probe: `node scripts/af1-tranche6-live-runtime-probe.mjs
  --simulate-directory-barriers` — bootstrap, 290+ live public mutations across
  all command kinds, interleaved reads, an 80 KB object-backed mutation, a
  rejected over-bound precommit mutation, a concurrent pair, injected lost ACK
  + explicit recovery + same-identity retry, cross-runtime stale base,
  close, recovery reopen with exact tip/snapshot byte equality,
  recovery-confirmed transaction count, and package-root runtime + declaration
  (`.d.ts`) surface gates.
- Frozen gates carried forward: full suite (T5 461 baseline + T6 tests),
  focused 388/388, mutation-index 38/38, ORION 14/14, Tranche 4 probe,
  Tranche 5 1,050-transaction probe, all five frozen fixtures byte-identical.

## Known limitations

- Native Windows directory durability remains unavailable; all probes on
  win32 run with `--simulate-directory-barriers`. No native power-loss claim.
- Mutation-receipt reconciliation remains scoped to the active WAL (T5).
- The durable runtime does not expose `condensation`/bulk import paths;
  `purgeExpired`, `importPortableRecords` and `importData` are absent from
  the durable surface by design (compound/bulk operations are future work).
- Precommit validation constructs the complete candidate generation on every
  mutation, so mutations on multi-megabyte stores pay the canonical
  encode/index rebuild per commit. Correctness first; optimization is future
  work.
