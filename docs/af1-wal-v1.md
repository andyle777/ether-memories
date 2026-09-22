# AF1 Tranche 3: WAL v1 and Detached Replay

Starting reviewed commit: 3a45361857d0d1390d60a6fdbfdf2bb3b15c7085.
This is an internal wire/validation/reducer substrate, not a durable memory engine.
There is no filesystem WAL writer, commit coordinator, live publication, startup
Core recovery, compaction, migration, tombstone support, or Dream Cycle. No new
package-root exports or production operation definitions are installed.

## Authority and Checkpoint Anchor

The caller must supply the already selected and verified HEAD/checkpoint.
The scanner validates HEAD metadata but does not read or re-verify checkpoint
files. HEAD remains the only lineage selection authority.

An empty WAL's committed tip is exactly head.checkpoint.tip. The first subsequent
frame must name that complete tuple as its expected base, preserve its epoch,
and use txId = base.txId + 1. Every subsequent new frame follows the same rule.
Transaction IDs are unsigned canonical decimal strings, computed/compared with
bounded BigInt arithmetic, never JS-number coercion. There is no second genesis
digest, generated sentinel, wraparound, or alternate epoch-selection path.

## WAL Version 1 Frame

Format is ether.wal, version is the existing independent WAL_VERSION string "1".
This framing is deliberately different from HEAD/checkpoint framing.

| Offset/region | Representation |
| --- | --- |
| 0..7 | Magic bytes FF 45 57 41 4C 0D 0A 1A |
| 8..11 | Header byte length H, uint32 big-endian |
| 12..15 | Operation-list byte length O, uint32 big-endian |
| 16..19 | Total frame bytes T, uint32 big-endian |
| 20..23 | Bitwise complement of T, uint32 big-endian |
| 24..(24+H-1) | Canonical UTF-8 JSON header |
| next O bytes | Canonical UTF-8 JSON ordered operation array |
| next 32 bytes | Raw SHA-256 transaction digest |
| final 8 bytes | ASCII EWALDONE |

T must equal 24 + H + O + 40. No padding, BOM, trailing newline or extra bytes
are permitted in a single frame. Scan accepts consecutive frames without gaps.
A complete checksum-valid frame is a structural history record, not proof that
a writer crossed a durability barrier. No encoder result acknowledges durability.

The header has exactly these fields (canonical lexicographic key order):
audit, base, epochId, format, mutation, operationCount, storeId, txId, version.

- base has exactly digest, epochId, txId.
- mutation has exactly digest, mutationId.
- audit is the reserved canonical audit location and must currently be null.
- operationCount is a bounded safe integer and must equal the array length.
- Every operation has exactly payload, type, version. Payload must be an object.
- Digest strings are exactly 64 lowercase hex characters.

No user-facing audit facility or destructive operation semantics are invented.
A future destructive operation needs reviewed immutable audit semantics before
registration; the null-only reserved location cannot silently gain new released
v1 semantics. Unknown operations are never treated as harmless or skipped.

## Canonical Byte and Digest Definition

For header and operations, object keys are ordered by JavaScript UTF-16 code-unit
lexicographic order, including numeric-looking keys. Scalars use ECMAScript JSON
escaping/number representation. Arrays preserve order. Strings must have paired
surrogates; no Unicode normalization is applied. Numbers must be finite, not
negative zero; integer-valued numbers must be safe integers. Larger exact values
must use schema-defined strings. This is an IEEE-754 JSON domain, not arbitrary
precision decimal arithmetic.

Only plain objects and dense plain arrays are admitted. Symbols, accessors,
hidden/extra array fields, functions, undefined, Date objects, cycles, and
prototype/constructor/__proto__ object keys are rejected. JSON wire text must
match the canonical encoding exactly. Duplicate fields, alternate escapes,
whitespace, numeric aliases, unknown envelope fields and malformed UTF-8 fail.

The transaction digest is:

SHA256(ASCII("ether.wal/1") || NUL || prefix24 || headerBytes ||
       operationArrayBytes || ASCII("EWALDONE"))

The digest excludes only its own 32-byte trailer slot. It binds frame lengths,
store/epoch, exact sequence, the full predecessor tuple, logical mutation identity,
audit slot, operation order, operation versions, and payload bytes.

Encoding produces one canonical representation. Verification requires canonical
wire text but hashes the original owned input bytes, not a casually reserialized
parsed object. Source bytes are copied only after the frame/stream bound check.
Hashes provide integrity/continuity, not authentication against a malicious writer.

## Mutation Identity

The reviewed MutationIdentity remains distinct from transaction identity.
Its stable mutationId and canonical logical-mutation digest are supplied by the
future caller/coordinator and persisted in the header. Both are transaction-hash
inputs. The wire layer validates their representation; it does not derive command
semantics from resolved replay deltas or prove that a supplied mutation digest is
the correct digest of an original logical command.

