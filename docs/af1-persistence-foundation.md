# AF1 Persistence Foundation (Tranche 2)

This is a metadata/layout foundation, not a usable durable memory engine or a
v0.6.0 release claim. It adds no WAL transactions, replay, memory mutations,
compaction, migration, or Dream Cycle. The accepted Tranche 1 contracts are
unchanged. `FsDurableStore` deliberately does not implement `StoragePort` or
advertise its optional `durable` operations before recovery/commit exists.

## Invariant

Only `HEAD` selects the active checkpoint/epoch. Inspection never searches for
a newer checkpoint, promotes a candidate, breaks a writer lock, or repairs or
deletes anything. Successful activation requires both atomic visibility and all
required durability barriers. Visibility alone is not durable success.

## Explicit Directory and Bootstrap

`new FsDurableStore({ directory })` is separate from Core's `storagePath`.
`storagePath`, `FsJsonStorage`, `{load, save}`, `EtherSnapshot`, and all existing
snapshot/portable schema constants retain their existing behavior.

Internal layout (not an application-facing path contract):

```text
<directory>/
  HEAD
  checkpoints/checkpoint-<checkpointId>.bin
  wal/
  writer.lock
  .private/HEAD.candidate
```

`initialize({ head, checkpointBytes })` only creates an absent directory with
an existing, nonsymlink parent. It never overwrites/converts an existing file or
directory. The exclusive root creation arbitrates racing initializers; the
exclusive writer artifact covers bootstrap activation. Names are deterministic,
not memory contents, and candidates stay on the same filesystem as HEAD.
Writer artifact content identifies the store and a fresh bootstrap authority;
possession of that content is not a grant of authority.

Inputs must be prepared checkpoint bytes and matching authority metadata, not
live Core state. Input bytes are copied before asynchronous work. This layer
checks metadata and byte integrity, **not the payload's memory semantics or WAL
continuity**. Payloads remain opaque; there are no canonical memory reads here.
Inspection returns `active` with `recovery: "required"`, never a recovered store.
The future recovery boundary must validate the actual snapshot and lineage
before making any canonical state readable or writable. No genesis digest or
history is invented by bootstrap.

Inspection distinguishes `missing`, recognized `legacy-json`, and verified
`active` metadata. Incomplete/malformed authority returns `RECOVERY_REQUIRED`;
unknown required versions return `UNSUPPORTED_PERSISTENCE_FORMAT`; writer
artifacts return `WRITER_BUSY` without stale-lock breaking; permission failures
are `READ_ONLY_LOCKED`. Legacy detection identifies the container schema only,
not semantic snapshot validity. Opening does not infer or enable durable mode.

## HEAD Wire Contract

`PersistedStoreHead` extends the existing `StoreHead` with wire-only compatibility
fields; ordinary snapshots do not gain authority fields.

| Field | Meaning |
| --- | --- |
| `format`, `version` | `ether.store_head`, string `1` |
| `storeId`, `epochId` | Store identity and selected active epoch |
| `schemaVersion` | `ether.memory_store.v0.3` |
| `digestAlgorithm` | `sha256` (SHA-256, lowercase 64-character hex) |
| `checkpoint.checkpointId` | Referenced immutable checkpoint identity |
| `checkpoint.digest` | Digest of the entire framed checkpoint, including payload |
| `checkpoint.tip.epochId` | Same epoch as HEAD |
| `checkpoint.tip.txId` | Exact last-included transaction ID, canonical decimal string |
| `checkpoint.tip.digest` | Last-included transaction chain digest |
| `walFormat.format`, `walFormat.version` | Reserved `ether.wal`, string `1`; no WAL engine |

HEAD is not the latest transaction ledger. The checkpoint's included tip may
trail complete WAL once later tranches implement WAL/recovery.

HEAD is UTF-8 JSON with no BOM, whitespace, trailing LF, duplicate/unknown keys,
or alternate escapes. The encoder projects a fixed field order (including
nested objects), independent of caller insertion order. Decoding rejects any
noncanonical encoding rather than normalizing historical bytes.

