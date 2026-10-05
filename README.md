# Ether Memories v0.6.0

Canonical project name: **Ether Memories**; package and repository: `ether-memories`.

**Civilian-grade, local-first memory infrastructure for humans and AI systems.**

Ether Memories has three foundations:

1. **Memory Notes** — durable explicit facts, preferences, and project knowledge.
2. **Diary** — chronological narrative history.
3. **Mind Graph** — relationships between memory entities.

Condensation is a **processing layer**, not a fourth foundation.

## v0.6.0 — Durable Persistence

v0.6.0 adds an opt-in durable transactional store for the same three foundations: an append-only write-ahead log, exclusive writer authority, and crash-consistent startup recovery. The in-memory core and all v0.5.0 deterministic-retrieval behavior are unchanged.

### Durable persistence

- `openDurableEtherMemories()` — explicit asynchronous factory for the durable runtime; the classic in-memory core is untouched and remains fully supported.
- WAL-transactional commits with caller-supplied mutation IDs: lost acknowledgments reconcile deterministically without duplicate effects, including after restart.
- Crash-consistent startup recovery that distinguishes two cases: a repairable incomplete final transaction tail is truncated at the last complete transaction under writer authority, synchronized, and the WAL is rescanned — startup may then succeed — while complete or structural corruption always fails closed and requires explicit recovery.
- Explicit `rotate()`: activates a new checkpoint, writes a cumulative durable receipt ledger, preserves exact historical result reconstruction, and reclaims the retired WAL segment only after the new lineage is authoritative.
- Explicit `collectGarbage()`: reclaims only payload objects that are provably unreachable from every authoritative structure — committed objects are permanent roots, and no tombstone engine exists.
- Explicit `runMaintenance()`: one deterministic maintenance operation that derives a rotation recommendation from the configured active-WAL envelope and the frozen WAL frame cap, performs the existing rotation only when recommended, and follows a fully successful rotation with the existing orphan collection. Failures return the existing errors with the original details plus the maintenance stage; maintenance never runs in the background.
- Bounded-memory operation for unbounded histories: streamed directory inventory, external cascade sorting, sealed and per-record-authenticated scratch processing, and captured-tip plus exact coverage proofs (`marks ⊆ inventory`) before any unlink.
- Deterministic failure classification: maintenance failures alone leave the runtime ready; authority uncertainty and authoritative corruption retain precedence and can require recovery.

Maintenance is operator-driven: there is no background scheduler or automatic GC
threshold. A no-op reports only that no rotation was recommended from that
invocation's observation; exact mutation precommit remains the envelope admission
authority. GC runs only after rotation fully succeeds, and a GC failure does not
roll back that committed rotation. Writer locks are never auto-broken. T10 adds no
persisted maintenance state and changes no schema, wire, receipt, or checkpoint
format. See [maintenance orchestration](docs/af1-tranche10-maintenance-orchestration.md)
for the frozen T10 contract and code-lineage receipt.

### Platform support

Durable mode requires a platform with native file and directory durability barriers (Linux and macOS). On Windows, native directory durability is unavailable: durable-mode initialization fails closed with `DURABILITY_UNAVAILABLE` rather than weakening the protocol, and the test suite and probes run with simulated directory barriers. Native Windows power-loss durability is not claimed.

### Compatibility

v0.6.0 preserves the persisted schema contracts:

- Store: `ether.memory_store.v0.3`
- MemoryContext: `ether.memory_context.v1`
- Portable Record: `ether.portable_record.v1`

The durable store persists the same canonical snapshot payload; its on-disk layout (HEAD, checkpoints, WAL, receipts) is an internal implementation detail, not a public path contract. Legacy snapshot persistence (`EtherMemoriesCore` with a `StoragePort`/`storagePath`) is unchanged.

### Release verification

AF1 Tranche 10 is frozen by owner decision at code-lineage SHA
`6f298aea2cd0278078bf49344f75807355a4e09b`. Subsequent naming and status documentation
commits do not replace that frozen SHA. Merge commits record integration into the
stacked bases and `main`; see [integration lineage](docs/v0.6.0-integration.md).
Tagging and publication remain separate actions.

v0.6.0 verification (AF1 Tranches 1–10) runs:

- Full test suite (29 files / 687 tests at the frozen T10 SHA), TypeScript typecheck, and production build.
- Compiled recovery, runtime, rotation, garbage-collection, and 10,000-mutation maintenance probes, with simulated directory barriers on Windows.
- Frozen wire-fixture digest gates, package-root public-surface and declaration gates, a destructive-collector containment audit over every emitted module, and packed-consumer verification.

## Architecture

```text
L0 Durable Store
  Notes + Diary + Mind Graph + identity
          |
          v
L1 MemoryContext
  bounded / citeable / explainable projection
          |
     +----+----+----------------+
     |         |                |
    LLM      Agent             RLM
     |         |                |
  adapters   adapters        adapters
```

The core is provider-neutral. OpenAI, Anthropic, Gemini, local models, agent hosts, and future RLM implementations can consume the same canonical transport without becoming dependencies of the memory engine.

### RAG boundary

Ether Memories is retrieval-native but deliberately does **not** require embeddings or a vector database. A future RAG adapter can turn `MemoryContext` records into chunks; semantic/vector implementations remain outside this release.

### RLM boundary

`toRlmEnv()` provides stable handles and a bounded context. An RLM host may re-enter Ether through ordinary APIs. Ether does not contain an RLM runtime.

## Quick start

In-memory core:

```ts
import { EtherMemoriesCore } from "ether-memories";

const ether = new EtherMemoriesCore({ userId: "local-user" });

ether.addMemory({
  content: "My project uses TypeScript.",
  tags: ["project"]
});

const result = ether.buildMemoryContext({
  purpose: "agent_tool",
  query: {
    text: "TypeScript project",
    budget: {
      maxNotes: 8,
      maxDiary: 2,
      maxNodes: 16,
      maxEdges: 16,
      maxChars: 8000
    }
  }
});
```

Durable mode (Linux/macOS):

```ts
import { openDurableEtherMemories, createMutationId } from "ether-memories";

const opened = await openDurableEtherMemories({
  userId: "local-user",
  directory: "./ether-store"
});

if (!opened.ok) {
  // The factory returns Result<DurableEtherMemories>: handle failure explicitly.
  throw new Error(`durable open failed: ${opened.error.message}`);
}

const ether = opened.value;

// The mutation ID is the caller's stable identity: retain it, and a retry
// after a lost acknowledgment reconciles to the original committed
// transaction instead of duplicating it.
const addProjectNote = createMutationId();
await ether.addMemory(
  { content: "My project uses TypeScript.", tags: ["project"] },
  addProjectNote
);

await ether.rotate();          // explicit checkpoint + receipt ledger rotation
await ether.collectGarbage();  // explicit reclamation of orphaned payload objects
await ether.close();
```

## Scope fence

Ether Memories is a standalone public memory infrastructure project. Agent orchestration, distributed coordination, personality systems, autonomous self-modification, private framework integrations, and unrelated experimental architectures are intentionally outside project scope.

Ether Memories is intentionally civilian-grade.

It does not provide authentication, authorization, multi-tenant security, distributed synchronization, autonomous memory decisions, personality modeling, self-modification, or an embedded AI model.

**LLM-friendly does not mean LLM-inside.**

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Contributors and acknowledgements

Created and maintained by Andy Le, with assistance from ChatGPT (OpenAI), ChatGPT (Codex, OpenAI), GitHub Copilot, and Mistral Vibe. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution details.

MIT licensed.