Different logical mutation digests remain representable for the same mutationId
so future recovered deduplication can fail closed on incompatible reuse. This
tranche does not build that index or resolve logical retry acknowledgment.
Physical duplicate recognition below is not logical-mutation deduplication.

## Hard Bounds

| Resource | Version-1 constraint |
| --- | --- |
| Total frame | 1 MiB |
| Header metadata | 4 KiB |
| Encoded operation array | 768 KiB |
| Operations per frame | 1..128 |
| Canonical individual payload | 64 KiB |
| Aggregate canonical payloads | 512 KiB |
| Store/epoch identifier | 1..64 lowercase ASCII letters/digits/underscore/hyphen, leading letter/digit |
| Mutation ID | Same alphabet, 1..128 bytes |
| Transaction sequence | 1..128 decimal digits, no leading zero except zero itself |
| Mutation/transaction digest | 64 lowercase hex characters |
| Operation type | 1..64 lowercase ASCII letters/digits/underscore/dot/hyphen, leading letter |
| Operation version | 1..16 decimal digits, first digit 1..9 |
| JSON value depth | 16, root at depth 0 |
| JSON value nodes per canonical document | 65,536 |
| Scanner batch bytes | 8 MiB |
| Physical frames per batch, including duplicates/incomplete tail | 1,024 |

The smaller payload/frame limits keep transaction verification bounded separately
from the unchanged 8 MiB checkpoint ceiling. Descriptor overhead has its own
operation-list bound. Fixed length fields are checked before slicing/decoding;
text nesting and outer operation count are checked before JSON.parse. Output
traversal is additionally bounded by bytes, depth and nodes. The scanner is a
bounded in-memory batch primitive, not an unlimited file reader.

The detached replay harness separately bounds JSON state to 1 MiB, depth 32,
and 65,536 nodes. That is not a checkpoint schema limit or a live Core StateRoot
format; integrating future canonical state is a later tranche.

## Scanner and Failure Semantics

Complete records must extend the checkpoint/current full tip. Adjacent,
byte-identical repetitions of the immediately preceding accepted frame are
recognized and counted but not appended to the returned transaction list.
They do not advance the tip or run reducers twice. Older out-of-order duplicates,
duplicates of an unavailable checkpoint record, txId reuse with another digest,
sequence gaps, other epochs/stores and wrong predecessor digests fail closed.
No mutation-ID deduplication map is maintained.

A matching partial frame at physical EOF returns tail=incomplete, the validated
prefix transactions, prefix tip, completeBytes, and tailBytes. It never advances
the tip. Available complete header/body regions and trailer prefixes are checked;
invalid UTF-8 in partial body/header regions is corruption. Magic starts with FF,
which cannot occur in valid UTF-8 JSON, so a following frame cannot be hidden as
an incomplete JSON body. Incomplete bytes are not asserted to be a valid future
transaction. Normal scanning never resynchronizes past corruption.

Middle corruption, inconsistent lengths, invalid checksums, noncanonical complete
metadata and unsupported committed operation versions return an error without
a recoverable prefix result. Unknown formats/versions use
UNSUPPORTED_PERSISTENCE_FORMAT; corruption uses PERSISTENCE_CORRUPTION.
Strict single-frame decoding reports incomplete input as RECOVERY_REQUIRED.
No scanner path truncates, repairs, promotes, or writes anything.

## Deterministic Reducer Boundary

createReplayRegistry snapshots definitions keyed by operation type/version and
rejects duplicate definitions. Its default registry is empty. Test operations
exist only under tests; there are no fallback reducers or dynamic code loading.

Validators and reducers are trusted, synchronous, audited pure code, not
application callbacks. Their released version semantics must never be replaced.
The library cannot sandbox arbitrary JavaScript or prove the purity of a supplied
function/closure. A reducer is forbidden from consulting clocks, generating IDs,
performing I/O, invoking hooks, inferring links, generating additional operations,
or emitting notifications/receipts. All reproduction values must be in payload.

replayWal validates the entire bounded batch before running any reducer. It
clones/freezes the initial JSON state and each reducer result, preserves operation
order, excludes duplicate frames and incomplete tails, and returns detached state.
Failure returns no partially reduced state and does not mutate caller state.
There is no call into EtherMemoriesCore or public live mutation methods.

## Review and Fixtures

The Tranche 2 frozen HEAD/checkpoint fixture remains unchanged. No frozen WAL
fixture is added in this pass: the new format is precisely specified and tested
here, but is being submitted for independent review before a fixture is pinned
to a source checkpoint. No v0.6 release-stability or power-loss claim is made.

The tests attack every truncated prefix, truncation followed by another frame,
length declarations, invalid UTF-8, canonical aliases/duplicate fields, unknown
versions, identities, chains, order, digest spoofing, physical duplicates, bounds,
and reducer isolation. Equal canonical input must encode identically; changes to
logical frame contents must not retain an accepted transaction identity.
