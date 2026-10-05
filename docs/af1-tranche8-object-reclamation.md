# AF1 Tranche 8 — Payload-Object Orphan Garbage Collection

Status: implemented on `feat/v0.6.0-af1-tranche8` (unfrozen; awaiting independent
hostile review). Frozen parents: T7 `baccfad72`, T6 `77fee0d f`, T5 `86fd96cc`.
This document describes the T8 architecture exactly as implemented.

## Scope decision (source-proven)

T8 collects ONLY payload objects that no authoritative durable history can ever
resolve again. Every payload object referenced by any committed transaction
becomes a receipt entry at rotation and receipts are retained indefinitely, so
committed object references are PERMANENT roots. The reclaimable set is
therefore provably limited to objects never referenced by committed history:
precommit/crash orphans (crash between `PayloadObjects.install` and the WAL
append) and deliberately injected debris. No tombstone structure exists in the
frozen data model; none was invented. Receipt-history reclamation, historical
payload reclamation, tombstone compaction, snapshot compaction, migration,
backup/restore and restore epochs remain out of scope.

## Primary invariant

No physical artifact is reclaimed unless it is provably unreachable from every
currently authoritative structure that can require it now or during exact
historical reconciliation. Authoritative payload-object roots are exactly:

1. `OBJECT_REFERENCE` digests in the authoritative active WAL;
2. `OBJECT_REFERENCE` digests in the authoritative cumulative T7 receipt ledger.

Checkpoints/StateRoot are inline and contain no object references. A crash-safe
rotation candidate's reference set is the same union (previous ledger plus the
retiring segment), so no candidate adds a root outside the mark set.

## New DirectoryIO primitive (approved)

`readNames(path, visit)` streams directory entry NAMES one at a time through a
visitor callback. No name array is materialized, no stats or content are read,
entry symlinks are never followed (names only; callers validate entries through
`kind()`). A missing directory is zero names. Nothing else was added to
DirectoryIO.

## Algorithm (bounded memory, unbounded history)

Both the mark stream (ledger fully digest-verified during traversal plus the
frozen WAL scanner) and the inventory stream (valid-name regular files only,
enumerated through `readNames`) pass through a two-bank external cascade sort
under `.private/gc-{mark|inventory}-{a|b}-{000000..127}.run` (128 slots per
bank, 512 digests per chunk, fixed 65-byte LF-terminated records, frozen
unsigned lexicographic byte order).

When the active bank fills, ALL of its runs merge into ONE output run in the
necessarily-empty opposite bank: output reserved before create, written
completely, fsynced, read-back verified, and only then are consumed inputs
unlinked; ownership/accounting releases only after successful unlinks
(non-ENOENT failures stay owned and accounted); `.private` barrier; banks swap.
Merge output and a run being consumed can therefore never share a slot, and
capacity grows level by level — the bounded namespace imposes NO total
object/history ceiling. Crash debris (verified output + undeleted source runs)
is inert and deterministically swept at G1/G7 of every attempt.

G4, the exact sorted reachability merge, proves BOTH directions before any
deletion can occur:

- `inventory − marks` → reclaim candidates (written, fsynced, verified to
  `gc-candidates-000000.run`);
- `marks ⊆ inventory` → any mark absent from the physical inventory is
  `PERSISTENCE_CORRUPTION` (covering active-WAL and receipt marks alike).

A missing `objects/` directory is zero inventory only when the mark set is
empty; non-empty marks with no physical inventory is missing-authoritative-
object corruption. Candidates are revalidated (name form + `kind()` regular
file, symlinks never followed) in G5 into `gc-validated-000000.run`, then
unlinked in G6 in batches of 64 with an `objects/` directory barrier per batch.

## G0–G7 state machine and crash model

- **G0 authority**: one exclusive `withRecoveryAuthority` hold across the whole
  operation (runtime single-flight serialization above it).
- **G1 scratch sweep**: both banks, both streams, both single artifacts; ENOENT
  idempotent; every other failure observable.
- **G2 mark**: ledger `verify(visit)` (whole-file digest proof) and the frozen
  WAL scanner; only valid `OBJECT_REFERENCE` digests are marked. Mark-sorter
  and scratch failures are classified `G2-mark-scratch` (maintenance). When
  the caller supplies the captured committed tip of a live published
  generation, G2 additionally proves terminal authority using the frozen T7
  rotation-P2 precedent: the scanned WAL must terminate at exactly that tip,
  or — with the WAL legitimately absent after rotation — the frozen checkpoint
  tip must already represent it. A truncated, foreign or vanished active
  segment omits committed roots; any mismatch fails
  `RECOVERY_REQUIRED` before inventory, coverage and any deletion, and the
  runtime moves to recovery-required.
