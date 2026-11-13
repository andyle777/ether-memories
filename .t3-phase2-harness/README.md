# T3 Phase 2 Windows broker-isolation harness

This is a disposable native-Windows harness. It does not import, patch, or
write to production persistence state. Test files are created below `%SystemRoot%\Temp` so both test identities can
reach the shared test area; reports go in this harness's new `evidence`
directory. A per-user temp fallback is refused because it is not an
authentic-cross-identity test area. Do not run it against a real memory store.

## What it exercises

`Invoke-Phase2.ps1` launches PowerShell actors using two distinct Windows
credentials and records their resolved SIDs. On a dedicated NTFS VM it checks:

| Probe | Passing observation |
|---|---|
| Broker-only data root | Broker token creates a file; actor SID matches the broker SID. |
| Authentic legacy exclusion | A distinct legacy token cannot create or replace that file. |
| Alternate names | Legacy writes through an extended-length path, hard link, and junction are denied. Unsupported link setup is recorded `UNVERIFIED`, not passed. |
| Existing writable handle | Legacy opens a real write handle before its ACE is removed, then writes through that handle. Success is recorded `RED`: a DACL change does not revoke already-granted handles. |
| Stale broker | A second broker cannot open an exclusively-held lock while the first broker lives. After its death, Windows releases the handle but leaves the file; raw OS locking permits a new open, recorded `RED` to emphasize that application policy must refuse stale authority. |
| Job Object cleanup | A separate supervisor assigns an idle child to a Job Object with `KILL_ON_JOB_CLOSE`; killing the supervisor must end the child. |
| Pending transaction | Runs the pending-write, admission, and session T3 regression suites and labels them same-process evidence, not a cross-identity transaction proof. |

`RED` on the existing-handle and stale-lock-policy probes is an expected
adversarial finding, not an infrastructure error. Such a result means an ACL
transition or kernel lock alone is insufficient; it does not claim that the
production broker implementation is vulnerable. The security boundary must be
provisioned before legacy processes can open state, and production stale-lock
policy must remain fail-closed. A clean overall `GREEN` is not possible if
either challenge demonstrates those expected OS behaviors.

## Reproducible VM procedure

1. Use a disposable, snapshotted Windows VM with a local NTFS volume, Windows
   PowerShell 5.1 or later, Node and the repository's installed dependencies.
   Record the VM image/build, volume, Node version, branch, and exact checkout
   state with the generated report.
2. Provision two separate **standard, non-administrator** local users using
   the VM's account-management UI. Give each a known password for this test
   only, and allow interactive/batch logon as required by local policy. Do not
   reuse production credentials. The harness prompts for credentials; it does
   not put passwords on the command line.
3. Use a throwaway checkout/copy of the exact candidate tree, including
   relevant uncommitted source and tests. Keep original ABS evidence and
   historical fixtures read-only. Do not run in a production persistence
   directory.
4. Open elevated Windows PowerShell in that checkout and confirm the system
   temp volume is local NTFS:

   ```powershell
   .\.t3-phase2-harness\Invoke-Phase2.ps1 -PreflightOnly
   .\.t3-phase2-harness\Invoke-Phase2.ps1 -BrokerUser "$env:COMPUTERNAME\ether-broker" -LegacyUser "$env:COMPUTERNAME\ether-legacy"
   ```

5. Preserve the generated `evidence\run-*` directory. `report.json` contains
   machine/token metadata, Git state, per-file SHA-256 values, and every probe
   result; `transcript.txt` and `pending-write-vitest.txt` preserve raw output.
   Review failures and unexpected `UNVERIFIED` entries before interpreting the
   run. Never treat a preflight or same-user run as ACL proof.
6. To repeat, use a fresh VM snapshot or a new run. The test data has unique
   names under the system temp directory; the runner does not remove test
   directories.

The supervisor cleanup probe can also run without elevation or test accounts:

```powershell
.\.t3-phase2-harness\Test-JobObject.ps1
```

Its isolated `evidence\job-only-*` result proves only the Windows Job Object
behavior on that host; it says nothing about broker ACL enforcement.

The harness does not create/delete Windows accounts, modify account policy,
change ACLs outside its unique temporary directories, alter production
persistence files, or clean up pre-existing evidence.

## Gate interpretation and remaining work

The current application regression test exercises a controlled pending WAL
write and verifies that a competing admission sees `WRITER_BUSY` before the
first write settles. It is not a two-process Windows I/O race or an on-disk
cross-identity visibility proof. The harness records it separately so it
cannot be mistaken for that stronger claim.

For a complete enforcement gate, add a candidate-specific broker process
integration that runs the actual persistence admission under the broker SID,
keeps a genuine WAL write outstanding, kills or partitions the broker at
defined I/O boundaries, and verifies via a separate read-only observer that a
pending transaction is absent from committed tips/receipts. The observer must
also demonstrate that legacy tokens cannot mutate the store through any
tested alias. This harness provides the OS identity, ACL, alias, stale-handle,
and supervisor primitives, but does not pretend a synthetic file is a
production transaction.

## Current run status

See [`RESULTS.md`](./RESULTS.md) for the execution environment and current
enforcement status. T3 remains **NO FREEZE / NO MERGE / NO RELEASE**.
