# AF1 Tranche 4: Durable Append and Resumable Validation

Reviewed starting SHA: `7ed995357fa4045cd2271be811617f9e39e4e9a4`.
Work branch: `feat/v0.6.0-af1-durable-commit`.

This is an internal persistence substrate, not a recovered Ether memory store.
Tranches 1-3 source, schemas, package version, HEAD/checkpoint codecs and WAL v1
wire bytes are unchanged. No new root exports, StoragePort implementation or
public Core durable mutation path is introduced. No WAL fixture is frozen.

## Layout and Authority

The existing explicit directory remains:

```text
HEAD
checkpoints/checkpoint-<checkpointId>.bin
wal/wal-<checkpointDigest>.bin
writer.lock
.private/
```

HEAD alone selects the checkpoint and epoch. Its validated checkpoint digest
selects one deterministic WAL filename (64 lowercase hex characters prefixed
with `wal-`). This digest binds the checkpoint's store, epoch and anchor. Other
files, candidate HEADs, filename order and mtimes never select history. An absent
selected WAL represents no transactions after the checkpoint, not a new genesis.
There is no separately persisted latest-tip ledger. No WAL rotation or deletion
is implemented; a later checkpoint lifecycle must define that transition.
Configured resolved directory text is capped at 4,096 UTF-8 bytes. Relative
filenames have fixed prefixes and bounded reviewed identifiers/digests. Lock
verification reads at most 1,024 bytes; preparation captures at most 1 MiB.

FsWalStore reuses the exclusive `writer.lock` protocol and WriterAuthorityIdentity
contract. A fresh lock identity is not a transaction or mutation ID. Acquisition
uses exclusive create and file sync, followed by root-directory sync. Existing
locks fail WRITER_BUSY. Partial/ambiguous acquisition is never auto-broken.
Known owned artifacts are verified and released on handled failures; failed
release leaves RECOVERY_REQUIRED, and any remaining lock requires explicit
operator handling. No TTL, takeover, leases, distributed locks or fencing scheme.

All cooperating protocol writers, including readTip, hold this authority from
tip resolution through barriers and close. They cannot interleave tip derivation
and append. No application withWriter callback is exposed by this implementation.
Trusted internal registry validators and backend syscall implementations must not
perform reentrant application work. Replay reducers are not invoked by commit.

## Preparation and Commit Protocol

FsWalStore.commit accepts only expectedBase, MutationIdentity and ordered
operations. It captures bounded canonical input and validates it before the first
await. Caller mutation afterward cannot change the request. Unknown fields,
caller-assigned txIds and unsupported operation versions fail before acquisition.
Preflight validation is not committed state and returns no committed identity.

1. Validate paths/layout and preflight root and WAL directory barriers.
2. Read/validate HEAD; exclusively acquire and persist writer authority.
3. Revalidate authority/HEAD and verify the selected checkpoint bytes.
4. Open the selected WAL without truncation or append-mode flags. Resolve its
   complete history through authority-held bounded resumable scanning (or a
   protocol-valid derived cache). Detected corruption or partial tails block it.
5. Reconcile any prior occurrence of the requested logical mutation. Matching
   retries return its original identity only after fresh durability barriers.
6. For a new mutation, require exact expectedBase equality with the validated
   `{epochId, txId, digest}`. A stale caller gets STALE_TRANSACTION_BASE, without
   automatic rebase, payload regeneration or writes.
7. Assign `next txId = current txId + 1` using bounded BigInt/canonical decimal
   strings. No JS-number transaction IDs, gaps, regressions or wraparound.
8. Encode with the unchanged reviewed WAL v1 encoder. Recheck authority, HEAD
   and validated WAL identity/size/timestamps before the first write.
9. Create an absent selected WAL exclusively, or use its verified open handle.
   Write the entire frame in awaited positional-write loops at the validated EOF.
   Check each positive bytesWritten result; no atomic-frame-write assumption.
