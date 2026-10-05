# AF1 Tranche 5 — Startup Recovery Architecture and ORION Verification

This document records the Tranche 5 architecture and the durable ORION
verification receipt: a test-to-invariant mapping with exact test names plus a
verification script (`scripts/af1-orion-verification.mjs`) that runs the mapped
suites and prints per-property PASS/FAIL evidence.

## Architecture

- **Commit path** (Tranche 4, unchanged): `ProductionWalStore.commit` captures a
  semantic operation set, binds it to a stable `mutationId` + digest, installs
  external payload objects when the inline envelope bound is exceeded, and
  appends one frozen WAL v1 frame under exclusive writer authority. Lost-ACK
  retries reconcile by `mutationId` + digest first and return the original
  committed receipt.
- **Mutation preparation (structural detachment)**: `prepareCoreMutation(base,
  command)` accepts only immutable data — a canonical persisted `EtherSnapshot`
  and a plain `ProductionMutationCommand` belonging to the established
  production plain-data domain. Command validation is accessor-safe: own
  property descriptors are inspected BEFORE any value is read, so getters,
  setters, symbol keys, sparse arrays, unsupported prototypes, cycles,
  undefined, NaN and non-finite numbers are rejected without ever invoking
  user code. The canonical bytes are decoded into a frozen plain-data copy;
  that copy — never the caller's original object — is digested, reconciled and
  executed, so intent cannot change between validation and preparation. The
  function constructs a fresh ephemeral detached Core internally (no storage,
  no callbacks, no durable writes), imports the base, executes the real Core
  mutation once, and diffs the persisted before/after state into the complete
  deterministic effect set. Core-generated values (linker edge IDs, note IDs,
  timestamps) are generated once here and become explicit transaction data.
- **Recovery replay**: `reduceProduction` is a generic deterministic effect
  applicator. It never reconstructs FoundationLinker policy, never generates
  IDs, and never resolves graph conflicts; it applies exactly the captured
  effects.
- **Durable committed-mutation reconciliation**: `ProductionWalStore
  .commitMutation(base, baseSnapshot, mutationId, command)` computes the
  stable intent digest from the command BEFORE any randomized execution, then
  performs an authoritative active-WAL receipt lookup
  (`FsWalStore.readCommittedMutation`, the existing bounded streaming scanner
  under writer authority) BEFORE any preparation. An exact intent match
  returns the original committed receipt without re-preparing (no new random
  IDs, no new payload objects, no second transaction); a different intent
  digest under the same mutationId fails closed as `PERSISTENCE_CORRUPTION`;
  the same mutationId under multiple distinct logical transactions fails
  closed.
- **Mutation digest semantics**: `mutation.digest` represents the caller's
  STABLE input at the API boundary — the pre-preparation command intent for
  `commitMutation`, or the exact stable operation set for `commit`. The
  transaction digest continues to bind the exact prepared effects, including
  generated IDs and timestamps. Intent identity and result/effect identity are
  distinct and never conflated.
- **Checkpoint-scope limitation**: the receipt lookup is authoritative for the
  ACTIVE WAL from the HEAD/checkpoint lineage. Tranche 5 implements no
  checkpoint rotation/compaction; once a future tranche reclaims WAL history,
  it must either preserve durable mutation receipts across the checkpoint or
  introduce an equivalent receipt index. No claim is made that mutation-ID
  lookup survives WAL reclamation that Tranche 5 does not implement.
- **Exact mutation index**: external merge sort under `.private`, bounded RAM,
  disk scaling with active WAL history, exact duplicate detection across the
  entire lineage, and a precise session-owned disk cap (`maxDiskBytes` =
  maximum aggregate bytes occupied at any instant by session-owned artifacts —
  sorted runs, merge inputs, the merge output being written, and the
  allocation manifest) enforced BEFORE every growth, failing as an explicit
  resource limit.
