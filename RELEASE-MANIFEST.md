# Ether Memories v0.3.0 Release Manifest

Version: 0.3.0
Branch: main
Commit: 3aba15fe883d3433b02b2889819602c9e5c65979

This manifest describes the published v0.3.0 release.

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
Post-release adversarial testing identified the v0.3.1 stability work: duplicate graph-edge handling, diary text retrieval in MemoryContext, FoundationLinker lifecycle coherence for condensation and expiry, truthful retrieval evidence, and bounded-context accounting clarification.

Run:
```bash
npm install
npm run typecheck
npm test
npm run build
```
before publishing.