10. Check resulting size, sync the file, then sync the WAL directory. Recheck
    authority, file identity and its post-write stamp. Close the handle.
11. Verify/remove the owned writer artifact and sync its removal. Only then
    return a confirmed receipt. No live Core state is published at any point.

Node documents the bytesWritten result and the need to await individual writes;
Linux append-mode writes ignore the supplied position. This implementation uses
O_RDWR (and O_CREAT|O_EXCL for creation), not O_APPEND. File sync guarantees remain
OS/device-dependent, not an atomic-transaction primitive. See the official
[Node 24 filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlewritebuffer-offset-length-position)
and [filehandle.sync](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync).

## Mutation Reconciliation and Ambiguity

The existing MutationIdentity `{mutationId, digest}` is persisted unchanged.
Its digest identifies a caller-supplied canonical logical command, not its txId.
The coordinator cannot reconstruct the original command from resolved deltas.
For a retry it compares the mutation digest and an independently computed
canonical operations digest. Incompatible reuse fails PERSISTENCE_CORRUPTION;
matching identity with different resolved operations is also refused, never
silently rebased. Retry lookup deliberately precedes the stale-base check:
an already committed command can be acknowledged with its original older base.

Deduplication covers the complete WAL after the active checkpoint. This tranche
does not contain a checkpoint mutation ledger or claim deduplication for commands
predating that anchor. No checkpoint replacement/compaction is supported. A later
lifecycle must preserve logical retry identity across such a transition.

A reconstructible in-memory cache holds at most 4,096 compact mutation records:
mutation identity, transaction identity and operations digest, never payloads.
It is reused only under freshly verified authority, with identical HEAD bytes
and file stamps. This relies on the current conforming protocol being append-only:
another successful append changes size, and a lineage change changes HEAD.
Stamps are not content commitments. An external same-size rewrite or bit rot with
unchanged stamps can escape this cache as well as a scan of already read bytes.
This cache is not a storage scrubber. Future compaction/replacement must invalidate
it and define its own authority/lineage transition; that lifecycle is not present.
If all
history fits, a cache miss proves absence in that history. Otherwise a miss scans
the entire history in bounded batches, retaining only the requested match plus
the bounded cache. Eviction/capacity is never treated as absence. Repeated logical
IDs under distinct transactions are rejected for cached IDs and the requested
ID; this is not an unbounded global corruption index for all historical IDs.
Adjacent exact physical duplicates are excluded by the scanner and cannot cause
duplicate reconciliation entries or double application.

After bytes might have been written, any failed acknowledgment returns
RECOVERY_REQUIRED with `outcome: reconciliation-required`. The implementation
does not append blindly on retry. It rescans exact history under fresh authority.
A complete matching frame is synced again, including its directory, before an
`already-committed` success. Visibility alone never proves the previous attempt's
barrier succeeded; fresh sync establishes durability now, not retroactively.
A partial tail is never truncated or repaired here, even for a matching retry.

Failure details contain phase, outcome, visibility and durability:

- `not-committed` means this attempt did not append a transaction; it is not a
  claim that a prior attempt with the same mutation ID could not have committed.
- `visibility: possible` is conservative from immediately before the first write,
  including when a backend writes bytes and then throws without reporting a count.
- `visibility: complete` follows successful full write or matching-history lookup.
- `durability: confirmed` means file and WAL-directory barriers returned, even
  if a later close/release step failed and the acknowledgment requires reconciliation.
- Successful receipts contain committed/already-committed, original identity,
  mutation identity and confirmed durability; no prepared-only receipt is success.

## Resumable Validation

The reviewed scanWal remains unchanged. New WalStreamScanner uses its unchanged
single-frame decoder, canonical checks and chain rules. Each next call accepts at
most 8 MiB and completes at most 1,024 physical frames, including duplicates.
It returns consumed input bytes and at most that batch's new transactions. Any
unconsumed bytes belong to the next call. Limits are per call, not total history.