- **G3 inventory**: `readNames`; malformed names, dotfiles, directories and
  symlinks are never deleted, never followed and count in `unknownArtifacts`.
- **G4 coverage**: bidirectional proof; no deletion may occur before it
  succeeds completely.
- **G5 validate**: immediate recheck of every candidate before unlink.
- **G6 reclaim**: batched unlinks with barriers; ENOENT under held authority
  is idempotent absence; non-ENOENT failures return exact partial accounting.
- **G7 final cleanup**: deterministic scratch sweep and barrier.

GC has NO authority switch — no P6 analog. Every deleted file was already
proven unreachable, so interruption at any point is safe and retry is
idempotent; mark/derive/validate complete before the first unlink. GC never
changes HEAD, checkpoints, WAL authority, receipt authority, StateRoot or tip.

## Core safety theorem

For every payload object GC unlinks, the complete proof chain holds:
request entered via the runtime facade -> single-flight queue -> trusted
live generation tip captured internally -> authoritative ledger fully
verified -> active WAL fully scanned -> durable tip equals the captured
tip -> marks exactly represent authoritative references (malformed persisted
references are authoritative corruption) -> every derived scratch run is
exact-content sealed AND per-record authenticated -> inventory exact ->
marks subset of inventory proven -> candidates exactly inventory minus
marks -> the digest passed G5 regular-file validation -> G5 generated an
HMAC authentication from that exact trusted in-memory digest -> G6 verifies
that exact record authentication BEFORE the unlink -> a later end-of-stream
seal failure cannot invalidate earlier deletions because every deletion was
individually authenticated. No shape-only or EOF-only validation ever serves
as deletion authority.

## Scratch integrity (two layers, each proving a different property)

Layer 1 - WHOLE-RUN SEAL (SealedRun): a constant-size in-memory binding - run
type, record count, exact canonical byte length and a SHA-256 computed from
the INTENDED output while it is generated - read back and verified after
write+fsync and re-verified whenever a run is opened. The seal proves
completeness: exact count, canonical encoding, strict ordering, no
truncation, extension, omission or duplication of the run as a whole.

Layer 2 - PER-RECORD AUTHENTICATION: every scratch record is
digest(64 hex) || tag(64 hex) || LF, where tag = HMAC-SHA256 (standard
WebCrypto HMAC, never concatenated hashes) over a domain-separated canonical
encoding of runType || index || digest, under an EPHEMERAL 32-byte CSPRNG key
held only in memory for one GC invocation. The tag is computed from the
TRUSTED in-memory digest the producing computation just derived (never from
bytes re-read from scratch) and verified BEFORE the record's digest is
returned to any consumer - in particular before any unlink decision. A
whole-run seal that becomes authoritative only at end-of-stream can never
authorize an early destructive action; per-record authentication supplies
exactly that missing property. The authenticated index binds each record to
its exact position (no reordering, skipping or same-run replay); runType
domain separation prevents cross-stream replay; a different key prevents
cross-invocation replay. Crash/restart discards the key, automatically
distrusting all stale authenticated scratch, which G1 sweeps deterministically.
Tag comparison is constant-time; memory stays bounded (constant-size key and
HMAC state, no per-record tables); no durable on-disk format exists.

## Failure disposition model (internal, not public codes)

Every error GC returns carries `details.gcDisposition`:

- `authoritative` — corrupt history, terminal-tip mismatch, a marked object
  missing from the physical inventory, malformed persisted references;
- `maintenance` — every scratch create/write/sync/verify/read failure,
  enumeration failure, unlink/directory-barrier failure.

Authority-layer uncertainty is marked by the frozen authority coordinator with
the additive `details.authorityReleaseFailed` and outranks every operation
disposition. The runtime applies the explicit precedence
**authority > authoritative > maintenance** — never a phase-string inference:

- `authorityReleaseFailed === true` → recovery-required (even when the primary
  operation failed as an ordinary maintenance error, and even after a fully
  successful collection);
- `gcDisposition === "authoritative"` → recovery-required;
- `gcDisposition === "maintenance"` → stays ready with exact partial details;
- no disposition (authority-acquisition layer) → conservative classification
  by error code.

## Containment: exactly one destructive path (structural)