A checkpoint is one bounded canonical UTF-8 JSON header, one LF byte, then the
original opaque payload bytes. Header field order is `format`, `version`,
`storeId`, `checkpointId`, `schemaVersion`, `digestAlgorithm`, `tip`, `payloadBytes`.
Its format is `ether.checkpoint`, version `1`; `tip` has HEAD's field order.
The payload length is an exact bounded safe integer; transaction IDs are never
numbers. Header identity must match HEAD in full, including epoch/txId/digest.
The checkpoint digest hashes the single original encoding, including header and
payload, not a parsed/reserialized snapshot. Payload whitespace changes identity.
Hashing provides integrity, not authentication against a filesystem owner.

## Bounds and Filesystem Safety

`PERSISTENCE_LIMITS` centralizes defaults and hard format bounds. Per-instance
or per-codec options may reduce them, never expand them:

| Resource | Limit |
| --- | --- |
| HEAD bytes | 16 KiB |
| Checkpoint header bytes (excluding LF) | 4 KiB |
| Checkpoint payload bytes | 8 MiB |
| Identifier bytes | 64 |
| Exact transaction digits | 128 |
| Metadata nesting depth | 8 |

Identifiers contain lowercase ASCII letters, digits, `_` or `-`, beginning with
a letter/digit. Prefixing checkpoint filenames avoids reserved device names;
case-sensitive aliases, separators, dots and path traversal are rejected.
Digests have exactly 64 lowercase hex characters. Decimal IDs have no sign,
whitespace, leading zero (except `0`), exponent, or number coercion.

Raw metadata size and nesting are bounded before JSON parsing; checkpoint length
is checked before concatenation. Disk reads check regular-file type, size, link
count, and file identity before bounded allocation, and check for growth/change
while reading. Root/ancestor/layout symlinks or junctions and authority-file hard
links are rejected. No-follow flags are used where available. This is not a
defense against malicious filesystem-owner/root replacement races. Network
filesystems are outside the adapter's contract; UNC paths are rejected, but
local-looking mapped/network mounts cannot be detected portably by this layer.

## Activation and Failure

1. Validate/own the input bytes and preflight the parent directory barrier.
2. Exclusively create the directory and writer artifact; persist the checkpoint.
3. Sync checkpoint/layout directories and the parent directory entry.
4. Exclusively write/sync private HEAD candidate; sync its directory.
5. Reread/verify the candidate and referenced checkpoint.
6. Atomically activate candidate as HEAD.
7. Sync source and destination directories; release owned writer artifact;
   sync its removal before reporting `activation: atomic, durability: confirmed`.

Failures report phase, activation visibility and unconfirmed durability when
applicable. A successful rename followed by a failed barrier is an error, not a
successful commit. A later inspection of visible HEAD cannot retroactively
confirm the failed durability result. Unactivated candidates never establish
authority. Crashes can leave incomplete directories, candidate files or writer
artifacts; inspection does not clean them up. Unknown/ambiguous writer artifacts
require later explicit operator handling. Known owned artifacts are released on
normal failure paths, but failed/partial acquisition is never auto-broken.

The internal `DirectoryIO` boundary consists of operations, not optimistic
capability booleans. Native writes sync the file handle; directory sync failures
are not swallowed. Native atomic rename is enabled only on Linux/macOS local
filesystems; platform/device guarantees still matter. Node documents sync as
[OS/device-specific](https://nodejs.org/api/fs.html#filehandlesync).
On the tested Windows/Node 24 host, opening the directory succeeded but sync returned `EPERM`;
native initialization returns `DURABILITY_UNAVAILABLE` at preflight without
creating a store. No native Windows strong-durability claim is made.

Tests inject directory barriers and atomic activation to exercise the state
machine on Windows. Those successful injected outcomes are not evidence of
native Windows crash durability. Actual power-loss testing and Linux/macOS
native validation remain outside this Windows run.

An existing legacy-adapter issue was reproduced during compatibility testing:
`FsJsonStorage.save()` leaves its directory handle open if `sync()` throws
before `close()`. The full suite may therefore print Node's garbage-collected
FileHandle warning on this host. That adapter is intentionally unchanged in
this tranche; the new backend closes handles in `finally`, including on failed
directory barriers. This is a separate legacy maintenance item, not a claim
that the legacy adapter supplies strong durability.

## Next Boundary

Before a usable durable store exists, specify genesis chain anchoring and
connect prepared-snapshot validation/recovery gating. Next implement bounded,
versioned WAL framing/validation with exact identities, then separately add
exclusive-authority commit/recovery. Existing-store HEAD replacement and
checkpoint lifecycle remain unexposed here. Do not route live mutations through
this metadata layer or advertise `StoragePort.durable` prematurely.