A frozen continuation records exact physical offset, complete validated byte
count, current full tip, pending/incomplete-tail status and ended state. Tokens
are single-use and instance-bound by reference; copied, forged, stale or foreign
tokens are rejected. Internal state retains at most one bounded partial frame
and the immediately preceding complete frame for adjacent-duplicate recognition.
History-validation errors poison the session. Invalid tokens or oversized call
inputs do not grant progress. End-of-input must be explicitly declared. A split
inside prefix, header, operation bytes, digest or terminator does not commit a
partial frame. Invalid available bytes fail rather than being called harmless EOF.

Tokens are process-local, not serialized recovery checkpoints. Byte callers must
supply contiguous bytes from their source; tokens do not authenticate arbitrary
sources. WalFileScan requires an explicit internal source contract: advisory or
authority-held. One handle remains open; dev/ino/size/mtimeNs/ctimeNs are compared
against both handle and path before and after each batch. Observed differences
invalidate the continuation. Filesystem stamps are change indicators, NOT proof
of immutable historical bytes: an ordinary same-size NTFS rewrite can preserve
every checked field, including exact BigInt nanosecond timestamps.
It reads up to 64 KiB by default (configurable only within 1 byte..8 MiB) with
explicit short-read loops. Per-batch transactions are discarded after inspection.
No unlimited file read, transaction collection or duplicate map is used.

Physical file offsets are exact safe integers, capped at Number.MAX_SAFE_INTEGER
because this backend uses Node positional offsets. This is not a transaction-ID
limit or an arbitrarily raised scanner ceiling. Transaction IDs remain exact
decimal strings up to the existing 128-digit WAL v1 constraint.

WalFileScan itself is a structural validator, not a durability receipt. Its
read-only mode label cannot be upgraded after creation. Authority-held scans
require an operational verifier from the trusted internal authority owner,
checked at open and before/after batches. Missing/lost authority fails closed;
detected loss permanently poisons that scan. An advisory continuation cannot be
passed into an authoritative scan (tokens are instance-bound), and a mode flag
without a verifier is rejected. This is an internal composition contract, not an
authentication API against an untrusted caller supplying a dishonest verifier.

Advisory scans report observations only, not a stable snapshot or canonical tip.
They reject observed stamp changes and corrupt bytes they actually read. They do
not promise detection of arbitrary external behind-the-cursor modifications,
even accidental ones. An open handle does not prevent in-place writes. Identical
rewrites may pass if stamps collide, or invalidate the scan if stamps differ.
Neither outcome establishes a physical write-event history.

FsWalStore.readTip already holds the same writer authority as commit, crosses
fresh barriers and closes/releases before returning. Its canonical-tip semantics
under the conforming-writer model are unchanged. Another writer may append after
release; the returned tip is not a perpetual latest-tip promise. New processes
reopen and validate history; no restart from byte zero is needed between batches.

### Authoritative Call-Path Audit

Classification: B, continuation API overclaim. No protocol-valid commit race was
found. The old universal in-place-change detection statement was false.

| Use | Authority | Handle / awaits | Result |
| --- | --- | --- | --- |
| commit -> run -> history | Exclusive writer.lock, continuously through barriers/close | One selected WAL handle; batches cross awaits | Authoritative commit receipt after release barrier |
| retry reconciliation -> same run/history | Same authority, including cache lookup or full scan | Same handle until sync/close | Original identity after fresh durability barriers |
| readTip -> same run/history | Same exclusive authority | Same handle and awaited batches | Canonical tip under protocol, not advisory |
| direct WalFileScan advisory use / probe | None acquired by scanner | One handle, awaited batches | Observed structure only |
| WalStreamScanner | No filesystem or authority | Synchronous bounded byte batches | Validation of supplied bytes only |

