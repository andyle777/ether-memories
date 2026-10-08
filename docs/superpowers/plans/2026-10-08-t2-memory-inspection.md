# T2 implementation plan

Parent: frozen T1 `438a038f1aafbd636777f0dd7fb2c8eec3597e45`.
The supplied T2 master handoff is the approved scope and design contract.

1. Add failing tests for factual note explanations, deterministic time, direct graph bounds, detached reports, and logical health coverage.
2. Introduce type-only public report contracts, an internal trusted-state bridge, bounded plain-data projection, and pure analysis. Wire exactly two Core methods.
3. Wire the same analysis through the durable committed-generation read boundary, with closed/recovery errors taking precedence. Extend facade containment gates by exactly two approved methods.
4. Test durable parity, no I/O or byte changes, recovery precedence, work ceilings, metadata independence, and all boundary values.
5. Document fixed caps and evidence semantics; extend the installed-tarball consumer gate and declaration exclusions.
6. Verify unchanged persistence blobs and all inherited tests. Commit a candidate; rerun clean exact-SHA install/typecheck/tests/build/pack/consumer gates; publish a stacked draft PR against T1 and collect all four CI jobs.
7. Request independent hostile review of that exact SHA, fix material findings within T2 and repeat affected verification. Freeze only on GREEN; stop before T3.

Bounded inspection uses at most 4096 note identifiers, 256 health notes, 4096 direct edges, 32 returned edges, and 256 scanned/32 returned tags. Scalar limits and aggregate byte/output caps are explicit. Populations above the deterministic selection ceiling return partial coverage with zero inspected notes rather than an insertion-order sample. No arbitrary metadata, bodies, adjacent labels, or persistence objects enter the snapshot.