The G0-G7 orchestration that unlinks payload objects is a module-PRIVATE
closure inside src/core/DurableEtherMemories.ts: it is not exported from any
shipped module, so absolute-path imports of internal modules reveal only
non-destructive scratch/planning helpers. The runtime facade
collectGarbage() is the only caller and captures the committed tip from its
own live published generation; no public API accepts a caller-supplied tip.
The package exports map additionally blocks deep package-specifier imports
for external consumers, and the compiled-production probe audits every
emitted module by absolute import to prove no destructive collector export
exists.

## Threat-model boundary (frozen, unchanged by T8)

Concurrent external or malicious mutation of the store namespace while writer
authority is held is OUTSIDE the frozen persistence contract and always has
been: `docs/af1-durable-commit.md` — "accidental external modification
bypassing authority is not prevented", "malicious filesystem owners and
dishonest backend/registry implementations are not authenticated or fenced by
this protocol", "there is no defense against a malicious filesystem owner/root
replacing paths or restoring timestamps between checks";
`docs/af1-persistence-foundation.md` — "this is not a defense against
malicious filesystem-owner/root replacement races". Every frozen T1–T7
operation (object install, rotation candidate activation, authority checks)
has identical exposure; T8 neither adds nor weakens it. Node's portable
filesystem API offers no dirfd-based `openat`/`fstatat`/`unlinkat` primitive
that could enforce check-then-use atomicity against such an actor on the
supported platforms.

Within that boundary, T8's "no symlink following" means exactly: static
entries are validated through `kind()` (lstat) — a symlink, junction,
dotfile, malformed name or directory is never unlinked and never followed;
`readNames` returns names only; and a final-component unlink removes the link
entry itself rather than following it, so no GC operation can ever touch a
path outside the `objects/` namespace. Conforming writers cannot race GC at
all: every reference-creating path holds the same exclusive writer authority.


## Error and lifecycle semantics (frozen taxonomy)

No new error codes. Every GC error carries `details.gcPhase`:

- Maintenance phases (`G1`, `G2-mark-scratch`, `G3`, `G5`, `G6`, `G7`) and
  codes `READ_ONLY_LOCKED`/`DURABILITY_UNAVAILABLE` leave the runtime READY
  with exact partial-reclaim details (`reclaimedObjects`,
  `remainingCandidates`, counters). Garbage-deletion durability uncertainty
  never pretends the authoritative runtime needs recovery — including
  transient mark-scratch create/write/sync/verify failures, which touch only
  `.private` scratch.
- Only authoritative uncertainty moves the runtime to recovery-required:
  `PERSISTENCE_CORRUPTION` from an authoritative phase (corrupt history,
  marked object missing from the inventory), or
  `RECOVERY_REQUIRED`/`STALE_TRANSACTION_BASE` from the authoritative-source
  phases (`G2-mark`, `G4-coverage`) or the authority layer (errors without a
  GC phase), including the terminal-tip mismatch proof above.

## Unknown artifact contract

- valid `<64-hex>.bin` regular file → normal inventory item;
- malformed name, dotfile, directory, symlink, unknown entry → never delete,
  never follow, count in `unknownArtifacts`;
- marked but physically missing → corruption;
- marked with corrupt content → existing recovery/`PayloadObjects` validation
  stays fail-closed; GC never deletes a marked object;
- unmarked valid-name object → reclaimable regardless of content; GC does not
  decode or read it.

## Runtime surface

`collectGarbage(): Promise<Result<DurableGcSummary>>` joins the public durable
facade as approved member 19 (18 → 19): explicit, never automatic, serialized
behind the existing single-flight queue with mutations and rotation,
generation-neutral and tip-neutral, backed by the existing writer/recovery
authority. No lease, no new coordination mechanism, no implementation object
exposed: the summary carries only `scannedObjects`, `markedReferences`,
`reclaimedObjects`, `unknownArtifacts`.

## Non-goals (out of T8 scope)

Receipt-history or retention-horizon changes; committed historical payload
reclamation; tombstone structures; snapshot/WAL compaction; migration;
backup/restore and restore epochs; automatic GC; receipt/P7-debris orphan
sweeping (now technically possible through `readNames`, deferred); WAL v2;
distributed writers; any frozen wire-format change.

## Stop conditions honored

None triggered. WAL v1, HEAD/checkpoint framing, the snapshot payload profile
and receipt v1 are untouched; receipt-referenced objects are never deleted;
exact historical result reconstruction is preserved (verified end to end);
bounded-resource guarantees hold (512-entry chunk, ≤128 merge cursors, no
total-object ceiling); no new authority mechanism; corruption is never treated
as garbage.
