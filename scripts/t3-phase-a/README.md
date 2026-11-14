# Phase A development checkpoint: incomplete

This is local development scaffolding based on commit
`42f9b5bdf94e47c4c69c0f87127eb545dff13ed1`. It contains an experimental distinct-identity enforcement path, but the
complete acceptance experiment is not implemented. Do not publish or execute the workflow
until the implementation has been completed, reviewed, and separately authorized.
The entrypoint intentionally reports `UNVERIFIED` and exits 2 in every case.
After validating hosted invocation fields, it now rejects a checkout whose
HEAD, baseline ancestry, tracked state, or reviewed source hashes do not match.
These are preflight checks only; a passing preflight is not Phase A evidence.

The scripts contain actor, process-token, job-object, validation and reporting
building blocks, plus offline tests. After preflight, the manager can explicitly
opt into the Stage 1 account lifecycle with `-EnableAccountStage`; the workflow
does not enable it. This switch is an operational guard, not machine attestation.
The account lifecycle is untested with real accounts. A separate
`-EnableActorStage` switch additionally enables the Stage 2 launch callback;
it requires `-EnableAccountStage`, and neither switch appears in the workflow.
The alternate-token launch and its private actor scratch-directory access have
not been executed with real accounts. A further `-EnableFilesystemStage` switch
requires both earlier switches and connects a protected NTFS fixture, access
operations, inventory comparison, and an intentionally permissive control.
The workflow does not enable these switches. Actual ACL and cross-identity
behavior has not been executed. Adversarial controls and supervisor-failure
evidence are not cross-identity PASS; the manager cannot report GREEN. The observed local job-object test begins after
assignment and does not prove safe containment between process creation and
assignment. A separate same-identity probe uses CreateProcessAsUserW with a
primary token, STARTUPINFOEX, a job-list attribute and suspended start; local
tests verify job membership before resume and child termination on supervisor
death. The manager reuses that launcher; alternate-token behavior,
privileges and hosted nested-job support remain unverified. The probe passes a
minimal explicit environment; it is not ready for hosted execution. Tests
using a single identity or test doubles are not enforcement
evidence. All account, policy, hosted-image and cross-identity behavior remains
unverified.

The lifecycle closes acquired token handles and removes owned accounts in reverse
order during normal completion and handled failures. A process crash, forced
termination, stuck system call or VM loss can bypass cleanup. Only a separately
authorized disposable hosted runner may execute the live account path.

The actor handshake now records its process creation time, and the observation
evaluator requires it to match a separately supplied observation. The local
test compares the handshake with the Windows process object while the child is
alive. The inventory helper hashes names, types, sizes, content and owner,
group and DACL descriptors, and rejects reparse points. It has only been tested
on a same-user disposable tree; it does not establish a race-free traversal or
an adequate protected DACL. It is wired to the guarded Stage 3 path. Cleanup
checks for reparse points and deletes known paths non-recursively, but is not
proven race-free against a concurrent filesystem adversary. Delete and rename
requirements have not been established against the frozen acceptance matrix.

The experimental workflow listens only for a push to
`test/t3-windows-enforcement-run`. A future push to that branch would also
trigger the existing four-job CI workflow, for five jobs in total. A push to
`test/t3-windows-enforcement` would trigger the four CI jobs but not Phase A.
Neither action is authorized by this local development checkpoint.

