$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Core.ps1"
$script:passed = 0
function Check([bool]$value, [string]$name) { if (-not $value) { throw "FAIL: $name" }; $script:passed++ }
$good = @{
  role="broker"; expectedSid="S-1-5-21-1"; observedSid="S-1-5-21-1"; reportedSid="S-1-5-21-1"
  expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true
  createdAt="2026-01-01T00:00:00Z"; observedCreatedAt="2026-01-01T00:00:00Z"; reportedNonce="fresh"; expectedNonce="fresh"; exitCode=0; outcome="allowed"
}
Check (Test-ActorObservation $good "broker" "allowed") "valid independent token identity"
foreach ($case in @(
  @{key="observedSid";value="S-1-5-21-2"},
  @{key="reportedSid";value="S-1-5-21-2"},
  @{key="reportedPid";value=124},
  @{key="tokenNonAdmin";value=$false},
  @{key="tokenObserved";value=$false},
  @{key="reportedNonce";value="spoofed"},
  @{key="exitCode";value=1},
  @{key="outcome";value="denied"},
  @{key="createdAt";value=""},
  @{key="observedCreatedAt";value="2026-01-01T00:00:01Z"},
  @{key="observedCreatedAt";value="not-a-time"}
)) {
  $x = $good.Clone(); $x[$case.key] = $case.value
  Check (-not (Test-ActorObservation $x "broker" "allowed")) ("reject invalid " + $case.key)
}
$x = $good.Clone(); $x.expectedPid = 'not-a-pid'
Check (-not (Test-ActorObservation $x "broker" "allowed")) "reject malformed PID without throwing"
Check (-not (Test-ActorObservation @{} "broker" "allowed")) "reject missing observation"
Check (-not (Test-DistinctActorSids "S-1-5-21-1" "S-1-5-21-1")) "reject same SID"
Check (Test-DistinctActorSids "S-1-5-21-1" "S-1-5-21-2") "accept distinct SID"
$cases = @{
 brokerCreate=$true; brokerRead=$true; legacyControl=$true; legacyCreateDenied=$true
 legacyWriteDenied=$true; legacyReadDenied=$true; protectedUnchanged=$true; insecureRejected=$true
 sameSidRejected=$true; wrongPidRejected=$true; spoofRejected=$true; missingRejected=$true
 timeoutRejected=$true; childTerminated=$true; cleanupComplete=$true
}
Check (Test-RequiredCases $cases) "complete set passes"
foreach ($key in @($cases.Keys)) {
 $x=$cases.Clone(); $x.Remove($key)
 Check (-not (Test-RequiredCases $x)) ("missing case " + $key)
 $x=$cases.Clone(); $x[$key]=$false
 Check (-not (Test-RequiredCases $x)) ("false case " + $key)
}
$x=$cases.Clone(); $x['extra']=$true
Check (-not (Test-RequiredCases $x)) "unexpected case rejected"
Check ((Get-PhaseAExitCode 'GREEN') -eq 0) "green exit"
Check ((Get-PhaseAExitCode 'RED') -eq 1) "red exit"
Check ((Get-PhaseAExitCode 'UNVERIFIED') -eq 2) "unverified exit"
Check ((Get-PhaseAExitCode 'PREFLIGHT_READY') -eq 2) "preflight is not green"
$report=@{schema="ether.t3.phase-a.v1";status="GREEN";source="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1";cases=$cases;cleanup="complete"}
Check (Test-SanitizedReport $report) "report allowlist passes"
$x=$report.Clone();$x['password']="bad"
Check (-not (Test-SanitizedReport $x)) "secret extra property rejected"
$x=$report.Clone();$x['cases']=@{}
Check (-not (Test-SanitizedReport $x)) "missing report cases rejected"
$x=$report.Clone();$x['cleanup']="unknown"
Check (-not (Test-SanitizedReport $x)) "cleanup failure rejected"
$script:killed = 0
$fake = New-Object psobject
$fake | Add-Member ScriptMethod WaitForExit { param($ms) return $false }
$fake | Add-Member ScriptMethod Kill { $script:killed++ }
$timed = Wait-PhaseAProcess $fake 1
Check (-not $timed.completed -and $timed.timeout -and $script:killed -eq 1) "timeout kills child and fails closed"
$bad = New-Object psobject
$bad | Add-Member ScriptMethod WaitForExit { param($ms) return $false }
$bad | Add-Member ScriptMethod Kill { throw "mock kill failure" }
$timed = Wait-PhaseAProcess $bad 1
Check (-not $timed.completed -and -not $timed.terminated) "kill failure does not pass"
Write-Output "PASS timeout controls"
$nativePath = Join-Path $PSScriptRoot "PhaseA.Native.ps1"
. $nativePath
$observed = Get-PhaseAProcessToken ([Diagnostics.Process]::GetCurrentProcess())
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Check ($observed.sid -ceq $current -and $observed.pid -eq $PID) "native token query matches current process"
Write-Output "PASS native token self-observation"
$proof = @{
 schema="ether.t3.phase-a.v2"; status="GREEN"; source="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1"
 commit="0123456789abcdef0123456789abcdef01234567"; filesystem="NTFS"; cases=$cases; cleanup="complete"
 brokerTag=("a"*64); legacyTag=("b"*64)
}
Check (Test-PhaseAReport $proof) "complete sanitized schema"
$x=$proof.Clone(); $x['machineName']="private"
Check (-not (Test-PhaseAReport $x)) "report rejects unexpected machine identity"
$x=$proof.Clone(); $x['legacyTag']=$x['brokerTag']
Check (-not (Test-PhaseAReport $x)) "report rejects same identity pseudonym"
$x=$proof.Clone(); $x['cases']=@{}
Check (-not (Test-PhaseAReport $x)) "report rejects missing security cases"
Write-Output "PASS report schema controls"
$config=@{
 repository="andyle777/Ether-Memories"; event="push"; ref="refs/heads/test/t3-windows-enforcement-run"
 runner="github-hosted"; sha="0123456789abcdef0123456789abcdef01234567"
 base="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1"
}
Check (Test-PhaseAConfig $config) "valid hosted configuration"
foreach ($case in @(
 @{key="repository";value="elsewhere/repo"}, @{key="event";value="workflow_dispatch"},
 @{key="ref";value="refs/heads/main"}, @{key="runner";value="self-hosted"},
 @{key="sha";value="not-a-sha"}, @{key="base";value="deadbeef"}
)) {
 $x=$config.Clone();$x[$case.key]=$case.value
 Check (-not (Test-PhaseAConfig $x)) ("reject config " + $case.key)
}
Check (-not (Test-PhaseAConfig @{})) "reject missing configuration"
Write-Output "PASS configuration controls"
$pins = @{
 ".t3-phase2-harness/Actor.ps1"="197e2198739c7b5267c7523af746757b74f78f9ba64ba2964941c73d8a02e7a1"
 ".t3-phase2-harness/Invoke-Phase2.ps1"="b7468536670a17d5a42c4eef0ea67bee54f632cba644941ad2e7b1e518cd5bf3"
 ".t3-phase2-harness/JobSupervisor.ps1"="1e975c73e04f04ef819cb4c11252932bfbb9a77367e5e7475d79919e33a98c07"
 ".t3-phase2-harness/Test-JobObject.ps1"="a4fa0aca1b4e9e5115024cc2ba3fe5f7a8a00375ccd688067e3caf2b94017e31"
 ".t3-phase2-harness/README.md"="125bf675e3d2d21f96ac10f5da597369537036f0edf77a3aeb7533759c1744a0"
 "src/persistence/productionOperations.ts"="51afc2951d2997892bd938d63bb77add0a55297b1e86c2cef2be17401dc1129f"
}
Check (Test-PhaseAPins $pins) "all pinned sources pass"
$x=$pins.Clone();$x["src/persistence/productionOperations.ts"]="0"*64
Check (-not (Test-PhaseAPins $x)) "mismatched source pin rejected"
$x=$pins.Clone();$x.Remove(".t3-phase2-harness/Actor.ps1")
Check (-not (Test-PhaseAPins $x)) "missing pinned source rejected"
Write-Output "PASS source-pin controls"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Check (-not (Test-PhaseACheckout $repo 'not-a-sha' $config.base)) 'malformed checkout SHA rejected'
Check (-not (Test-PhaseACheckout $repo ('0'*40) $config.base)) 'mismatched checkout SHA rejected'
Write-Output 'PASS checkout controls'
Write-Output "PASS: $script:passed assertions total"
. "$PSScriptRoot/PhaseA.Verdict.ps1"
$policy=Get-PhaseAVerdictPolicy
$entries=@{}; foreach ($k in $policy) { $entries[$k]=@{state='PASS';evidence='LIVE_OBSERVED';reason='NONE';proof=('a'*64)} }
$inputRecord=@{schema='ether.t3.phase-a.verdict-input.v1';policy='phase-a-core-provisional-v1';commit=('1'*40);runId='123';cases=$entries}
$verify={param($kind,$record,$context) return $true}
$v=Get-PhaseAVerdict $inputRecord $verify
if ($v.status -cne 'GREEN') { throw 'Complete verified synthetic evidence did not compute GREEN' }
Write-Output 'PASS synthetic verdict positive control'
function Copy-VerdictInput($source) {
  $r=$source.Clone(); $r.cases=@{}; foreach ($key in $source.cases.Keys) { $r.cases[$key]=$source.cases[$key].Clone() }; return $r
}
$checks=0
foreach ($key in @('actorPidBinding','actorSidBinding','actorCreationTimeBinding','supervisorTermination','alternateTimeout')) {
  $x=Copy-VerdictInput $inputRecord; $x.cases[$key]=@{state='NOT_RUN';evidence='NOT_RUN';reason='NOT_RUN';proof=''}
  if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw "Missing $key accepted" }; $checks++
}
foreach ($evidence in @('SIMULATED_PASS','SAME_IDENTITY_PASS')) {
  $x=Copy-VerdictInput $inputRecord; $x.cases.unauthorizedRead.evidence=$evidence
  if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Non-live evidence accepted' }; $checks++
}
foreach ($key in @('unauthorizedRead','unauthorizedWrite','insecureAclControl')) {
  $x=Copy-VerdictInput $inputRecord; $x.cases[$key].state='FAIL'; $x.cases[$key].reason='VIOLATION'
  if ((Get-PhaseAVerdict $x $verify).status -cne 'RED') { throw "Verified $key violation not red" }; $checks++
}
foreach ($key in @('processCleanup','fixtureCleanup','accountCleanup')) {
  $x=Copy-VerdictInput $inputRecord; $x.cases[$key].state='FAIL'; $x.cases[$key].reason='CLEANUP_UNCONFIRMED'
  if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw "Incomplete $key accepted" }; $checks++
}
$x=Copy-VerdictInput $inputRecord; $x.cases.unauthorizedRead.state='FAIL'; $x.cases.unauthorizedRead.reason='VIOLATION'; $x.cases.accountCleanup.state='FAIL'; $x.cases.accountCleanup.reason='CLEANUP_UNCONFIRMED'
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Cleanup failure did not override red' }; $checks++
$x=Copy-VerdictInput $inputRecord; $x.cases.Remove('actorPidBinding')
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Missing field accepted' }; $checks++
$x=Copy-VerdictInput $inputRecord; $x.cases.brokerActorBinding.extra='private'
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Unexpected field accepted' }; $checks++
$x=Copy-VerdictInput $inputRecord; $x.cases.actorSidBinding.proof='forged'
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Malformed proof accepted' }; $checks++
$noProvenance={param($kind,$entry,$record) return ($kind -cne 'workflow_provenance')}
if ((Get-PhaseAVerdict $inputRecord $noProvenance).status -cne 'UNVERIFIED') { throw 'Missing workflow provenance accepted' }; $checks++
$wrongPid={param($kind,$entry,$record) return ($kind -cne 'actorPidBinding')}
if ((Get-PhaseAVerdict $inputRecord $wrongPid).status -cne 'UNVERIFIED') { throw 'Uncorroborated PID accepted' }; $checks++
$forgedFail={param($kind,$entry,$record) return ($kind -cne 'unauthorizedRead')}
$x=Copy-VerdictInput $inputRecord; $x.cases.unauthorizedRead.state='FAIL'; $x.cases.unauthorizedRead.reason='VIOLATION'
if ((Get-PhaseAVerdict $x $forgedFail).status -cne 'UNVERIFIED') { throw 'Uncorroborated violation accepted' }; $checks++
Write-Output "PASS synthetic verdict negative controls ($checks)"
$managerCandidate=New-PhaseAManagerVerdictInput ('1'*40) '123'
if ((Get-PhaseAVerdict $managerCandidate $verify).status -cne 'UNVERIFIED') { throw 'Manager invented per-control evidence' }
$x=Copy-VerdictInput $inputRecord; $x.policy='unknown-policy'
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Unknown policy accepted' }
$noAuthorization={param($kind,$entry,$record) return ($kind -cne 'authorization')}
if ((Get-PhaseAVerdict $inputRecord $noAuthorization).status -cne 'UNVERIFIED') { throw 'Unverified authorization accepted' }
Write-Output 'PASS manager evidence, policy and authorization controls (3)'
$x=Copy-VerdictInput $inputRecord; $x.cases.unauthorizedRead.state='FAIL'; $x.cases.unauthorizedRead.reason='VIOLATION'; $x.cases.supervisorTermination=@{state='NOT_RUN';evidence='NOT_RUN';reason='NOT_RUN';proof=''}
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Violation masked missing mandatory observation' }
$x=Copy-VerdictInput $inputRecord; $x.cases.unauthorizedRead.state='FAIL'; $x.cases.unauthorizedRead.reason='VIOLATION'; $x.cases.aclInspection.state='FAIL'; $x.cases.aclInspection.reason='SETUP_FAILED'
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Violation masked incomplete setup' }
Write-Output 'PASS missing and setup precedence controls (2)'
if ((Get-PhaseAVerdict 'malformed' $verify).status -cne 'UNVERIFIED') { throw 'Non-map report accepted' }
$x=Copy-VerdictInput $inputRecord; $x.cases.actorPidBinding.proof=@(('a'*64),('b'*64))
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Array proof accepted' }
$x=Copy-VerdictInput $inputRecord; $x.cases.actorPidBinding.state=@('PASS')
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Array state accepted' }
Write-Output 'PASS malformed type rejection controls (3)'
foreach ($key in @('actorPidBinding','actorSidBinding','actorCreationTimeBinding')) {
  $script:rejectedProof=$key
  $reject={param($kind,$entry,$record) return ($kind -cne $script:rejectedProof)}
  if ((Get-PhaseAVerdict $inputRecord $reject).status -cne 'UNVERIFIED') { throw "Mismatched observation accepted: $key" }
}
$throwingVerifier={param($kind,$entry,$record) throw 'synthetic verifier failure'}
if ((Get-PhaseAVerdict $inputRecord $throwingVerifier).status -cne 'UNVERIFIED') { throw 'Verifier exception did not fail closed' }
Write-Output 'PASS identity binding and verifier failure controls (4)'
foreach ($key in $policy) {
  $x=Copy-VerdictInput $inputRecord; $x.cases[$key].state='FAIL'; $x.cases[$key].reason='CONTROL_FAILED'
  if ((Get-PhaseAVerdict $x $verify).status -ceq 'GREEN') { throw "Failed $key became GREEN" }
}
$x=Copy-VerdictInput $inputRecord; $x.cases.proposedDelete=@{state='PASS';evidence='LIVE_OBSERVED';reason='NONE';proof=('a'*64)}
if ((Get-PhaseAVerdict $x $verify).status -cne 'UNVERIFIED') { throw 'Unadopted policy field silently accepted' }
Write-Output "PASS no failed mandatory case can compute GREEN ($($policy.Count)) and addendum remains separate"
. "$PSScriptRoot/PhaseA.Evidence.ps1"
$journal=New-Object 'System.Collections.Generic.List[object]'
foreach ($spec in @(@('broker','probe','allowed'),@('legacy','probe','allowed'),@('broker','Read','allowed'),@('broker','Create','allowed'),@('broker','Read','allowed'),@('legacy','Read','denied'),@('legacy','Overwrite','denied'),@('legacy','Create','denied'),@('legacy','Read','allowed'))) {
  $sid=if ($spec[0] -ceq 'broker') {'S-1-5-21-1'} else {'S-1-5-21-2'}; $exitCode=if ($spec[2] -ceq 'denied') {20} else {0}
  $obs=@{role=$spec[0];expectedSid=$sid;observedSid=$sid;reportedSid=$sid;expectedPid=123;reportedPid=123;tokenNonAdmin=$true;tokenObserved=$true;createdAt='2026-01-01T00:00:00Z';observedCreatedAt='2026-01-01T00:00:00Z';expectedNonce='n';reportedNonce='n';exitCode=$exitCode;outcome=$spec[2];contained=$true;terminated=$true}
  $journal.Add(@{role=$spec[0];operation=$spec[1];accountSid=$sid;tokenSid=$sid;observation=$obs})
}
$bridge=New-PhaseAManagerVerdictInput ('1'*40) '123'
Add-PhaseAActorEvidence $bridge $journal.ToArray() 'SIMULATED_PASS'
if ($bridge.cases.actorPidBinding.state -cne 'PASS' -or $bridge.cases.actorPidBinding.evidence -cne 'SIMULATED_PASS') { throw 'Valid simulated actor evidence not mapped' }
if ($bridge.cases.accountCleanup.state -cne 'NOT_RUN') { throw 'Stage completion invented account cleanup' }
Write-Output 'PASS actor evidence bridge positive and missing controls (2)'
function Copy-ActorJournal($source) { $copy=New-Object 'System.Collections.Generic.List[object]'; foreach ($item in $source) { $v=$item.Clone(); $v.observation=$item.observation.Clone(); $copy.Add($v) }; return ,$copy.ToArray() }
foreach ($field in @('reportedPid','reportedSid','createdAt','contained','terminated','outcome')) {
  $copy=Copy-ActorJournal $journal.ToArray()
  switch ($field) { 'reportedPid' {$copy[2].observation.reportedPid=124} 'reportedSid' {$copy[2].observation.reportedSid='S-1-5-21-9'} 'createdAt' {$copy[2].observation.createdAt='2026-01-01T00:00:01Z'} 'contained' {$copy[2].observation.contained=$false} 'terminated' {$copy[2].observation.terminated=$false} 'outcome' {$copy[2].observation.outcome='denied'} }
  $candidate=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $candidate $copy 'SIMULATED_PASS'
  if ($candidate.cases.actorPidBinding.state -cne 'NOT_RUN') { throw "Bad actor evidence accepted: $field" }
}
$candidate=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $candidate @() 'SIMULATED_PASS'
if ($candidate.cases.actorPidBinding.state -cne 'NOT_RUN') { throw 'Missing journal accepted' }
$candidate=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $candidate $journal.ToArray() 'SIMULATED_PASS'
if ((Get-PhaseAVerdict $candidate $verify).status -cne 'UNVERIFIED') { throw 'Simulated bridge evidence accepted as live' }
Write-Output 'PASS actor evidence bridge negative controls (8)'
$finalReport=@{schema='ether.t3.phase-a.final.v1';policy='phase-a-core-provisional-v1';repository='andyle777/Ether-Memories';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted';commit=('1'*40);runId='123';runAttempt='1';status='GREEN';reason='ALL_MANDATORY_CONTROLS_VERIFIED';cleanup='COMPLETE';provenance='VERIFIED';cases=$inputRecord.cases}
if (-not (Test-PhaseAFinalReport $finalReport $verify)) { throw 'Verified synthetic final report rejected' }
$badFinal=$finalReport.Clone(); $badFinal.repository='other/repo'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Wrong repository accepted' }
$badFinal=$finalReport.Clone(); $badFinal.workflowRef='wrong'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Wrong workflow accepted' }
$badFinal=$finalReport.Clone(); $badFinal.status='RED'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Forged verdict accepted' }
Write-Output 'PASS strict final report injected controls (4)'
$redReport=$finalReport.Clone(); $redCases=@{}; foreach ($key in $finalReport.cases.Keys) { $redCases[$key]=$finalReport.cases[$key].Clone() }; $redCases.unauthorizedRead.state='FAIL'; $redCases.unauthorizedRead.reason='VIOLATION'; $redReport.cases=$redCases; $redReport.status='RED'; $redReport.reason='MANDATORY_CONTROL_FAILED'
if (-not (Test-PhaseAFinalReport $redReport $verify)) { throw 'Verified synthetic RED report rejected' }
$badFinal=$redReport.Clone(); $badFinal.status='GREEN'; $badFinal.reason='ALL_MANDATORY_CONTROLS_VERIFIED'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Verified violation became GREEN' }
$badFinal=$redReport.Clone(); $badFinal.cleanup='UNCONFIRMED'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Incomplete cleanup accepted' }
$badFinal=$finalReport.Clone(); $badFinal.extra='secret'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Extra final report field accepted' }
$badFinal=$finalReport.Clone(); $badFinal.status='UNVERIFIED'; $badFinal.reason='MISSING_OR_UNTRUSTED_EVIDENCE'; $badFinal.repository='private-value'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Unsafe unverified metadata accepted' }
Write-Output 'PASS RED, cleanup and final report safety controls (5)'
$badFinal=$finalReport.Clone(); $badFinal.status='UNVERIFIED'; $badFinal.reason='MISSING_OR_UNTRUSTED_EVIDENCE'; $badFinal.provenance='UNVERIFIED'; $badFinal.cleanup='COMPLETE'; $badFinal.cases=(New-PhaseAManagerVerdictInput ('1'*40) '123').cases
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'Unproven cleanup accepted' }
$badFinal=$finalReport.Clone(); $badFinal.provenance='UNVERIFIED'
if (Test-PhaseAFinalReport $badFinal $verify) { throw 'GREEN accepted without verified provenance' }
Write-Output 'PASS final report provenance and cleanup distinction (2)'
. "$PSScriptRoot/PhaseA.Oidc.ps1"
$rsa=New-Object Security.Cryptography.RSACryptoServiceProvider(2048)
try {
  $public=$rsa.ExportParameters($false)
  function Test-EncodeUrl([byte[]]$bytes) { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
  $keys=@(@{kid='test-key';kty='RSA';alg='RS256';use='sig';n=(Test-EncodeUrl $public.Modulus);e=(Test-EncodeUrl $public.Exponent)})
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $expect=@{audience='urn:ether:phase-a:test';repository='andyle777/Ether-Memories';repositoryId='1345912571';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted';sha=('1'*40);runId='123';runAttempt='1'}
  $claims=@{iss='https://token.actions.githubusercontent.com';aud=$expect.audience;repository=$expect.repository;repository_id=$expect.repositoryId;workflow_ref=$expect.workflowRef;ref=$expect.ref;event_name=$expect.event;runner_environment=$expect.runner;sha=$expect.sha;workflow_sha=$expect.sha;jti='synthetic-id';run_id=$expect.runId;run_attempt=$expect.runAttempt;iat=$now;nbf=($now-1);exp=($now+300)}
  function New-TestOidc($claims) { $h=Test-EncodeUrl ([Text.Encoding]::UTF8.GetBytes((@{alg='RS256';kid='test-key'} | ConvertTo-Json -Compress))); $p=Test-EncodeUrl ([Text.Encoding]::UTF8.GetBytes(($claims | ConvertTo-Json -Compress))); $data=[Text.Encoding]::ASCII.GetBytes($h+'.'+$p); $signature=$rsa.SignData($data,[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')); return $h+'.'+$p+'.'+(Test-EncodeUrl $signature) }
  $jwt=New-TestOidc $claims
  if (-not (Test-PhaseAOidcToken $jwt $keys $expect $now)) { throw 'Valid test-signed OIDC token rejected' }
  Write-Output 'PASS synthetic signed OIDC positive control'
  $oidcChecks=0
  foreach ($case in @(@('repository','other/repo'),@('repository_id','9'),@('workflow_ref','wrong'),@('sha',('2'*40)),@('workflow_sha',('2'*40)),@('ref','refs/heads/main'),@('event_name','pull_request'),@('run_id','124'),@('run_attempt','2'),@('runner_environment','self-hosted'),@('aud','wrong'),@('iss','https://wrong.invalid'))) {
    $bad=$claims.Clone(); $bad[$case[0]]=$case[1]
    if (Test-PhaseAOidcToken (New-TestOidc $bad) $keys $expect $now) { throw "Wrong signed claim accepted: $($case[0])" }; $oidcChecks++
  }
  $bad=$claims.Clone(); $bad.exp=$now-1
  if (Test-PhaseAOidcToken (New-TestOidc $bad) $keys $expect $now) { throw 'Expired token accepted' }; $oidcChecks++
  $bad=$claims.Clone(); $bad.nbf=$now+60
  if (Test-PhaseAOidcToken (New-TestOidc $bad) $keys $expect $now) { throw 'Future token accepted' }; $oidcChecks++
  $parts=$jwt.Split('.'); $signature=ConvertFrom-PhaseABase64Url $parts[2]; $signature[0]=$signature[0] -bxor 1; $forged=$parts[0]+'.'+$parts[1]+'.'+(Test-EncodeUrl $signature)
  if (Test-PhaseAOidcToken $forged $keys $expect $now) { throw 'Forged signature accepted' }; $oidcChecks++
  if (Test-PhaseAOidcToken ($parts[0]+'.'+$parts[1]+'.') $keys $expect $now) { throw 'Unsigned claims accepted' }; $oidcChecks++
  if (Test-PhaseAOidcToken $jwt @() $expect $now) { throw 'Untrusted key accepted' }; $oidcChecks++
  Write-Output "PASS synthetic OIDC signature, claims and lifetime negative controls ($oidcChecks)"

} finally { $rsa.Dispose() }
$aud1=Get-PhaseAEvidenceAudience $inputRecord '1'
$changedInput=Copy-VerdictInput $inputRecord; $changedInput.cases.actorPidBinding.proof=('b'*64)
$aud2=Get-PhaseAEvidenceAudience $changedInput '1'
$aud3=Get-PhaseAEvidenceAudience $inputRecord '2'
if ($aud1 -cnotmatch '^urn:ether:phase-a:[0-9a-f]{64}$' -or $aud1 -ceq $aud2 -or $aud1 -ceq $aud3) { throw 'OIDC audience did not bind evidence and attempt' }
Write-Output 'PASS evidence and run-attempt audience binding'
$priorUrl=[Environment]::GetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_URL','Process'); $priorToken=[Environment]::GetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_TOKEN','Process')
try {
  [Environment]::SetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_URL','https://example.invalid/oidc','Process')
  [Environment]::SetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_TOKEN','synthetic','Process')
  if (Test-PhaseAGitHubOidcProvenance $inputRecord '1') { throw 'Untrusted OIDC request endpoint accepted' }
} finally {
  [Environment]::SetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_URL',$priorUrl,'Process')
  [Environment]::SetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_TOKEN',$priorToken,'Process')
}
Write-Output 'PASS OIDC request endpoint rejection'
$bridged=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $bridged $journal.ToArray() 'SIMULATED_PASS'
$bridgeVerifier=New-PhaseAEvidenceVerifier $journal.ToArray() $bridged '1' $true $true 'SIMULATED_PASS'
if (-not (& $bridgeVerifier 'actorPidBinding' $bridged.cases.actorPidBinding $bridged)) { throw 'Valid journal proof not independently rechecked' }
$forgedEntry=$bridged.cases.actorPidBinding.Clone(); $forgedEntry.proof=('f'*64)
if (& $bridgeVerifier 'actorPidBinding' $forgedEntry $bridged) { throw 'Forged journal proof accepted' }
$wrongContext=$bridged.Clone(); $wrongContext.commit=('2'*40)
if (& $bridgeVerifier 'workflow_provenance' $null $wrongContext) { throw 'Provenance not bound to commit' }
if (& $bridgeVerifier 'accountCleanup' $bridged.cases.accountCleanup $bridged) { throw 'Missing producer accepted' }
Write-Output 'PASS independently rechecked journal and provenance binding (4)'
$bridgeFinal=@{schema='ether.t3.phase-a.final.v1';policy=$bridged.policy;repository='andyle777/Ether-Memories';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted';commit=$bridged.commit;runId=$bridged.runId;runAttempt='1';status='UNVERIFIED';reason='MISSING_OR_UNTRUSTED_EVIDENCE';cleanup='NOT_RUN';provenance='VERIFIED';cases=$bridged.cases}
if (-not (Test-PhaseAFinalReport $bridgeFinal $bridgeVerifier)) { throw 'Bound synthetic provenance report rejected' }
$badFinal=$bridgeFinal.Clone(); $badFinal.runAttempt='2'
if (Test-PhaseAFinalReport $badFinal $bridgeVerifier) { throw 'Wrong attempt accepted with verified provenance' }
$badFinal=$bridgeFinal.Clone(); $badFinal.cases=@{}; foreach ($key in $bridgeFinal.cases.Keys) { $badFinal.cases[$key]=$bridgeFinal.cases[$key].Clone() }; $badFinal.cases.actorPidBinding.proof=('c'*64)
if (Test-PhaseAFinalReport $badFinal $bridgeVerifier) { throw 'Altered evidence set accepted with verified provenance' }
if (Test-PhaseAFinalReport $bridgeFinal {param($kind,$entry,$report) return $false}) { throw 'Unverified OIDC claims accepted' }
Write-Output 'PASS final report provenance binding and forged evidence controls (4)'
$same=Copy-ActorJournal $journal.ToArray()
foreach ($item in $same) { if ($item.role -ceq 'legacy') { $item.accountSid='S-1-5-21-1'; $item.tokenSid='S-1-5-21-1'; $item.observation.expectedSid='S-1-5-21-1'; $item.observation.observedSid='S-1-5-21-1'; $item.observation.reportedSid='S-1-5-21-1' } }
$test=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $test $same 'SIMULATED_PASS'
if ($test.cases.identityDistinct.state -cne 'NOT_RUN') { throw 'Same SID was accepted by evidence bridge' }
Write-Output 'PASS evidence bridge rejects identical identities'
$provenanceOnly=New-PhaseAEvidenceVerifier $journal.ToArray() $bridged '1' $true $false 'SIMULATED_PASS'
if (-not (& $provenanceOnly 'workflow_provenance' $null $bridged) -or (& $provenanceOnly 'authorization' $null $bridged)) { throw 'OIDC provenance was mistaken for owner authorization' }
Write-Output 'PASS provenance does not imply owner authorization'
# Primary-token records require a second handle inspection, matching actor OS
# evidence, and an observed successful handle close; simulated records stay simulated.
$tokenJournal=@(
  @{role='broker';accountSid='S-1-5-21-1';first=@{sid='S-1-5-21-1';primary=$true;admin=$false;elevated=$false;standard=$true};second=@{sid='S-1-5-21-1';primary=$true;admin=$false;elevated=$false;standard=$true;handleOpen=$true};closed=$true},
  @{role='legacy';accountSid='S-1-5-21-2';first=@{sid='S-1-5-21-2';primary=$true;admin=$false;elevated=$false;standard=$true};second=@{sid='S-1-5-21-2';primary=$true;admin=$false;elevated=$false;standard=$true;handleOpen=$true};closed=$true}
)
$tokenCandidate=New-PhaseAManagerVerdictInput ('1'*40) '123'
if (-not (Get-Command Add-PhaseAPrimaryTokenEvidence -ErrorAction SilentlyContinue)) { throw 'Primary-token evidence adapter is missing' }
Add-PhaseAPrimaryTokenEvidence $tokenCandidate $tokenJournal $journal.ToArray() 'SIMULATED_PASS'
if ($tokenCandidate.cases.brokerPrimaryToken.state -cne 'PASS' -or $tokenCandidate.cases.legacyPrimaryToken.evidence -cne 'SIMULATED_PASS') { throw 'Valid token evidence rejected' }
foreach ($field in @('sid','primary','handleOpen','closed')) {
  $bad=@($tokenJournal | ForEach-Object { $copy=$_.Clone(); $copy.first=$_.first.Clone(); $copy.second=$_.second.Clone(); $copy })
  switch ($field) { 'sid' {$bad[0].second.sid='S-1-5-21-9'} 'primary' {$bad[0].second.primary=$false} 'handleOpen' {$bad[0].second.handleOpen=$false} 'closed' {$bad[0].closed=$false} }
  $candidate=New-PhaseAManagerVerdictInput ('1'*40) '123'
  Add-PhaseAPrimaryTokenEvidence $candidate $bad $journal.ToArray() 'SIMULATED_PASS'
  if ($candidate.cases.brokerPrimaryToken.state -cne 'NOT_RUN') { throw "Invalid token evidence accepted: $field" }
}
Write-Output 'PASS independent primary-token evidence and failure controls (5)'
$tokenRecord=New-PhaseAManagerVerdictInput ('1'*40) '123'
$audienceBefore=Get-PhaseAEvidenceAudience $tokenRecord '1'
if (-not (Get-Command Test-PhaseAOidcEvidenceBinding -ErrorAction SilentlyContinue)) { throw 'OIDC final evidence recheck is missing' }
if (-not (Test-PhaseAOidcEvidenceBinding $tokenRecord '1' $audienceBefore)) { throw 'Stable evidence binding rejected' }
$tokenRecord.cases.brokerPrimaryToken=@{state='PASS';evidence='LIVE_OBSERVED';reason='NONE';proof=('a'*64)}
if (Test-PhaseAOidcEvidenceBinding $tokenRecord '1' $audienceBefore) { throw 'Evidence mutation after token request accepted' }
Write-Output 'PASS OIDC final evidence mutation rejection'
$tokenBound=New-PhaseAManagerVerdictInput ('1'*40) '123'
Add-PhaseAActorEvidence $tokenBound $journal.ToArray() 'SIMULATED_PASS'
Add-PhaseAPrimaryTokenEvidence $tokenBound $tokenJournal $journal.ToArray() 'SIMULATED_PASS'
$tokenVerifier=New-PhaseAEvidenceVerifier $journal.ToArray() $tokenBound '1' $true $true 'SIMULATED_PASS' $tokenJournal
if (-not (& $tokenVerifier 'brokerPrimaryToken' $tokenBound.cases.brokerPrimaryToken $tokenBound)) { throw 'Primary-token proof was not rechecked' }
$forged=$tokenBound.cases.brokerPrimaryToken.Clone(); $forged.proof=('f'*64)
if (& $tokenVerifier 'brokerPrimaryToken' $forged $tokenBound) { throw 'Forged primary-token proof accepted' }
Write-Output 'PASS independent primary-token proof recheck and forgery rejection'
$innerObservation=@{status='OBSERVED';reason='NONE';pid=123;sid='S-1-5-21-1';createdAt='2026-01-01T00:00:00Z';limitFlags=8192;member=$true;supervisorMember=$false;released=$true}
$innerEvidence=@{supervisorDeath=@{mode='supervisorDeath';source='INJECTED';supervisorPid=122;supervisorSid='S-1-5-21-1';supervisorCreatedAt='2026-01-01T00:00:00Z';childPid=123;childSid='S-1-5-21-1';childCreatedAt='2026-01-01T00:00:00Z';innerJobObservation=$innerObservation;cleanupSucceeded=$true}}
$innerVerdict=New-PhaseAManagerVerdictInput ('1'*40) '123'
if (-not (Get-Command Add-PhaseAInnerJobEvidence -ErrorAction SilentlyContinue)) { throw 'Inner job verdict adapter is missing' }
Add-PhaseAInnerJobEvidence $innerVerdict $innerEvidence $journal.ToArray() 'SIMULATED_PASS'
if ($innerVerdict.cases.jobContainment.state -cne 'PASS' -or $innerVerdict.cases.jobContainment.evidence -cne 'SIMULATED_PASS') { throw 'Valid simulated inner containment record rejected' }
if ($innerVerdict.cases.jobClosure.state -cne 'NOT_RUN') { throw 'Unobserved job closure promoted' }
$innerEvidence.supervisorDeath.innerJobObservation.supervisorMember=$true
$innerVerdict=New-PhaseAManagerVerdictInput ('1'*40) '123'
Add-PhaseAInnerJobEvidence $innerVerdict $innerEvidence $journal.ToArray() 'SIMULATED_PASS'
if ($innerVerdict.cases.jobContainment.state -cne 'NOT_RUN') { throw 'Outer job substitution accepted' }
Write-Output 'PASS simulated inner-job adapter and outer-job substitution (3)'
foreach ($field in @('pid','sid','createdAt','limitFlags','member','released','cleanupSucceeded','source')) {
 $rec=$innerEvidence.supervisorDeath.Clone(); $item=$innerObservation.Clone(); $item.supervisorMember=$false; $rec.innerJobObservation=$item
 switch ($field) { 'pid' {$item.pid=124} 'sid' {$item.sid='S-1-5-21-9'} 'createdAt' {$item.createdAt='2026-01-01T00:00:01Z'} 'limitFlags' {$item.limitFlags=0} 'member' {$item.member=$false} 'released' {$item.released=$false} 'cleanupSucceeded' {$rec.cleanupSucceeded=$false} 'source' {$rec.source='LIVE'} }
 $x=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAInnerJobEvidence $x @{supervisorDeath=$rec} $journal.ToArray() 'SIMULATED_PASS'
 if ($field -ceq 'cleanupSucceeded') { if ($x.cases.jobContainment.state -cne 'FAIL' -or $x.cases.jobContainment.reason -cne 'CLEANUP_UNCONFIRMED') { throw 'Cleanup failure was not retained' } } elseif ($field -cin @('pid','sid','createdAt')) { if ($x.cases.jobContainment.state -cne 'FAIL' -or $x.cases.jobContainment.reason -cne 'SETUP_FAILED') { throw 'Identity failure was not retained' } } elseif ($x.cases.jobContainment.state -cne 'NOT_RUN') { throw "Invalid inner observation accepted: $field" }
}
Write-Output 'PASS inner-job identity, limit, ownership and simulated source controls (8)'
$innerObservation.supervisorMember=$false
$innerBound=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAInnerJobEvidence $innerBound $innerEvidence $journal.ToArray() 'SIMULATED_PASS'
$innerVerifier=New-PhaseAEvidenceVerifier $journal.ToArray() $innerBound '1' $true $true 'SIMULATED_PASS' @() $innerEvidence
if (-not (& $innerVerifier 'jobContainment' $innerBound.cases.jobContainment $innerBound)) { throw 'Inner job proof was not independently rechecked' }
$fakeProof=$innerBound.cases.jobContainment.Clone(); $fakeProof.proof=('f'*64)
if (& $innerVerifier 'jobContainment' $fakeProof $innerBound) { throw 'Forged inner job proof accepted' }
if ((Get-PhaseAVerdict $innerBound $innerVerifier).status -cne 'UNVERIFIED') { throw 'Simulated inner job promoted to live verdict' }
Write-Output 'PASS inner-job verifier binding, forgery and simulated verdict controls (3)'
# The bounded closure adapter must preserve real outcomes while rejecting setup gaps.
$innerGood=@{status='OBSERVED';reason='NONE';pid=123;sid='S-1-5-21-1';createdAt='2026-01-01T00:00:00Z';limitFlags=8192;member=$true;supervisorMember=$false;released=$true}
$closureRecord=@{mode='jobClosure';source='INJECTED';supervisorPid=122;supervisorSid='S-1-5-21-1';supervisorCreatedAt='2026-01-01T00:00:00Z';childPid=123;childSid='S-1-5-21-1';childCreatedAt='2026-01-01T00:00:00Z';innerJobObservation=$innerGood;childRunningBeforeAction=$true;action='CLOSE_REQUESTED';supervisorWaitSucceeded=$true;supervisorExitCode=0;childWaitOutcome='SIGNALED';childExitCode=1;childAliveAfterWait=$false;cleanupSucceeded=$true}
$bounded=@{jobClosure=$closureRecord}
$x=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $x $bounded $journal.ToArray() 'SIMULATED_PASS'
if ($x.cases.jobClosure.state -cne 'PASS') { throw 'Bounded closure success was not retained' }
$failed=$closureRecord.Clone();$failed.childWaitOutcome='TIMEOUT';$failed.childExitCode=$null;$failed.childAliveAfterWait=$true
$x=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $x @{jobClosure=$failed} $journal.ToArray() 'SIMULATED_PASS'
if ($x.cases.jobClosure.state -cne 'FAIL' -or $x.cases.jobClosure.reason -cne 'CONTROL_FAILED') { throw 'Observed surviving child was not retained' }
$failed=$closureRecord.Clone();$failed.childWaitOutcome='FAILED';$failed.childExitCode=$null;$failed.childAliveAfterWait=$null
$x=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $x @{jobClosure=$failed} $journal.ToArray() 'SIMULATED_PASS'
if ($x.cases.jobClosure.state -ceq 'PASS' -or $x.cases.jobClosure.reason -ceq 'CONTROL_FAILED') { throw 'Failed wait was misclassified' }
$badInner=$innerGood.Clone();$badInner.status='FAILED';$badInner.reason='JOB_MISMATCH';$badInner.member=$false
$badContainment=$closureRecord.Clone();$badContainment.mode='supervisorDeath';$badContainment.innerJobObservation=$badInner
$x=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $x @{supervisorDeath=$badContainment} $journal.ToArray() 'SIMULATED_PASS'
if ($x.cases.jobContainment.state -cne 'FAIL') { throw 'Observed inner-job membership failure not retained' }
Write-Output 'PASS bounded closure and containment outcome mapping (4)'
$failureRecord=$closureRecord.Clone();$failureRecord.childWaitOutcome='TIMEOUT';$failureRecord.childExitCode=$null;$failureRecord.childAliveAfterWait=$true;$failureRecord.cleanupSucceeded=$false
$failureJournal=@{jobClosure=$failureRecord}
$failureVerdict=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $failureVerdict $failureJournal $journal.ToArray() 'SIMULATED_PASS'
if ($failureVerdict.cases.jobClosure.state -cne 'FAIL' -or $failureVerdict.cases.jobClosure.reason -cne 'CONTROL_FAILED') { throw 'Later cleanup masked a verified survivor' }
$failureVerifier=New-PhaseAEvidenceVerifier $journal.ToArray() $failureVerdict '1' $true $true 'SIMULATED_PASS' @() $failureJournal
if (-not (& $failureVerifier 'jobClosure' $failureVerdict.cases.jobClosure $failureVerdict)) { throw 'Verified failure proof was rejected' }
if ((Get-PhaseAVerdict $failureVerdict $failureVerifier).status -cne 'UNVERIFIED') { throw 'Incomplete simulated experiment gained a final verdict' }
$fake=$failureVerdict.cases.jobClosure.Clone();$fake.state='PASS';$fake.reason='NONE'
if (& $failureVerifier 'jobClosure' $fake $failureVerdict) { throw 'Failure promoted to PASS' }
foreach ($field in @('childRunningBeforeAction','action','supervisorWaitSucceeded','childWaitOutcome','cleanupSucceeded')) {
 $test=$closureRecord.Clone()
 switch ($field) { 'childRunningBeforeAction' {$test.childRunningBeforeAction=$false} 'action' {$test.action='NOT_RUN'} 'supervisorWaitSucceeded' {$test.supervisorWaitSucceeded=$false} 'childWaitOutcome' {$test.childWaitOutcome='NOT_RUN'} 'cleanupSucceeded' {$test.cleanupSucceeded=$false} }
 $v=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAInnerJobEvidence $v @{jobClosure=$test} $journal.ToArray() 'SIMULATED_PASS'
 if ($v.cases.jobClosure.state -ceq 'PASS') { throw "Incomplete closure accepted: $field" }
}
Write-Output 'PASS survivor preservation, failed-proof verification and closure incompleteness controls (9)'
