# Ether Memories v0.4.0 Release Manifest

Version: 0.4.0
Tag: v0.4.0
Lineage: v0.3.2 → v0.4.0
Status: Final release

This manifest describes the final v0.4.0 release.

## Canonical goals
- Three foundations: Memory Notes, Diary, Mind Graph.
- Condensation remains a processor.
- Trust-first identity, provenance, lifecycle, and import validation.
- FoundationLinker and deterministic graph relationships.
- Explainable retrieval.
- `MemoryContext` as a bounded, citeable, provider-neutral transport.
- Agent and RLM adapters without embedding an RLM or LLM in the core.
- RAG-ready seam without vectors or embeddings.

## Portable Recall hardening
- Validated transactional snapshot imports and stable graph-edge identities.
- Injectable storage, crash-safer filesystem replacement, clone-on-read results,
  opt-in graph-assisted recall, and provider-neutral portable records.

Run:
```bash
npm ci
npm run typecheck
npm test
npm run build
```
before publishing.