Run the offline checks from the repository root:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/t3-phase-a/PhaseA.Tests.ps1
powershell.exe -NoProfile -NonInteractive -File scripts/t3-phase-a/PhaseA.Actor.Tests.ps1
powershell.exe -NoProfile -NonInteractive -File scripts/t3-phase-a/PhaseA.Job.Tests.ps1
powershell.exe -NoProfile -NonInteractive -File scripts/t3-phase-a/PhaseA.Supervisor.Tests.ps1
powershell.exe -NoProfile -NonInteractive -File scripts/t3-phase-a/PhaseA.Entry.Tests.ps1
```

Stage 2 uses temporary per-actor scratch directories for handshake files. Their
ACLs are process plumbing, not protected-store enforcement evidence. If the
manager cannot confirm child termination, it avoids explicitly closing the
account tokens or removing the accounts and reports a cleanup failure. Forced
termination may still close process handles and leave accounts behind on the
disposable VM. Stage 2 never makes the overall Phase A status GREEN.

The hosted experiment cannot establish production integration, old-writer
exclusion, HEAD v2, read authorization, pending-data visibility, delayed I/O
fencing, or an independent production witness. Those remain separate T3 gates.

The manager runs eleven synthetic observation-substitution checks after checkout
validation. Their result is labeled `SIMULATED_PASS`; it is not cross-identity
NTFS enforcement evidence. A failed or missing synthetic check prevents the
live account path. An explicit `-EnableSupervisorProbe` runs existing same-identity
job and supervisor probes and labels their result `SAME_IDENTITY_PASS`; simulated
timeout, cleanup failure and unconfirmed-child controls are separately labeled.
Neither proves alternate-identity failure behavior. The guarded live account
callback now also runs separate supervisor-death, job-closure and timeout
controls using the alternate token. Each control records an allowlisted status
and reason, with evidence labeled LIVE rather than attested hosted evidence.
This path has not been executed with alternate identities. It retains the outer
job while independently checking the child SID, process and parent IDs, creation
time, job membership and exit. Unconfirmed children prevent account cleanup.
Delete and rename remain
contract-unresolved; their proposed additional cases are separate from the
unrecovered frozen matrix and await owner acceptance.

A future separately approved hosted invocation would need the existing
`-EnableAccountStage`, `-EnableActorStage`, `-EnableFilesystemStage`, and
`-EnableSupervisorProbe` switches.
Do not add these switches to the workflow until the exact source and workflow
change have been independently reviewed and separately authorized. The proposed
delete and rename addendum remains pending owner acceptance. Current
workflow behavior remains fail-closed.

Verdict work is incomplete. `phase-a-core-provisional-v1` is a provisional
30-control policy and does not adopt the proposed delete/rename addendum.
The manager retains actor observations and independently rechecks eight identity
controls. Two primary-token controls now have a partial success-only bridge with a second open-handle query and checked closure. The remaining 20 controls have no independently checkable proof;
see EVIDENCE-MAP.md. The production authorization decision remains false, so the
real manager cannot currently return GREEN or RED. Synthetic evaluator outcomes
are unit-test results, not Windows enforcement evidence.

A GitHub OIDC verifier checks a signed token against the official issuer keys and
binds its audience to the evidence-record digest and run attempt. It does not
prove observation correctness, owner authorization, machine attestation, or
provide a separately verifiable attestation in the report. Raw bearer tokens
are not saved or logged. This path and the runner endpoint remain untested on a
hosted run. The current workflow remains unchanged, lacks the required proposed
`id-token: write` permission and does not enable the live stage switches. Any
workflow activation and privileged hosted execution require separate approval.
Primary-token failure records, supervisor and process-cleanup evidence remain incomplete; do not interpret success-only token records as completion of the evidence group. OIDC evidence is reserialized and compared with the requested audience after signature validation. No live run has tested that path.

The hosted supervision backend retains a bounded in-memory outer-job/process observation for later integration. It does not prove last-handle closure of the supervisor-owned inner job and supplies no process-lifetime verdict PASS. Same-identity job tests query the limit flags and a momentary handle count, including a deliberate duplicate-handle negative control. These tests are not cross-identity evidence.

The manager can duplicate the supervisor-reported inner job for query-only inspection and releases the duplicate before triggering supervision. The child must be a member and the supervisor must not; limit and process identity checks are also required. This establishes a bounded observation of the reported object, not global last-handle closure or an independently authenticated originating handle. jobContainment has a success-only adapter; failure mapping and jobClosure remain incomplete. Same-identity tests are not hosted cross-identity evidence.
