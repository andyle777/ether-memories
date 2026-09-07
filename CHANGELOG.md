# Changelog

## 0.3.2 — Forward-Compatibility Hardening

- Centralized the current library and schema versions.
- Rejected unsupported snapshot schemas before import state mutation.
- Preserved v0.3 snapshot, identity, hydration, and persistence behavior.

## 0.3.0 — Three Rooms, One Transport

- Restored persistent identity and user-ID conflict protection.
- Added complete Diary CRUD.
- Added FoundationLinker and graph neighborhood helpers.
- Added provenance and thin lifecycle status.
- Added pinned edit shield and candidate promotion.
- Added deterministic retrieval explanations.
- Added bounded `MemoryContext` transport with schema version, purpose, budgets, citations, retrieval trace, and truncation reporting.
- Added pure `toPlainJson`, `toAgentToolResult`, and `toRlmEnv` adapters.
- Kept vectors, embeddings, LLM dependencies, autonomy, distributed sync, and runtime installation out of scope.

## 0.2.0 — Three Foundations of Memory

- Memory Notes, Diary, Mind Graph.
- Condensation demoted to processing layer.
- Deterministic retrieval.
- Local JSON persistence.
