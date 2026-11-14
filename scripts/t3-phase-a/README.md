# Phase A development checkpoint: incomplete

This is local development scaffolding based on commit
`42f9b5bdf94e47c4c69c0f87127eb545dff13ed1`. It is not an executable
distinct-identity enforcement experiment. Do not publish or execute the workflow
until the implementation has been completed, reviewed, and separately authorized.
The entrypoint intentionally reports `UNVERIFIED` and exits 2 in every case.

The scripts contain actor, process-token, job-object, validation and reporting
building blocks, plus offline tests. The manager does not yet create accounts,
launch or bind alternate-credential actors, configure or inspect NTFS DACLs,
compare protected inventories, run the required access controls, or perform
account and resource cleanup. The observed local job-object test begins after
assignment and does not prove safe containment between process creation and
assignment. Tests using a single identity or test doubles are not enforcement
evidence. All account, policy, hosted-image and cross-identity behavior remains
unverified.

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

The hosted experiment cannot establish production integration, old-writer
exclusion, HEAD v2, read authorization, pending-data visibility, delayed I/O
fencing, or an independent production witness. Those remain separate T3 gates.