There are no other production file-scanner call sites or startup recovery paths.
A concurrent call on the same instance also acquires writer.lock and fails busy;
the active owner does not append until its scan completes. All conforming writes
append at validated EOF; no conforming actor rewrites earlier WAL bytes. Existing
checkpoint initialization is for absent stores, not active compaction.

### Future Recovery Contract

Canonical recovery must validate the complete HEAD-selected checkpoint and WAL
lineage while writer/recovery authority is held continuously, or from an
equivalently stable snapshot established under authority. The same open handle
and explicit authority-held scan contract may be reused. Loss of authority
invalidates the session; advisory/stale tokens must never be promoted to canonical
recovery evidence. Keep authority through canonical publication as required by
the future lifecycle. Future checkpoint/compaction actors must obey the same
exclusion rule. Recovery/publication/compaction are not implemented here.

A private copy is unnecessary for conforming-writer exclusion and is not atomic
against external writes merely because it is private. Rehashing the prefix on
every resume would add O(history) work per call without preventing a later
external rewrite. A last-frame digest cannot protect older bytes. Rolling/Merkle
metadata adds an unnecessary new lifecycle without solving source exclusion by
itself. This repair uses authority and retains bounded-memory, bounded-batch reads,
with bounded metadata/authority checks, not additional WAL-history reads.

## Fault Matrix and Threat Model

Tests inject faults around real filesystem open/read/write/sync/close operations,
not a fake transaction result. Directory barriers/activation are explicitly
simulated on Windows for protocol testing.

| Injected point | Physical history | Receipt / retry |
| --- | --- | --- |
| Before open; after open before first write | Unchanged history (possibly empty WAL file) | No append by this attempt |
| Before first write returns | No bytes in injected test; conservatively uncertain | Reconciliation required; safe retry scans first |
| During prefix/header/operations/digest/terminator | Valid prefix plus incomplete tail | Recovery required; no repair or append |
| Full write before sync; sync failure | Complete visible frame, unconfirmed durability | No success; retry must rescan and sync |
| Sync succeeds then acknowledgment is lost | Complete frame | Original identity on matching retry, no duplicate |
| WAL directory barrier failure | Complete frame; directory durability unconfirmed | Recovery required |
| Close or release failure after barriers | Complete durable frame, acknowledgment unconfirmed | Recovery required; matching retry if authority can be acquired |
| Release fails with lock still present | Durable frame plus writer artifact | WRITER_BUSY until explicit operator handling |
| Invalid write progress | No valid acknowledged append | Recovery required |
| Corruption/fork/logical duplicate encountered during validation | Corrupt history | Fail closed, unchanged file |
| Observed size/identity/stamp change during read or before append | Changed physical history | Recovery required; no successful append |
| Equal-stamp external rewrite of previously read/cached bytes | May be corrupted without an observed change | Not guaranteed detectable; outside source-stability contract |

Two independent coordinator instances contending for the same base use real
exclusive-create arbitration: one succeeds; the other returns busy, and a later
retry of its new command returns stale. Neither can produce another accepted
successor under the protocol. No application lock bypass is supported.

The threat boundary is explicit:
- Another conforming writer is excluded by the live writer.lock.
- The same writer completes validation before append; reentrant acquisition fails.
- Future checkpoint/compaction must share authority; no such operation exists now.
- Accidental external modification bypassing authority is not prevented. Observable
  stamp changes and newly read corruption are detected, but behind-cursor changes
  with equal stamps need not be. This limitation does not require a malicious actor.
- Storage corruption is detected when corrupt bytes are decoded; cached/previously
  read bytes are not continuously reread or protected against subsequent bit rot.
- Malicious filesystem owners and dishonest backend/registry implementations are
  not authenticated or fenced by this protocol.

Paths/ancestors/layout are checked for symlinks/junctions. WAL open uses no-follow
where available; regular-file identity and single link count are verified on
open and subsequent stamps. Unsafe/hardlinked WALs fail closed. There is no
defense against a malicious filesystem owner/root replacing paths or restoring
timestamps between checks, or a backend lying about syscalls. Network filesystem
semantics are outside the local adapter contract; UNC roots are rejected, while
mapped network mounts cannot be identified portably.

