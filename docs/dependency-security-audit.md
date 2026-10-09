# Dependency security correction before v0.7.0 T3

Investigation date: 9 October 2026. Frozen T2 parent:
`38876a0571582f79e4ddbc2b95be70f12ede95fc`. This is a bounded tooling
correction, not a tranche. Ether Memories remains version **0.6.0**.

## Reproduction and production gate

Clean `npm ci` followed by `npm audit --json`, `npm audit --omit=dev --json`
and `npm audit --omit=dev` reproduced the same advisory set with:

| Environment | Full audit before | Full audit after | Production audit |
| --- | --- | --- | --- |
| Node 22.23.3 / npm 10.9.9 | 4 packages: 1 moderate, 1 high, 2 critical | 3 packages: 1 moderate, 2 critical | 0 findings; exit 0 |
| Node 24.21.0 / npm 11.19.0 | 4 packages: 1 moderate, 1 high, 2 critical | 3 packages: 1 moderate, 2 critical | 0 findings; exit 0 |

Full audits exit 1 because development findings remain. The original four
vulnerable-package findings represent four unique advisories and five
package/advisory pairs: the Vitest advisory affects both Vitest and its mocker.
Vitest's critical aggregate severity comes from Tinypool; its own advisory is
moderate. The findings are dependency-tree-specific, with no observed difference
between these Node/npm pairs; this comparison does not isolate Node and npm as
independent experimental variables.

The npm advisories observed during development installation are confined to
development/build/test dependencies and are not present in Ether Memories'
production dependency set. This does not establish zero risk in development or CI.

## Each original advisory

| Advisory | Affected installed packages and severity | Vulnerable range; fixed release | Exposure and disposition |
| --- | --- | --- | --- |
| [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), CVE-2026-84373 | `vitest@3.2.7` (direct dev) and `@vitest/mocker@3.2.7` (transitive dev); moderate | `>=2.1.0 <4.1.11`; fixed in 4.1.11 | Arbitrary file reads through mock redirect targets and exposed unauthenticated plugin HMR. The repository uses CLI test runs, with no browser/UI/custom mocker plugin configuration found. No production path identified. Upstream does not plan a Vitest 3 backport; defer incompatible major migration to T6. |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), CVE-2026-93749 | `source-map-js@1.2.1` (transitive dev); high | `>=1.0.0 <1.2.2`; fixed in 1.2.2 | Indexed source-map offsets can block the event loop. Used through PostCSS/Vite tooling, with no production import/input path identified. Safely patched to 1.2.2 within the existing parent range. |
| [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), CVE-2026-104848 | `tinypool@1.1.1` (transitive dev); critical | `<=2.1.0`; fixed in 2.1.1 | Inherited `execArgv`/`env` worker options after prototype pollution can enable code execution. Test-worker execution is relevant to development/CI, conditional on pollution and attacker-controlled payloads; no production path identified. 2.1.1 alone does not fix the other Tinypool advisory. Defer to T6. |
| [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), CVE-2026-104849 | `tinypool@1.1.1` (transitive dev); critical | `<2.1.2`; fixed in 2.1.2 | Inherited task `filename` after prototype pollution can load attacker-controlled workers. Relevant conditional development/CI exposure, with no production path identified. 2.1.2 fixes both Tinypool advisories but exceeds the owning Vitest range. Defer to T6. |

None of these packages is in the published runtime dependency tree. The two
direct runtime dependencies remain `graphology@0.26.0` and
`graphology-types@^0.24.8`, with their original locked production dependencies.

## Dependency paths and compatibility decision

```text
ether-memories@0.6.0
└─ vitest@3.2.7 [direct dev; root ^3.0.0]
   ├─ @vitest/mocker@3.2.7 [exact 3.2.7]
   ├─ tinypool@1.1.1 [^1.1.1 excludes fixed 2.1.2]
   ├─ vite-node@3.2.4 → vite@7.3.6 [deduplicated]
   └─ vite@7.3.6
      └─ postcss@8.5.26
         └─ source-map-js@1.2.1 → 1.2.2 [^1.2.1 accepts patch]
```

The direct owner is already at the latest compatible Vitest 3 release, 3.2.7;
an owner update dry run offered no changed package. npm's audit proposal selects
Vitest 5.0.3 and explicitly marks it as a semver-major change. No compatible
direct-tool update repairs the remaining advisories. No major upgrade, downgrade,
override or `npm audit fix --force` was implemented.

The selected repair was normal npm resolution:
`npm update source-map-js --package-lock-only --ignore-scripts`.
Only the source-map-js lock entry's version, resolved URL and integrity changed.
Unrelated libc metadata removed by npm 10 was restored from the frozen lockfile.
No package entries were added or removed; `package.json` is identical.

## Frozen scope and required closure evidence

All source, tests, scripts, CI, runtime dependencies, exports and persistence
formats remain byte-identical to T2 in Git. This preserves
`ether.memory_store.v0.3`, WAL v1, receipt ledger v1, HEAD v1, checkpoint v1,
MemoryContext v1 and Portable Record v1, including all five frozen fixtures.

Closure requires clean audits on the exact final commit under both environments,
all 32 files / 743 inherited tests without deletion or skips, typecheck, build,
pack and packed-consumer verification, and all four existing Ubuntu/Windows ×
Node 22/24 CI jobs. The accompanying candidate-specific evidence report records
the exact SHA, PR, CI run/job IDs and raw audit results.

The intended permitted outcome is **GREEN — classified, no production exposure**,
not fully repaired. T6 must review a compatible migration strategy for the Vitest
and Tinypool advisories and rerun security and consumer verification. Remaining
critical development advisories are acknowledged, not waived or declared harmless.
No T3 implementation, T7, persistence changes or v0.7.0 release bump is included.