- **Index crash safety (manifest/high-watermark)**:
  `.private/recovery-mutation-index-manifest.v1` durably records the highest
  allocated run number BEFORE the file with that number can exist (reserve →
  manifest durability barrier → create/write/sync run). The manifest is an
  accounted session-owned artifact: its exact bytes are preflighted against
  `maxDiskBytes` BEFORE creation or update (a cap smaller than the minimum
  manifest fails as a resource limit without creating any artifact; the
  fixed-width in-place update never holds both old and new physical files).
  Cleanup attempts EVERY name in the enforced run-number namespace
  (0..1023) EVERY time, regardless of the manifest watermark — a
  syntactically valid manifest can carry a stale LOWER watermark than files
  actually present — tolerating ENOENT so merge deletion holes are safe; the
  manifest is removed last after the directory barrier. Attempting to
  allocate a run number ≥ 1024 fails explicitly as a resource/file-count
  limit before its file can exist.
- **Index ledger exactness**: disk bytes are released from accounting only
  after physical removal is established. A failed unlink (other than ENOENT)
  retains the file's full accounted bytes and its owned-file entry and
  propagates the failure; a merge whose consumed-input deletion fails aborts
  verification (it never continues writing output against imaginary free
  space), leaving canonical storage untouched while the remaining private
  artifacts are swept by the next attempt.
- **Snapshot payloads**: production payloads carry the on-wire profile
  discriminator `ether.snapshot.payload.v1`; historical plain v0.3 payloads
  are accepted only through the explicit legacy decode path after raw
  checkpoint digest verification. `displayName: ""` is historical data and is
  preserved; only absent/null normalizes to absent.
- **Publication**: one normalized semantic graph feeds the published persisted
  snapshot, the published `read()` state and the runtime Graph; atomic StateRoot
  publication under writer authority.

## ORION test-to-invariant mapping

