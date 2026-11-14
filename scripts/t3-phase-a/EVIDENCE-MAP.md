# Provisional Phase A evidence bridge

The table describes source connections, not executed Windows enforcement. The
manager checks the journal against independently obtained process/token
observations. Expected role, operation, SID, PID, creation time, nonce, job
membership and termination are rechecked as applicable. A missing, mismatched,
incomplete or simulated journal cannot establish live evidence. All controls
also depend on independently confirmed process, fixture and account cleanup and
on trusted run provenance and owner authorization for a final verdict.

| Policy control | Existing producer and independent corroboration / gap | Bridge |
| --- | --- | --- |
| identityDistinct | Stage 2 actor journal; rechecks distinct account and observed token SIDs. | Connected |
| brokerNonAdmin | Stage 2 process-token observation; rechecks broker SID and non-admin observation. | Connected |
| legacyNonAdmin | Stage 2 process-token observation; rechecks legacy SID and non-admin observation. | Connected |
| brokerPrimaryToken | Stage 1 authentication and a second open-handle inspection are bound to the broker actor observation and checked handle closure; failure proof remains incomplete. | Partial |
| legacyPrimaryToken | Stage 1 authentication and a second open-handle inspection are bound to the legacy actor observation and checked handle closure; failure proof remains incomplete. | Partial |
| brokerActorBinding | Stage 2 journal rechecks broker account, token and actor observations. | Connected |
| legacyActorBinding | Stage 2 journal rechecks legacy account, token and actor observations. | Connected |
| actorPidBinding | Stage 2 journal compares launcher and independently observed actor PID. | Connected |
| actorCreationTimeBinding | Stage 2 journal compares launcher and observed process creation time. | Connected |
| actorSidBinding | Stage 2 journal compares account, process-token and actor SIDs. | Connected |
| jobContainment | The manager duplicates the supervisor-owned reported job with query access, independently inspects child membership and excludes a job containing the supervisor, checks limits and releases the duplicate. Success records are rechecked by the verdict adapter; verified failure mapping is incomplete. | Partial |
| supervisorTermination | Hosted supervisor tests termination; independent per-control proof is not retained. | Missing |
| jobClosure | Hosted supervisor tests closure; independent per-control proof is not retained. | Missing |
| childTermination | Hosted supervisor observes the child; independent per-control proof is not retained. | Missing |
| alternateTimeout | Hosted supervisor tests timeout; independent per-control proof is not retained. | Missing |
| ntfsVolume | Stage 3 setup checks volume type; independent proof is not retained. | Missing |
| aclEstablishment | Stage 3 fixture ACL setup; independently checkable ACL record is not retained. | Missing |
| aclInspection | Stage 3 inspects the fixture ACL; independently checkable inspection is not retained. | Missing |
| authorizedRead | Stage 3 executes actor read; file identity and independent content proof are not retained. | Missing |
| authorizedCreate | Stage 3 executes actor create; independent target/inventory proof is not retained. | Missing |
| authorizedReadback | Stage 3 checks actor readback; independent content proof is not retained. | Missing |
| unauthorizedRead | Stage 3 checks denial; native error classification and independent target proof are not retained. | Missing |
| unauthorizedWrite | Stage 3 checks denial; native error classification and independent target proof are not retained. | Missing |
| unauthorizedCreate | Stage 3 checks denial and target; native error and independent inventory proof are not retained. | Missing |
| protectedInventory | Stage 3 compares inventory; independently checkable before/after records are not retained. | Missing |
| insecureAclControl | Stage 3 checks an intentionally permissive fixture; independent ACL and operation proofs are not retained. | Missing |
| processCleanup | Launcher and supervisor close jobs and handles; complete independent cleanup proof is not retained. | Missing |
| fixtureCleanup | Stage 3 removes fixture; independent absence proof is not retained. | Missing |
| accountCleanup | Stage 1 closes tokens and removes accounts; independent per-account absence proof is not retained. | Missing |
| experimentComplete | Stage manager aggregates outcomes; stage completion is not proof of individual observations. | Missing |

An observed security violation must have a verified per-control record and
confirmed cleanup before RED can be produced. Current failure aggregation does
not preserve sufficient independent violation evidence, so it stays UNVERIFIED.
No missing control is inferred from a stage completion result.

Primary-token PASS records are produced only after the second inspection, actor identity binding and successful token-handle close. The second inspection re-queries the same handle using GetTokenInformation and WindowsIdentity; it is corroboration by a separate OS query, not a separate security authority. Failed or incomplete inspections do not yet produce independently verifiable failure records. Supervisor and process cleanup records remain unconnected.

The hosted supervisor now retains bounded in-memory process-lifetime observations, including OS-observed child identity and creation time, outer-job membership and limits, child wait, outer handle count and cleanup. The outer job is not the supervisor-owned inner job used by the job-closure experiment. A sampled handle count is not proof of the last relevant handle at closure. No process-lifetime verdict controls are promoted by this partial record; inner-job ownership, last-handle closure, failure preservation and verifier integration remain missing. NtQueryObject can change or be unavailable; query failure remains unverified.

Inner-job protocol: the supervisor creates the unnamed non-inheritable job and supplies its process-local handle in its private readiness record. While the supervisor is alive, the manager duplicates that handle with JOB_OBJECT_QUERY, checks the child and supervisor membership and job limits, then closes its duplicate before the trigger. The originating handle value comes from supervisor-controlled data; the checks reject an outer job containing the supervisor but do not prove a globally unique object identity. The protocol does not prove global last-handle closure. jobContainment has a success-only verdict adapter; jobClosure stays NOT_RUN. Failed inspections are retained in the in-memory supervisor observation but are not yet mapped as independently verified failure verdicts.

The provisional adapter now retains verified membership and limit failures and a bounded commanded-closure sequence with separate wait, exit and cleanup observations. A survivor remains a failure even if later cleanup is unconfirmed; incomplete authorization, provenance or cleanup still blocks a final verdict. Identity/query failures are setup failures or unverified, not invented security violations. See PROPOSED-INNER-JOB-ACCEPTANCE.md: adoption is pending, and the sequence does not establish exclusive global ownership or causation. Failure coverage and actual hosted execution remain incomplete.

The supervisor now writes a bounded receipt of its actual inner-job CloseHandle attempt. The manager correlates the receipt nonce, mode, supervisor and child PID and creation times with its independent observations before retaining it. jobClosure success requires that correlated successful receipt plus the existing independent waits and cleanup. A reported close failure is setup failure; missing or mismatched receipts remain unverified. The originating receipt is supervisor-generated and is not itself independent proof of global last-handle closure. The proposed acceptance clarification remains unadopted.
