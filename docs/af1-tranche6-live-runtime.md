# AF1 Tranche 6 — Live Durable Runtime Integration

This document records the Tranche 6 architecture: the frozen T1–T5 persistence
machinery made usable by the actual live runtime, without changing any frozen
persistence wire semantics.

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
- `DurableEtherMemories` — the durable runtime class. The frozen persistence
  machinery beneath (`StartupRecovery`, `ProductionWalStore`,
  `prepareCoreMutation`, …) remains unexported from the package root.
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

Recovery and live publication construct generations through the one shared
`buildStateRoot` path (extracted from `StartupRecovery`), so they cannot drift.
The T6 probe proves it: the live-published snapshot payload bytes and tip are
byte-identical to what an independent recovery derives.

The durable runtime does NOT expose the legacy mutable module references
(`notes`, `diary`, `graph`, `linker`, `condensation`): state changes only
through the durable path. Reads (`queryMemories`, `queryMemoriesDetailed`,
`buildMemoryContext`, `getSystemState`, `exportData`) serve the committed
generation with legacy-shaped results.

## Mutation sequence

```
ready state, else predictable failure
  -> capture mutationId exactly once (caller-provided or created at this boundary)
  -> in-process single-flight slot
  -> base = committed tip; base snapshot = committed generation
  -> ProductionWalStore.commitMutationDetailed
       already-committed (same intent) -> committed effect set from the active WAL
       conflicting intent             -> PERSISTENCE_CORRUPTION, nothing changes
       absent                          -> detached preparation -> payload-object
                                          durability when required -> WAL commit
  -> buildStateRoot(prepared post-state, committed tip)
  -> single synchronous publication assignment
  -> legacy-shaped result reconstructed from the exact committed effects
```

Durability precedes visibility. A failed durable mutation leaves the published
committed generation completely unchanged, including every derived index.

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
  wait and execute against the then-current committed tip. Public commands
  carry no base, so this is not a rebase.
- Same mutationId + same intent (concurrent or retried): the authoritative
  receipt lookup returns the original committed transaction — no second
  transaction, no new IDs, no new objects.
- Same mutationId + conflicting intent: `PERSISTENCE_CORRUPTION`, fail closed.
- Lost ACK (ambiguous durable outcome): the mutation fails `RECOVERY_REQUIRED`
  and the runtime enters `recovery-required`. Reads keep serving the last
  committed generation; `recover()` is required; the retry with the same
  mutationId then resolves the original receipt. Recovery is never performed
  transparently inside an unrelated mutation.
- Stale base (another runtime advanced the tip): `STALE_TRANSACTION_BASE`,
  retryable, never a silent rebase; `recover()` then retry.
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
deliberate lifecycle error, not a durability failure). Close is idempotent;
no durable session leases or TTL takeover exist. A second runtime may open
the store after close.

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

- New suites: `tests/durable-runtime.test.ts` (14 tests),
  `tests/durable-runtime-concurrency.test.ts` (5 tests).
- Probe: `node scripts/af1-tranche6-live-runtime-probe.mjs
  --simulate-directory-barriers` — bootstrap, 280+ live mutations across all
  command kinds, interleaved reads, one 80 KB object-backed mutation, a
  concurrent pair, injected lost ACK + explicit recovery + same-identity
  retry, cross-runtime stale base, close, recovery reopen with exact
  tip/snapshot byte equality, recovery-confirmed transaction count.
- Frozen gates carried forward: full suite 461 baseline + 19 new = 480/480,
  focused 388/388, mutation-index 38/38, ORION 14/14, Tranche 4 probe,
  Tranche 5 1,050-transaction probe, all five frozen fixtures byte-identical.

## Known limitations

- Native Windows directory durability remains unavailable; all probes on
  win32 run with `--simulate-directory-barriers`. No native power-loss claim.
- Mutation-receipt reconciliation remains scoped to the active WAL (T5).
- The durable runtime does not expose `condensation`/bulk import paths;
  `purgeExpired`, `importPortableRecords` and `importData` are absent from
  the durable surface by design (compound/bulk operations are future work).
