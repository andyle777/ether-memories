# Memory explanation and logical health inspection

`EtherMemoriesCore` and `DurableEtherMemories` support exactly two inspection
methods: `explainMemory(id, { asOf? })` and `inspectMemoryHealth({ asOf? })`.
Both return the existing `Result` shape. `asOf` is a finite epoch millisecond
number within JavaScript's Date range. When omitted, the facade captures
`Date.now()` once; analysis uses only that captured value.

```ts
const explanation = core.explainMemory(noteId, { asOf: 1893456000000 });
const health = core.inspectMemoryHealth({ asOf: 1893456000000 });
```

Explanation covers Memory Notes only, including archived, candidate, and rejected
notes. It reports stored status, source, category, sorted tags, confidence, epoch
timestamps, and a provenance whitelist: kind, parent note/diary/edge identifiers,
import batch identifier, and last edit kind. Freeform provenance detail, note
content, summary, metadata, query rank, access frequency, and speculative reasons
are excluded. Missing category/provenance/graph evidence is explicit; no parent
relationship is inferred from a provenance reference. An invalid timestamp or
nonfinite confidence is represented by `null` and unavailable-evidence markers.
Absent expiry is `null` with `expired: false`; invalid expiry has `expired: null`.
Expiry is inclusive (`expiresAt <= asOf`) and independent of stored lifecycle
status. It never purges or promotes a note.

Graph evidence contains only direct edge ID, canonical relationship, direction
(`in`, `out`, `self`), and adjacent graph ID. Self loops count once. Adjacent
bodies, labels, attributes and second-hop relationships are never inspected.
Edge IDs determine order using UTF-16 code-unit comparison, never locale order
or Graphology iteration order. Known count, returned count, truncation, and
limit reasons accompany every relationship list.

Health is an inspection of logical Memory Note state. `invariantFailures`
identify invalid confidence, lifecycle status, or timestamps against the current
snapshot model. These checks are reachable through existing in-memory mutation
or replacement paths; notes do not have a chronology-order invariant.
`observations` count effective expiry, missing foundation graph nodes, and
present but isolated graph nodes. A missing node is not declared corruption:
public note and graph modules can legitimately be used separately.
`suggestions` identify possible review/linking work and always carry
`authoritative: false`. There is no score or overall healthy boolean.
Lifecycle and expiry counts describe inspected notes only, including in partial
reports. Coverage states the total known population, inspected count, completion,
and reasons. These methods never scan files, HEAD, WAL, receipts, locks,
checkpoints, or garbage-collection state and never diagnose persistence health.

## Fixed bounds

Bounds cannot be increased by callers.

| Field or work | Hard cap | Above the cap |
| --- | ---: | --- |
| Identifier selection population | 4,096 notes | Partial health, zero inspected |
| Identifier selection UTF-8 bytes | 1,048,576 | Partial health, zero inspected |
| Projected health notes | 256 | Sorted prefix, partial coverage |
| Selected scalar | 256 UTF-16 code units | Explanation `INVALID_INPUT`; health oversized IDs give partial coverage |
| Direct edge selection | 4,096 edges | Zero returned, known count and work-limit reason |
| Edge identifier selection UTF-8 bytes | 1,048,576 | Zero returned, byte-limit reason |
| Returned direct edges | 32 | Sorted prefix, explicit truncation |
| Tag selection | 256 tags | Zero returned, explicit work-limit evidence |
| Returned tags | 32 | Sorted prefix, explicit truncation |
| Detached snapshot | 262,144 UTF-8 bytes | Partial health prefix; explanation `INVALID_INPUT` |
| Per-note invariant findings | 128 | `findingsTruncated: true` |

Health reserves 1,024 bytes of the snapshot cap for its envelope. Its output adds
at most three aggregate observations and two suggestions. Explanation's fixed
field, scalar, tag and edge caps bound output below the snapshot cap. Sorting is
performed before output truncation. A population too large to examine all IDs
within the selection bounds yields zero inspected rather than an insertion-order
sample. Multiple reasons have fixed precedence/order. Byte accounting scans only
bounded scalars; it does not stringify unused metadata or bodies.

Health makes at most 4,096 identifier visits and 256 note projections. Each
projection uses indexed graph membership, degree, and self-loop lookup; it never
rescans the edge population per note. Explanation reads one note, at most 256
tags, and at most 4,096 incident edge identifiers; it reads attributes only for
the at most 32 selected edges. No recursive graph walk or whole-store export is
used. Projection from owned state precedes the existing clone boundary; the
snapshot contains only primitives, arrays, and plain records, including numeric
dates. Analysis runs synchronously on that detached snapshot. Returned objects
may be changed by callers without changing canonical state; later canonical
mutations cannot alter an earlier snapshot or report.

Invalid or oversized IDs/options return `INVALID_INPUT`; unknown note IDs return
`NOT_FOUND`. Oversized explanatory evidence returns `INVALID_INPUT` rather than
silently shortening an identifier. Durable inspection obtains one readable
committed generation, then fails with `RECOVERY_REQUIRED` in recovery-required
state or `CLOSED` after close, before input validation or clock capture. Earlier
durable read methods retain their existing semantics. Ready durable and Core
reports match for identical logical state and `asOf`.

Inspection changes no status, revision, timestamps, identity activity, IDs,
storage, tip or durable bytes. It offers no repair authority and introduces no
persistence format, receipt, cache, dependency, or version change. Package version
remains 0.6.0 during the v0.7.0 tranche work.
