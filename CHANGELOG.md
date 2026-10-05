# Changelog

## 0.6.0 — Durable Persistence

- Added an opt-in durable store: `openDurableEtherMemories()` with WAL-transactional commits
  under exclusive writer authority and crash-consistent startup recovery.
- Added deterministic retry identity: caller-supplied mutation IDs reconcile lost
  acknowledgments without duplicate effects, including after restart.
- Added explicit `rotate()`: checkpoint activation, a cumulative durable receipt ledger,
  exact historical result reconstruction, and safe reclamation of the retired WAL segment
  only after the new lineage is authoritative.
- Added explicit `collectGarbage()`: reclaims only payload objects provably unreachable from
  every authoritative structure; committed objects are permanent roots and no tombstone
  engine exists.
- Added explicit `runMaintenance()`: one deterministic maintenance operation deriving a
  rotation recommendation from the configured active-WAL envelope and the frozen WAL v1
  frame cap, performing the existing rotation only when recommended, and following a fully
  successful rotation with the existing orphan collection. No background maintenance.
- T10 remains an unfrozen implementation candidate. Maintenance adds no persisted
  policy or formats, does not auto-break writer locks, and does not weaken exact
  mutation admission; GC failures preserve the already-committed rotation.
- Added bounded-memory operation for unbounded histories: streamed directory inventory,
  external cascade sorting, sealed and per-record-authenticated scratch processing, and
  captured-tip plus exact `marks ⊆ inventory` coverage proofs before any unlink.
- Preserved persisted formats: the store schema remains `ether.memory_store.v0.3`; snapshots,
  checkpoints, WAL frames, and frozen fixtures are unchanged.
- Known limitation: native Windows power-loss durability is not claimed; durable-mode
  initialization fails closed with `DURABILITY_UNAVAILABLE` on Windows, and probes use
  simulated directory barriers there.

## 0.5.0 — Deterministic Retrieval & Memory Intelligence

- Added match-class gated deterministic retrieval with a canonical Unicode tokenizer and
  structured retrieval evidence.
- Added deterministic Condensation v2 with candidate isolation and explicit promotion.
- Added transactional Portable Record v1 import with validation receipts.
- Preserved all persisted schema contracts and v0.4 persistence compatibility.

## 0.4.0 — Portable Recall

- Added validated transactional snapshot imports and stable graph-edge identities.
- Added injectable storage, crash-safer filesystem replacement, clone-on-read results,
  opt-in graph-assisted recall, and provider-neutral portable records.

## 0.3.2 — Forward-Compatibility Hardening

- Centralized the current library and schema versions.
- Rejected unsupported snapshot schemas before import state mutation.
- Preserved v0.3 snapshot, identity, hydration, and persistence behavior.

## 0.3.1 — Stability Hardening

- Hardened duplicate graph-edge handling.
- Added Diary text retrieval to `MemoryContext`.
- Kept FoundationLinker lifecycle state coherent through condensation and expiry.
- Corrected retrieval evidence and clarified bounded-context accounting.

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
