# Ether Memories v0.5.0

**Civilian-grade, local-first memory infrastructure for humans and AI systems.**

Ether Memories has three foundations:

1. **Memory Notes** — durable explicit facts, preferences, and project knowledge.
2. **Diary** — chronological narrative history.
3. **Mind Graph** — relationships between memory entities.

Condensation is a **processing layer**, not a fourth foundation.

## v0.5.0 — Deterministic Retrieval & Memory Intelligence

v0.5.0 strengthens deterministic retrieval, memory processing, portability, and evidence accuracy while preserving the provider-neutral, local-first architecture.

### Core improvements

- **Match-class gated deterministic retrieval**: strict precedence from `explicit_id` through `exact_phrase`, `full_token_match`, `partial_token_match`, `tag_metadata_match`, and `graph_only`, with stable tie-breaking.
- **Canonical Unicode tokenizer**: NFC normalization, locale-independent processing, and deterministic punctuation and whitespace handling without stemming or stop-word heuristics.
- **Revision-aware lexical index**: derived, in-memory, and rebuildable; manager mutation revisions keep retrieval current while Notes and Diary remain canonical truth.
- **Explicit `asOf`**: reproducible expiry-sensitive retrieval for the same store, query, options, and frozen time.
- **Structured Retrieval Evidence v2**: match-class, lexical, token, and graph evidence explains selection without phantom scoring or retrieval signals.
- **Deterministic bounded Graph Recall v2**: opt-in traversal with best-path selection, stable edge evidence, direction and relation filtering, and authoritative live Note lifecycle state.
- **Transactional Portable Record v1 import**: bounded Note/Diary ingestion with timestamp and citation validation, duplicate/conflict detection, deterministic validation receipts, and zero-mutation rejection on blocking failures.
- **Deterministic Condensation v2**: side-effect-free analysis derives rule-based facts, tags, category, and confidence; committing the analysis creates a candidate note through the Core lifecycle. Analysis is reproducible; generated IDs and creation timestamps are not required to be.
- **Candidate isolation and promotion**: condensed memories remain hidden from default retrieval until explicitly promoted; explicit MemoryContext Note IDs also respect candidate, archive, and expiry filters.
- Existing identity restoration, Diary CRUD, FoundationLinker coherence, pinned-edit protection, persistence, bounded MemoryContext, and pure Agent Tool and RLM adapters remain available.
- No LLM, embedding, vector database, autonomous agent, or network dependency.

### Compatibility

v0.5.0 preserves v0.4 persistence compatibility and the existing schema contracts:

- Store: `ether.memory_store.v0.3`
- MemoryContext: `ether.memory_context.v1`
- Portable Record: `ether.portable_record.v1`

Snapshots provide canonical persistence for the complete library state. Portable Record v1 is Note/Diary interchange only; it does not import identity or graph state and is not a snapshot replacement.

### Release verification

The [published v0.5.0 release](https://github.com/andyle777/ether-memories/releases/tag/v0.5.0) passed:

- 73 tests.
- TypeScript typecheck and production build.
- `npm pack` and packed-consumer runtime verification.
- External TypeScript declaration compilation.
- GitHub CI on Ubuntu with Node 22/24 and Windows with Node 22/24.

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

v0.5.0 is retrieval-native but deliberately does **not** require embeddings or a vector database. A future RAG adapter can turn `MemoryContext` records into chunks; semantic/vector implementations remain outside this release.

### RLM boundary

`toRlmEnv()` provides stable handles and a bounded context. An RLM host may re-enter Ether through ordinary APIs. Ether does not contain an RLM runtime.

## Quick start

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

Created and maintained by Andy Le, with assistance from ChatGPT (OpenAI), GitHub Copilot, and Mistral Vibe. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution details.

MIT licensed.
