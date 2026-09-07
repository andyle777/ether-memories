# Ether Memories v0.3.2 Release Manifest

Version: 0.3.2
Branch: fix/v0.3.2-forward-compat

This manifest describes the v0.3.2 forward-compatibility hardening release.

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