| # | Property | Suite(s) | Exact test names |
|---|----------|----------|------------------|
| 1 | No candidate visibility | `tests/startup-recovery.test.ts` | "reads during recovery never expose candidate state"; "checkpoint-only, derived index, clone isolation and repeated restart"; "failure at %s keeps old generation unchanged" |
| 2 | State/tip atomicity | `tests/startup-recovery.test.ts` | "failure at %s keeps old generation unchanged"; "postpublication failure does not duplicate history or undo the published root"; "one transaction publishes complete state and exact large txId while authority is held" |
| 3 | Deterministic restart | `tests/startup-recovery.test.ts`, `tests/graph-consistency.test.ts`, `tests/recovery-mutation-index.test.ts` | "checkpoint-only, derived index, clone isolation and repeated restart"; "restart idempotency produces identical StateRoot"; "explicit edge ids, several nodes/edges and FoundationLinker effects survive recovery identically"; crash-debris suite: "crash after manifest reservation, before run creation"; "crash midway through an initial run write"; "crash after several run files"; "crash during merge output, with deletion holes below"; "crash after merge output completion but before input deletion"; "Codex exact case: runs 000008 and 000009 survive with holes below (with manifest)"; "Codex exact case without a manifest falls back to the full bounded sweep"; "crash during cleanup after removing only some runs"; "repeated restart after interrupted cleanup stays clean and recovers"; "torn manifest falls back to the full bounded sweep"; "syntactically valid stale watermark %i cleans all higher stale runs on the first retry"; "Codex exact stale-low manifest: watermark 3 with stale runs 000008/000009 recovers on the first retry"; "recovery-index crash debris never strands a valid store end to end" |
| 4 | Lost-ACK idempotency | `tests/startup-recovery.test.ts`, `tests/production-roundtrip.test.ts`, `scripts/af1-tranche4-probe.mjs` | "lost ACK large payload retry on same base with same mutation produces same transaction"; "reconciles the committed mutation before preparation and rejects conflicting intent"; "commitMutation prepares and commits when the mutation is definitely absent"; accessor-safety suite: "rejects a getter command without ever invoking the getter"; "rejects a nested getter without invoking it"; "a valid plain command hashes identically on repeated hashing"; "an equivalent freshly constructed command hashes identically (restart-equivalent)"; "preparation consumes the validated copy, not the caller's original object"; Tranche 4 probe ambiguous-retry rows |
| 5 | Object immutability | `tests/startup-recovery.test.ts` | "object immutability: reinstalling identical content reuses and preserves the installed object" |
| 6 | Missing-object failure | `tests/startup-recovery.test.ts` | "committed WAL with a missing referenced object fails recovery without publication"; "wrong object path referenced fails recovery gracefully" |
| 7 | Prototype safety | `tests/ether-data.test.ts` | "rejects non-persisted JS without invoking accessors"; "sorts UTF-16 keys and keeps dangerous names as own data"; "preserves persisted JSON case %s" |
| 8 | Surrogate fidelity | `tests/ether-data.test.ts` | "preserves persisted JSON case %s"; "has deterministic seeded roundtrips" |
| 9 | StateRoot bound + historical compatibility | `tests/startup-recovery.test.ts`, `tests/snapshot-profile.test.ts` | "WAL growth past checkpoint size fails deterministically without publication or truncation"; "recovers exact canonical snapshot size %s"; "recovers the exact 8,388,608-byte historical v0.3 checkpoint within the production bound"; "recovers a legacy plain v0.3 payload through the explicit legacy path" |
| 10 | Generic 1 MiB replay preservation | `tests/wal-stream.test.ts`, `tests/wal.test.ts` | "processes beyond 8 MiB and 1,024 frames across bounded batches"; "uses only committed values and exposes immutable detached state"; "bounds individual and aggregate payloads, depth, operation count and identifiers" |
| 11 | Incomplete-tail vs complete-corruption distinction | `tests/startup-recovery.test.ts`, `tests/wal.test.ts` | "repairs only incomplete final tail at %s then cleanly rescans"; "fails closed for %s damage"; "a complete but corrupt final frame is never repaired"; "middle corruption is never repaired and leaves the WAL untouched"; "failed truncate sync never publishes; retry recovers the surviving prefix"; "recognizes every truncated final-frame prefix without advancing committed history"; "fails closed on middle corruption and on a truncated frame followed by another frame" |
| 12 | Authority through publication | `tests/startup-recovery.test.ts`, `tests/recovery-mutation-index.test.ts` | "one transaction publishes complete state and exact large txId while authority is held"; "authority loss before publication never publishes the recovered generation"; "fails closed for lock damage"; "concurrent recovery sessions serialize through writer authority"; "mutation-index resource limit fails recovery before publication; retry with capacity succeeds"; "torn manifest falls back to the full bounded sweep"; unlink-failure suite (with explicit unlink-invocation counters that fail if the injected hook never runs): "the exact peak requirement for the deterministic stress fixture includes the residual run"; "injected unlink failure on the %s consumed run is exercised and aborts verification within the cap"; "injected unlink failure during cleanup is exercised, fails closed; a clean retry sweeps and succeeds" |
| 13 | 8 MiB / >1,024 history | `scripts/af1-tranche5-recovery-probe.mjs` (default 1,050 transactions), `tests/startup-recovery.test.ts`, `tests/recovery-mutation-index.test.ts` | "detects duplicate mutation IDs beyond the old 4096-entry horizon"; "accepts 65536 unique IDs across merge levels"; "Codex case: a 2,500,000-byte cap is enforced before merge growth, never exceeded on disk"; manifest-cap suite: "cap = 0 fails before creating any recovery-index artifact"; "cap = 1 fails before creating any recovery-index artifact"; "cap = manifest size - 1 fails without creating any artifact"; "cap = exact manifest minimum opens the session; runs exceed it cleanly"; "manifest watermark growth/update never exceeds the cap and never doubles physically"; "allocating the 1025th run fails as a resource limit before its file can exist"; Tranche 5 probe receipt (WAL > 8 MiB, three fresh recoveries, StateRoot/tip/snapshot-byte equality) |
| 14 | Frozen WAL compatibility | `tests/wal-wire-fixture.test.ts` + fixture SHA-256 receipts | all tests in the suite; fixture hashes verified by the ORION script |

## Running the receipt

```
npm run build
node scripts/af1-orion-verification.mjs --simulate-directory-barriers
```

The script runs every mapped suite, verifies the five frozen fixture hashes
byte-for-byte, executes the Tranche 5 production recovery probe at its default
1,050 transactions, and prints a fourteen-row PASS/FAIL receipt.
