# Ether Memories v0.3.2

**Civilian-grade, local-first memory infrastructure for humans and AI systems.**

Ether Memories has three foundations:

1. **Memory Notes** — durable explicit facts, preferences, and project knowledge.
2. **Diary** — chronological narrative history.
3. **Mind Graph** — relationships between memory entities.

Condensation is a **processing layer**, not a fourth foundation.

## v0.3.2

v0.3 makes the three rooms one reload-safe system and adds an AI-native transport boundary without putting models inside the library.

### Core improvements

- Identity restoration and user-ID mismatch protection.
- Full Diary CRUD.
- FoundationLinker between Notes, Diary, and Mind Graph.
- Stable UUID-based IDs.
- Provenance and thin lifecycle status.
- Pinned-edit protection.
- Deterministic retrieval with explainable matches.
- Graph neighbors and typed starter relations.
- Candidate promotion and expiry purge.
- `MemoryContext`: bounded, citeable, explainable transport.
- Pure Agent Tool and RLM environment adapters.
- No LLM, embedding, vector database, autonomous agent, or network dependency.

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

v0.3 is retrieval-native but deliberately does **not** require embeddings or a vector database. A future RAG adapter can turn `MemoryContext` records into chunks; semantic/vector implementations are planned for a later release.

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

MIT licensed.
