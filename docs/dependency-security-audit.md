# T2 security remediation and re-freeze gates

The owner reopened T2 on 9 October 2026 to repair the supported development/CI
baseline. The earlier dev-only/T6 deferral is superseded. This remains T2
stabilization; no T3, T5 integration, T7 or version bump is included.

## Historical lineage and current gate

- Release v0.6.0: 493c7b69813e71af749e34bbf950803eb8ee589b.
- T1: 438a038f1aafbd636777f0dd7fb2c8eec3597e45.
- Original T2: 38876a0571582f79e4ddbc2b95be70f12ede95fc — original functional
  freeze candidate, superseded by security remediation; history is retained.
- Security intermediate: 3eccdb6ca60dbfd49eba4a2bad8ac19b7c4a02c7, PR #27.

Only a candidate-specific re-freeze report proving every gate below can designate
the new authoritative T2 SHA. Production-clean alone is insufficient.

## Selected supported owner migration

Vitest is pinned to **4.1.11**, the smallest fixed stable line identified by
[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
All seven @vitest packages move from 3.2.7 to 4.1.11, including mocker.
Tinypool1.1.1 and vite-node3.2.4 are removed by the owner's normal dependency
resolution. The two critical Tinypool advisories,
[GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and
[GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), are
resolved by eliminating that dependency path, not by forcing a single partial
patch. No Tinypool copy remains in the selected lockfile.

The prior source-map-js1.2.2 patch for
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) is retained.
Vite7.3.6 becomes an explicit exact dev dependency to preserve the existing
compatible Vite baseline. Vitest4.1.11 accepts Vite6/7/8 in both its dependency
and peer range. The initial default installation selected Vite8/Rolldown and
much broader changes; that disposable experiment was not selected. Normal npm
resolution from the intermediate with exact Vitest4.1.11/Vite7.3.6 preserves
Vite7, esbuild, Rollup, PostCSS, TypeScript5.9.3 and @types/node22.20.1.

Command used: npm install --save-dev --save-exact --prefer-dedupe
vitest@4.1.11 vite@7.3.6. All changed lock entries are owning Vitest packages,
their legitimately changed dependencies, or removed dependencies no longer used
by the owner. No override, force, downgrade from the canonical baseline,
ignored advisory or arbitrary graph edit was used. The production dependency
tree and package/library version0.6.0 are unchanged.

## Compatibility review

The [Vitest4 migration guide](https://v4.vitest.dev/guide/migration) documents
the pool rewrite removing Tinypool and changes to mock restoration. Ether uses
manual vi.spyOn/vi.fn with per-test cleanup; no automocked modules, constructor
mocks, fake timers, custom pools, globals, snapshot serializers, test concurrency
or deprecated pool configuration are present. Existing hooks, ESM imports,
numeric/suite timeouts and TypeScript assertions are retained.

Spies are created inside tests and restored before the next test, so tests do not
depend on restoreAllMocks clearing retained call history. Assertions check the
current test's local spies before restoration. One existing test-only never cast
is changed to a callable-record cast for the new spyOn overload; its TypeScript-
erased JavaScript and all assertions are unchanged. No runtime or timeout edit
is required. Full suites on both Node pairs, a seeded
shuffle run and four OS/Node CI jobs provide independent ordering/scheduling
coverage. Results and exact versions belong in the candidate-specific report.

## Deterministic security and worker gates

npm run verify:toolchain is offline. It scans every lock entry, including nested
copies and named aliases, and rejects stable versions below Vitest/mocker4.1.11,
Tinypool2.1.2 and source-map-js1.2.2. Targeted malformed/prerelease versions fail
closed, and required Vitest/mocker entries must exist. This checks the known
advisory baseline; it cannot discover future advisories. Fresh full and
production npm audits on both Node pairs remain mandatory release/freeze gates.
No unstable advisory-network dependency is added to CI.

npm run verify:workers runs after npm test in an isolated checkout and detects
remaining checkout-scoped Node processes on Windows or Linux. It observes
processes and fails on leaks; it neither kills workers nor suppresses warnings.
Windows matches normalized process command paths; Linux checks Node process
working directories. Process-exit checks complement clean test exits and raw
warning/hang/timeout inspection. Use a dedicated checkout without simultaneous
Node commands in that same checkout for this gate.

Both new gates are added to every existing CI job. Checkout, setup, install,
typecheck, all743 inherited tests, build, pack and packed consumer remain intact.
Negative controls prove rejection of the real vulnerable intermediate, nested
vulnerable copies, incomplete Tinypool patches, and invalid versions; positive
controls cover fixed boundaries and Tinypool's legitimate absence. A live Node
child control proves the worker check fails while it runs and passes after exit.

## Required re-freeze evidence

The exact final SHA must pass clean Node22 and Node24 full/prod audits at zero,
all32files/743 inherited tests without deletion/skips/todos, typecheck, build,
pack and packed consumer; default and shuffled scheduling must remain clean.
All four Ubuntu/Windows × Node22/24 CI jobs must pass, with no FileHandle cleanup
warning, worker leak, hang or timeout regression. A fresh hostile review must
have no unresolved material finding.

All runtime sources/tests, T2 functional contracts, exports, schemas, writer
authority and durable behavior remain unchanged. Store v0.3, WAL/receipt/HEAD/
checkpoint v1, MemoryContext v1, Portable Record v1 and all five fixture hashes
must match the historical gates. Compiled runtime/declaration bytes must match
original T2. package.json's dev pins and verification scripts are the expected
published metadata changes; runtime dependencies and exports must not change.

Do not merge automatically. After successful re-freeze, only the new reported
T2 SHA is a valid parent for T3; do not start T3 as part of this task.
