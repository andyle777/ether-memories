# Round 11: T5 Windows recoverable-mode spike

Throwaway feasibility branch: `spike/v0.7.0-t5-windows-round11`, draft PR #24.
Base: released v0.6.0 `493c7b69813e71af749e34bbf950803eb8ee589b`.
No merge or release is authorized by this spike.

## Question and minimal seam

Can native Windows support a process-recoverable runtime without weakening the
v0.6 strict acknowledgment or activation contract?

`openDurableEtherMemories({ userId, directory, durabilityGuarantee: "recoverable" })`
explicitly selects the weaker backend on Windows. Omission means strict. On
Linux/macOS, the strict backend exceeds a recoverable request. Selection and the
backend operations are captured once before runtime IO; writes, recovery,
rotation and maintenance reuse that capability. There is no per-call fallback.

Regular files still require sync. Windows directory operations validate entries
but do **not** flush directory metadata. Windows replacement rename returns
`"process-recoverable"`, never `"atomic"`. Internal weak commit and HEAD results
have `acknowledgment: "process-recoverable"` and **no** `durability` property.
The existing strict `CommitReceipt` and `HeadActivationReceipt` keep their exact
`durability: "confirmed"` / `activation: "atomic"` types. Failure diagnostics
never mark a weak operation's durability confirmed.

Historical receipt reconciliation describes this invocation's capability. Ledger
v1 proves identity/effects and cannot reconstruct a prior writer's durability
profile. No capability or acknowledgment is added to persisted bytes.

## Scope and exclusions

The empirical certification target is native local Windows/NTFS on Node 22 and
24. Power loss, media faults, network filesystems (including mapped network
drives), arbitrary reparse mechanisms and nonconforming external writers are
outside the claim. Filesystem type is not detected: a drive-letter path alone
does not establish NTFS or local storage. UNC/device namespaces, ADS syntax,
DOS device names, trailing-dot/space components, and U+10FFFF paths are refused
before native IO. Ordinary Unicode and spaces are exercised. Junction ancestors
and hardlinked authority files fail closed; Windows bounded reads compare exact
bigint file identity and nanosecond stamps.

Single-writer authority, stable mutation identity, exact-base checks, complete
post-state validation, corruption handling and explicit recovery remain in use.
Production never automatically breaks a stale `writer.lock`.

Schema v0.3, WAL v1, checkpoint format and receipt ledger v1 are unchanged. No
T1-T4 work, WAL v2, migrations, receipt v2, background service or persisted
durability history is introduced. Package/release version remains 0.6.0.

## Evidence and decision gate

- `tests/windows-recoverable.test.ts`: actual production open/write/rotation,
  historical retry, GC/maintenance/reopen; separate weak internal results;
  strict Windows refusal; once-selected capability; regular-file sync failure;
  path, junction and hardlink refusals.
- `scripts/round11-windows-native-probe.mjs`: native primitives and aliases;
  Node's U+10FFFF edge runs in a child so a native abort cannot kill the harness.
- `scripts/round11-windows-crash-probe.mjs`: production backend with syscall
  hooks only for synchronization. Terminates children during partial WAL write,
  after complete WAL write, after that write's file sync, after public ACK, and
  immediately before/after rotation HEAD replacement. Reopens through the
  public factory and retries each stable identity exactly once. A known exited
  child's stale lock is removed by the test harness only, after asserting refusal.
- Normal CI runs the complete regressions, typecheck, build, package and packed
  consumer on Windows/Linux, Node 22/24. Dedicated native Windows jobs run the
  capability tests and both probes on Node 22/24 and preserve JSON reports.

T5 may be GREEN only when both native Node versions and the complete CI matrix
pass on the candidate commit and independent review has no unresolved material
finding. Passing certifies only the process-failure scope above. Otherwise cut
T5 from the v0.7 roadmap; do not silently downgrade the strict contract.
