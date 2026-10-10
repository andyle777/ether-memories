# Dream Analysis v1

Core and the durable facade expose the same synchronous method:
`runDreamCycle(plan: DreamPlan): Result<DreamCycleResult>`. The root exports
`DreamCycleResult`, `DreamProposal` and `DreamProposalEvidence` as types only.
The algorithm remains `ether.dream.v1`; the package remains version 0.6.0.

```ts
const preview = core.previewDreamCycle(
  { kind: "ids", ids: [firstNoteId, secondNoteId] },
  { asOf: 1893456000000, budgets: { maxSources: 32 } }
);
if (preview.ok) {
  const analysis = core.runDreamCycle(preview.value);
  if (analysis.ok) console.log(analysis.value.proposals);
  else if (analysis.error.code === "CONFLICT") {
    // Inspect current memory, then create and review a new preview.
  }
}
```

Dream output is an ephemeral suggestion. It is never a `MemoryNote`, candidate,
graph proposal, receipt or stored history. There is no apply, accept, reject,
commit or promotion API for Dream proposals. Execution changes no Notes, Diary,
Graph, access metadata, revision, durable lifecycle, tip, WAL, receipt,
checkpoint, HEAD, writer queue or garbage collection state, and performs no
durable I/O. No model, network service, embeddings, RAG or scheduler is involved.

## Validation and observation

A plan is untrusted input. Fixed descriptor reads validate recognized plain
data without invoking accessors, proxy traps or enumerating unknown keys.
Unknown properties are ignored. Algorithm validation precedes remaining plan
fields. Shape contradictions return `INVALID_INPUT`; a bounded well-formed
unsupported algorithm returns `UNSUPPORTED_SCHEMA`.

Execution recaptures frozen [Dream Plan inputs](dream-plan.md) under the exact
normalized selector, `asOf` and budgets, recomputes the dependency digest and
plan ID, and compares every recognized plan field. A structurally valid
mismatch, missing/ineligible source or expected recapture bound failure returns
`CONFLICT`; preview again. Plans are never automatically refreshed. Unexpected
internal capture, encoding or analysis failures return a fixed `UNKNOWN_ERROR`
without source details or partial proposals. Durable authority precedes caller
validation: `CLOSED`, then `RECOVERY_REQUIRED`; recovery is explicit.

Selector matching and coverage may require bounded reads of otherwise
unselected notes, exactly as frozen T3 does. Those reads occur only during
recapture from the same authoritative observation/generation as dependency
capture. After successful full-plan comparison, analysis receives only owned
selected note projections, selected-to-selected relationships and the four
binding fields `algorithm`, `planId`, `dependencyDigest`, `asOf`. No raw
unselected IDs, content, tags, graph data, selector or coverage enters analysis,
duplicate suppression, evidence, proposal identity or returned output. There
are zero live authoritative reads after comparison. Opaque frozen plan hashes
remain the binding; no global revision or persistence generation is added.

Bound content, tags, creation/expiry, eligibility, membership, coverage and
induced relationships determine staleness. Unbound metadata, summary, category,
confidence, timestamps such as `updatedAt`, node labels and unrelated explicit-ID
state do not. The captured `asOf` governs expiry even if wall time advances.

## Proposals and evidence

Each selected note is one analysis unit, ordered by source ID using UTF16 code
units. A private Condensation engine calls `analyze` with the fixed configuration:
five facts, minimum eight and maximum 240 UTF16 units per fact, summary 200
units, eight internally derived tags. Only the summary and ordered key facts
are projected. No derived tags, category, confidence or provenance is returned.
`commitAnalysis`, `condense` and candidate callbacks are never called. A summary
cut removes a trailing high surrogate before `...` so valid source Unicode
cannot become malformed at the cut; global Condensation behavior is unchanged.

A proposal has `proposalId`, `content`, one-element `sourceIds` and `evidence`.
Evidence has ordered `keyFacts`, a prefix of incident selected relationships
(`id`, `source`, `target`, `relationship`), exact `relationshipKnownCount`,
`relationshipsTruncated` and ordered `truncationReasons`. A self-edge counts once.
Relationships sort by ID, source, target, relationship using code units.
Reasons are `relationship-limit`, then `relationship-byte-limit` when applicable.

Literal equality with any selected source content suppresses a proposal, with
no trim, case folding or fuzzy search in that comparison. Otherwise proposals
are duplicates only when canonical `{content,keyFacts}` bytes match exactly.
The lowest source ID represents duplicates; origins and evidence are not
unioned. Different key facts survive even if summaries match. Unselected
content never suppresses output.

Proposal IDs are SHA-256 over bounded canonical data with domain
`ether.dream.proposal.v1`, algorithm `ether.dream.v1`, validated `planId` and the
complete final proposal fields except `proposalId`, including bounded evidence,
counts, flags and reasons. No random value, wall clock, ordinal, package version
or persistence identity is added. Ordering, IDs and result bytes are reproducible
across insertion order, replay, supported Node versions and platforms.

## Fixed execution limits and result

| Resource | Hard ceiling |
| --- | --- |
| Analysis units | 128 selected notes |
| Returned proposals | 32 |
| Proposal content | 200 UTF16 units |
| Key facts | 5, each 8–240 UTF16 units |
| Source IDs per proposal | 1, at most 256 UTF16 units |
| Relationship evidence | 8 edges; each scalar at most 256 UTF16 units |
| Complete proposal encoding | 16,384 UTF8 bytes |
| Proposal identity preimage | 32,768 UTF8 bytes |
| Proposal array encoding | 261,120 UTF8 bytes, including brackets and commas |
| Whole result encoding | 262,144 UTF8 bytes; 1,024-byte envelope reservation |
| Canonical encoder | Depth 16, nodes 65,536 |

These limits are fixed for v1. Existing T3 budgets bound recapture and may only
be lowered; they do not configure analysis limits. Every bounded unit is
evaluated so `knownProposalCount` is exact after suppression. At most 128 bounded
generated proposals are retained internally (at most 2 MiB of encoded proposals)
before result admission. Evidence and results admit an ordered prefix; an
oversized earlier item is never skipped for a later item.

The result returns `algorithm`, `planId`, `dependencyDigest`, `asOf`,
`sourceCount`, `knownProposalCount`, `proposalCount`, `proposals`,
`proposalsTruncated` and `truncationReasons`. Result reasons are `proposal-limit`,
then `result-byte-limit`. Counts remain truthful when both limits apply.
Empty valid selections and fully suppressed output succeed with an empty
proposal array. Successful replay returns deeply equal detached results;
mutating a returned array, proposal or nested evidence cannot change canonical
state or a later result. Later memory changes cannot alter prior results.
