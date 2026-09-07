# Ether Memories v0.3.2 Release Manifest

Version: 0.3.2
Branch: fix/v0.3.2-forward-compat

This manifest describes the v0.3.2 forward-compatibility hardening release.

## Release lineage
- **v0.3.0** — Three rooms, one transport.
- **v0.3.1** — Stability hardening for graph edges, Diary retrieval, lifecycle coherence, truthful retrieval evidence, and bounded-context accounting.
- **v0.3.2** — Forward-compatibility hardening for versioned snapshot schemas.

## Canonical goals
- Three foundations: Memory Notes, Diary, Mind Graph.
- Condensation remains a processor.
- Trust-first identity, provenance, lifecycle, and import validation.
- FoundationLinker and deterministic graph relationships.
- Explainable retrieval.
- `MemoryContext` as a bounded, citeable, provider-neutral transport.
- Agent and RLM adapters without embedding an RLM or LLM in the core.
- RAG-ready seam without vectors or embeddings.

## Post-release hardening
The v0.3.1 stability work is part of the release lineage above; it was completed before the v0.3.2 forward-compatibility hardening.

Run:
```bash
npm install
npm run typecheck
npm test
npm run build
```
before publishing.
