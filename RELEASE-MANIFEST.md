# Ether Memories v0.3.0 Release Manifest

This archive is the clean v0.3.0 source package generated from the unified v0.3 design agreed by Andy, Leia, and Aether.

## Canonical goals
- Three foundations: Memory Notes, Diary, Mind Graph.
- Condensation remains a processor.
- Trust-first identity, provenance, lifecycle, and import validation.
- FoundationLinker and deterministic graph relationships.
- Explainable retrieval.
- `MemoryContext` as a bounded, citeable, provider-neutral transport.
- Agent and RLM adapters without embedding an RLM or LLM in the core.
- RAG-ready seam without vectors or embeddings.

## Important
The GitHub repository inspected immediately before archive creation still contained the shipped v0.2.0 source. This ZIP is therefore a clean generated v0.3.0 build from the agreed specification rather than a byte-for-byte recovery of an unavailable local v0.3 workspace.

Run:
```bash
npm install
npm run typecheck
npm test
npm run build
```
before publishing.
