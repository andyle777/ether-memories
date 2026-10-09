# Dream Plan v1

`previewDreamCycle(selector, options?)` returns `Result<DreamPlan>` on Core and
the durable facade. It selects and binds inputs for future analysis. It does
not analyze, condense, propose, mutate or persist. `runDreamCycle()` is future
T4 work and is unavailable. There are no embeddings, external services, RAG,
background jobs, signing keys or plan migrations.

```ts
const result = core.previewDreamCycle(
  { kind: "ids", ids: [firstNoteId, secondNoteId] },
  { asOf: 1893456000000, budgets: { maxSources: 32 } }
);
if (result.ok) console.log(result.value.planId, result.value.selectedSourceIds);
```

The algorithm identity is `ether.dream.v1`, independent of library0.6.0.
Dreams propose. Memory remains authoritative. Plans select. Analysis waits.

## Selection and eligibility

An explicit single selector mode is mandatory:

| Selector | Rule |
| --- | --- |
| `{kind:"ids", ids:[...]}` | Exact canonical Memory Note IDs; unknown IDs fail NOT_FOUND, known ineligible IDs fail INVALID_INPUT |
| `{kind:"tags", tags:[...]}` | Every exact tag must occur; no case/fuzzy/whitespace normalization |
| `{kind:"query", query:"..."}` | All existing-tokenizer NFC/lowercase tokens must occur in canonical content; no summary/category/metadata/Diary matching or graph recall |
| `{kind:"date-window", from, to}` | Creation epoch in inclusive-from/exclusive-to interval `[from,to)`; equal endpoints yield an empty selection |
| `{kind:"all_active"}` | Explicit eligible population, within the same hard ceilings |

IDs and tag selectors validate raw count/type/scalar length before whitespace
checks, then deduplicate and sort by UTF16 code units. IDs are not trimmed or
rewritten. Query normalization uses the existing tokenizer; normalized token
order is retained. Final source IDs are always code-unit sorted before the
source ceiling is applied. No locale-sensitive ordering or random IDs.

Eligible means `status === "active"`, `createdAt <= asOf`, and no expiry or
`expiresAt > asOf`. Promoting an existing candidate sets status active in this
model. Candidate, archived, rejected, future-created and expired notes are
excluded regardless of pinning/source. Diary and graph-only nodes never qualify.
No expiry purge or lifecycle/access update occurs.

The existing retriever rebuilds Diary indexes and clones arbitrary metadata;
it cannot meet this boundary/work contract. This private adapter reuses its
tokenizer for the smallest bounded content-only conjunctive query, without
changing retrieval itself or inventing another subsystem.

`asOf` is integer epoch milliseconds in the JavaScript Date range. When absent,
one Date.now observation is captured at planner entry and reused everywhere.
The durable facade first enforces existing CLOSED/RECOVERY_REQUIRED precedence;
those failures do not read a clock or validate the selector.

Request/option/budget objects and selector arrays must be ordinary data
containers. Accessor fields fail without getter invocation. Proxy containers
are rejected using Node's built-in proxy detection before prototype, property
or array checks can invoke caller traps. No new dependency is required.

## Plan fields and forward validation

The four public types are `DreamSelector`, `DreamBudgets`,
`DreamCyclePreviewOptions`, and `DreamPlan`. Exact plan fields:

`algorithm`, `planId`, `asOf`, normalized `selector`, `selectedSourceIds`,
`selectedCount`, `knownCount`, `selectionTruncated`, `truncationReasons`,
`dependencyDigest`, effective `budgets`, and `graph: {relationshipCount}`.

The plan contains no source bodies, edge bodies, live Dates, Maps, Sets,
Graphology objects, canonical object references or filesystem handles.
Every nested returned object/array is newly owned. A plan is ephemeral plain
data, not a security token. Future T4 must treat it as hostile input, validate
algorithm/shape/bounds, recapture selection and dependencies using its exact
selector/asOf/budgets, and recompute both identities before analysis. It must
reject incompatible algorithms or stale/malformed plans. T3 implements no
execution, acceptance, history, signing or migration mechanism.

## Exact consumed dependency projection

| Field | Purpose |
| --- | --- |
| Note id | Exact source identity and selected boundary |
| Note content | Exact bounded canonical text made available to future analysis |
| Note tags (unique, code-unit sorted) | Exact tag evidence; also tag selector resolution |
| Note status (active) | Authoritative lifecycle eligibility |
| Note createdAt (epoch) | Creation/temporal context, eligibility and date-window resolution |
| Note expiresAt (epoch/null) | Exact expiry input for the captured observation time |
| Induced edge id/source/target/relationship | Exact directed selected-selected relationship identity and semantics |

Summary/category/source/provenance/importance/confidence/pinning/arbitrary
metadata/access state are excluded. updatedAt is excluded because unused
metadata edits change it. Graph labels/node data/edge data, unselected endpoint
IDs/content, Diary, persistence paths/tips/writers, package version and global
revision are excluded. No arbitrary object serialization or recursive traversal.

The SHA256 dependency digest hashes existing bounded canonicalJson encoding of
domain `ether.dream.dependencies.v1`, algorithm, normalized request
(selector/asOf/budgets), selection coverage, projected notes and sorted induced
relationships. Plan ID independently hashes domain `ether.dream.plan.v1` plus
every plan field except planId. Separate domains distinguish dependency binding
from exact normalized plan identity. Canonical key ordering is the existing
UTF16/ECMAScript encoder, not a new JSON implementation or hashing dependency.

## Selector-specific staleness and coverage

Known count is the exact eligible matching count from the bounded selector scan.
Selection truncation selects the lowest source IDs and reports `source-limit`.
Explicit-ID previews never enumerate unrelated population. Other selectors fail
before enumeration when the population work ceiling is exceeded; no false
partial/full-coverage plan is returned in that case.

The selected set AND its matching-count coverage bind identity. For tags/query/
date/all_active, a new match entering the bounded set changes dependencies. A
new match beyond the selected cap also changes knownCount and identity. An
unmatched note's irrelevant body/metadata change does not. For ID selectors,
unrequested note creation/edits and all out-of-boundary graph changes are
irrelevant. No global store revision invalidates a plan.

## Production bounds

| Resource | Hard ceiling |
| --- | --- |
| Raw selector IDs/tags | 256 |
| ID/tag/edge-ID/relationship scalar | 256 UTF16 code units |
| Raw and normalized query | 4096 UTF16 code units each |
| Non-ID population | 4096 notes |
| Selected sources | 128 |
| Canonical raw tags per examined note | 64 |
| Content per examined/selected note | 65536 UTF8 bytes, code-unit precheck first |
| Canonical dependency bytes per note | 131072 |
| Selector scan bytes | 4194304 |
| Complete canonical dependency bytes | 1048576 |
| Induced relationships | 1024 |
| Selected-directed pair lookups | At most128² =16384; zero neighbor expansion |
| Canonical plan output bytes | 65536 |
| Encoder work | Depth16/nodes65536, bounded strings/arrays first |

Budget options may only reduce positive integer ceilings for population,
sources, tags, content bytes, per-note bytes, selection bytes, total dependency
bytes, relationships and plan bytes. Limits are established before projection;
aggregate note/relationship budgets stop capture before later material is read.
Final canonical encoding includes all request/coverage/encoding overhead too.
Only source-count overflow yields a truncated plan; other resource/input failures
return INVALID_INPUT, never silently incomplete dependency evidence. No normal
operation throws. No dependency or persisted format/version changes.
