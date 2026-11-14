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
| jobContainment | Stage 2 and hosted supervisor check job membership; per-control raw evidence is not retained. | Missing |
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
