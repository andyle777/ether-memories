# Ether Memories v0.6.0 Release Manifest

Version: 0.6.0
Tag: v0.6.0
Lineage: v0.5.0 → v0.6.0
Status: Release candidate (AF1 Tranche 9 verification/integration; pending independent freeze review)

This manifest describes the v0.6.0 release surface.

## Canonical goals

- Three foundations: Memory Notes, Diary, Mind Graph.
- Condensation remains a processor.
- Trust-first identity, provenance, lifecycle, and import validation.
- Deterministic, explainable retrieval and bounded `MemoryContext` transport.
- Agent and RLM adapters without embedding an LLM or RLM in the core.
- Opt-in durable persistence: WAL-transactional commits under exclusive writer authority,
  crash-consistent startup recovery, explicit checkpoint rotation with cumulative durable
  receipts, exact historical result reconstruction, safe retired-WAL reclamation, and
  explicit reclamation of provably orphaned payload objects only.

## Durable persistence (AF1 Tranches 1–9)

- `openDurableEtherMemories()` explicit durable factory; in-memory core unchanged.
- Caller-supplied mutation IDs reconcile lost acknowledgments without duplicate effects.
- Startup recovery distinguishes a repairable incomplete final WAL tail (synchronized
  truncation at the last complete transaction, then a full rescan) from authoritative
  corruption, which always fails closed and requires explicit recovery.
- `rotate()` activates a new checkpoint plus cumulative receipt ledger; retired WAL bytes
  are reclaimed only after the new lineage is authoritative.
- `collectGarbage()` reclaims only payload objects unreachable from every authoritative
  structure (active WAL refs ∪ cumulative receipt refs); committed objects are permanent
  roots; no tombstone engine exists.
- Bounded-memory operation for unbounded histories with sealed, per-record-authenticated
  scratch processing and bidirectional coverage proofs before any unlink.
- Persisted formats unchanged: store schema `ether.memory_store.v0.3`; HEAD/checkpoint
  framing, WAL v1 wire format, snapshot payload profile, receipt v1, and all frozen
  fixtures are byte-identical to the frozen AF1 lineage.

## Known limitations

- Native Windows power-loss durability is NOT claimed; durable-mode initialization fails
  closed with `DURABILITY_UNAVAILABLE` on Windows, and probes use simulated directory
  barriers there.
- Durable surface is single-writer, local-filesystem only; no distributed writers.
- Automatic GC or rotation thresholds, receipt/P7 orphan-debris sweeping, durable bulk
  operations, migration, backup/restore, and restore epochs are deferred beyond v0.6.0.

## Release gates

Run:
```bash
npm ci
npm run typecheck
npm test
npm run build
```
plus the compiled recovery, runtime, rotation, and garbage-collection probes
(`--simulate-directory-barriers` on Windows), frozen fixture digest gates,
public-surface and declaration gates, the destructive-collector containment audit over
every emitted module, and packed-consumer verification, before publishing.