Native Windows directory durability refusal is preserved. No fsync errors are
swallowed to make it appear supported. Protocol tests/probes with simulated
directory barriers are not Windows crash-durability evidence. Linux/macOS native
power-loss validation has not been performed in this Windows workspace.

## Verification and Non-Goals

Run `npm run typecheck`, `npm test`, `npm run build`, and the focused persistence,
WAL, wal-stream, wal-source and wal-commit test files. Compiled-only probe (no dist/tests
imports): `node scripts/af1-tranche4-probe.mjs --simulate-directory-barriers`.
Omit the flag only on a backend providing the required native directory barriers.

Tranche 3 baseline: 199/199 tests. Pre-repair Tranche 4: 269 full, 196 focused.
The original same-size continuation test failed 4/20 isolated runs; a 300-run
instrumented investigation missed 191 equal-stamp rewrites. Native Windows
timestamps confirmed the collision. This finding was correct, not flaky-test
noise or JavaScript precision loss. Protocol-valid commit and readTip exclusion
were already intact; future recovery composition needed an explicit contract.

The original same-size test is retained with a deterministic changed-stamp
injection, and an equal-stamp matrix separately demonstrates the advisory limit.
Its former unconditional external-change expectation was technically unenforceable
with the available metadata-only observation. Authority tests pause real reads
across awaits, attempt competing/same-instance commits and readTip, verify lock
identity until close/release, and reject detected source/authority loss. Token and
missing-verifier tests prevent accidental advisory-to-authoritative composition.
No sleeps or timestamp delays are used as a repair; the delayed-attack test alone
waits to exercise that scenario. All existing tracked files, including schema/version
constants, legacy APIs, root exports and reviewed wire codecs, remain unchanged.

Repair verification: 288/288 full tests; 215/215 focused persistence/WAL tests;
typecheck and build passed. Nineteen source-contract tests were added. Twenty
isolated processes each passed those 19 tests plus the corrected original
same-size test: 400/400 executions, with no failures. The real-IO authority tests
cover commit, readTip and reconciliation across multiple scan batches. Whitespace
and scope checks passed, including the untracked Tranche 4 files.

The repair changes only FsWalStore.ts, walFileScan.ts, walIO.ts (comment),
wal-commit.test.ts, this document, and the probe's explicit advisory mode argument;
wal-source.test.ts is new. walStream.ts and the Tranche 3 WAL encoder, prefix,
canonical header/JSON, digest domain/trailer, operation registry, MutationIdentity,
EWALDONE and transaction-identity semantics are unchanged. The original 74-file
fingerprint comparison found only the six intended existing-file changes; the
existing HEAD/checkpoint wire fixture retained SHA256
ecc0d9b2276c9569bec4a3a139fb0ea3da12186459330c292dfb9c04255524af.
No new wire fixture, commit, push, PR update or Tranche 5 work was performed.

The compiled probe completed 2,200 sequential commits from txId 9007199254740993
to 9007199254743193. WAL size: 10,816,290 bytes. Reopened scans with 4 KiB, 64 KiB
and 8 MiB chunks took 2,641, 166 and 3 calls respectively, each validating all
2,200 transactions. Five stale attempts failed; four lost acknowledgments
reconciled without duplicate append; 16 seeded random partial tails blocked
further commits without mutation. Windows directory barriers were simulated.

No public durable memory mutations, live StateRoot, startup Core recovery,
checkpoint replacement/compaction, WAL GC, tombstones, migration, epoch restore,
committed retrieval indexes, graph redesign, Dream Cycle or Tranche 5 work.
No wire contradiction was found. Independent review is still required; this
document is not a v0.6 stability or power-loss-safety declaration.
