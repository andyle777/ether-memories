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

Verdict work is incomplete. `phase-a-core-provisional-v1` is an explicit test
policy; it does not adopt or exclude the proposed delete/rename addendum. The
standalone evaluator validates a complete, typed per-control record using an
injected verifier. Its synthetic GREEN is a unit-test result only. The manager
currently constructs NOT_RUN records because the existing stages do not retain
the individual corroborated proof that the evaluator requires. Its production
verifier denies authorization and provenance until a trusted evidence adapter is
implemented. Therefore the real manager cannot yet return GREEN or RED.
Environment variables and actor claims are not workflow provenance. A future
review must establish trusted GitHub run provenance and bind the collected
observations to that run, as well as preserve independently verifiable per-case
records and cleanup outcomes. Do not enable the hosted workflow meanwhile.
