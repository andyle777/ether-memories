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
| jobClosure | Correlated supervisor receipt and independently observed process outcomes; bounded ownership acceptance and failure coverage remain incomplete. | Partial |
| childTermination | Hosted supervisor observes the child; independent per-control proof is not retained. | Missing |
| alternateTimeout | Hosted supervisor tests timeout; independent per-control proof is not retained. | Missing |
| ntfsVolume | Stage 3 setup checks volume type; independent proof is not retained. | Missing |
| aclEstablishment | Stage 3 fixture ACL setup; independently checkable ACL record is not retained. | Missing |
| aclInspection | Manager reads and rechecks the fixture ACL; failure proof remains incomplete. | Partial |
| authorizedRead | Stage 3 executes actor read; file identity and independent content proof are not retained. | Missing |
| authorizedCreate | Stage 3 executes actor create; independent target/inventory proof is not retained. | Missing |
| authorizedReadback | Stage 3 checks actor readback; independent content proof is not retained. | Missing |
| unauthorizedRead | Actor report plus separate trusted read-open, positive controls, ACL and inventory; direct proof of actor request remains unresolved. | Partial |
| unauthorizedWrite | Actor report plus separate trusted write-open, positive controls, ACL and content inventory; direct proof of actor request remains unresolved. | Partial |
| unauthorizedCreate | Actor report plus separate trusted create, positive controls, ACL and inventory; direct proof of actor request remains unresolved. | Partial |
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

Earlier Stage 3 slice (superseded by the witness update below): aclInspection retains the expected and independently read ACL
for success-only rechecking. unauthorizedRead, unauthorizedWrite and
unauthorizedCreate retain actor identity, categorized result, before/after
existence and inventory, and cleanup observations. The adapter can preserve a
write or create violation when manager-observed protected inventory changes; it
does not promote denial to PASS because an independent Windows denial witness
is not yet connected. Unauthorized read remains unverified: its actor-provided
result alone does not independently establish that access occurred. ACL failure
records, independent denial corroboration, read violations, and full end-to-end
cleanup proof remain incomplete. Synthetic controls do not establish hosted
NTFS behavior.


Independent access witness (provisional): `unauthorizedRead`,
`unauthorizedWrite` and `unauthorizedCreate` use a manager-owned, separate
`CreateFileW` attempt while the dedicated native thread impersonates the
existing legacy token. The thread verifies the effective SID, captures the
Win32 result, closes its handles, reverts, and verifies the thread token is
absent. Authorized and permissive fixtures are checked for each access type;
create probes are removed and their absence checked. The manager checks the
protected ACL and before/after inventory. Write probes request write access
without writing to the original file. File sharing is enabled, and the
authorized write-open control helps detect read-only or sharing interference.

This is independent OS evidence of a separate access attempt, not proof
that the actor performed its reported request. If direct proof of the actor's
denied attempt is mandatory, an independently correlated Windows security
audit event could supply it, subject to separately authorized audit settings,
event availability and correlation design. This contract question remains
unresolved. Injected controls are SIMULATED_PASS only. Cross-identity NTFS
behavior and real impersonation are UNVERIFIED until authorized hosted runs.
Setup, context restoration, unrelated native errors and cleanup failures fail
closed. The worker join has no timeout; an indefinitely stalled filesystem
operation can block the manager and is a remaining source limitation.

Bounded read update: the manager compiles a source-pinned helper into a
manager-controlled scratch directory, prevents writes to the compiled image
while it runs, and launches it suspended with the existing atomic Job Object
launcher. Before resuming, the manager queries its process token SID, PID and
creation time and confirms membership. The one-shot pipe grants the expected
identity access, denies NETWORK, and the manager checks the operating-system
pipe-client PID against the held child. The receipt binds nonce, PID, creation
time, SID, operation, target identifier and native result. Connection, read and
exit are deadline-bound; job closure and child wait precede cleanup. A child
whose termination is unconfirmed keeps the dependent resources and prevents
account cleanup claims. The helper requests native read access, not proof of the
original actor request. Same-identity processes may still interfere with the
helper or deny service; this is not cryptographic authentication of an
otherwise compromised same-identity process. Cross-identity execution remains
unverified. At that checkpoint WRITE and CREATE retained the earlier unbounded thread path; see the migration update below.

The process-backed helper now covers Read, Overwrite (WRITE_ACCESS without
writing) and Create (CREATE_NEW). The same pinned source, atomic launcher,
pipe-client PID binding, nonce, deadline and confirmed cleanup apply to each.
Create targets are fixed names under a fresh random fixture root; successful
creates are inventoried and cleaned by the existing fixture cleanup. Live
Stage 3 has no route to the legacy impersonating thread helper. That source is
loaded only for the offline legacy regression. Results remain separate from the
actor report, and an access-open is not proof of an overwrite. Hosted
cross-identity enforcement remains unverified.
