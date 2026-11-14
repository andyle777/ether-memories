$ErrorActionPreference = "Stop"
$base=[IO.Path]::GetTempPath()
$reports=@()
. "$PSScriptRoot/PhaseA.Verdict.ps1"
. "$PSScriptRoot/PhaseA.Accounts.ps1"
. "$PSScriptRoot/PhaseA.Stage2.ps1"
. "$PSScriptRoot/PhaseA.Stage3.ps1"
$reportCases=@{}
foreach ($k in @('accountIdentity','brokerIdentity','legacyIdentity','actorIdentity','containment','acl','authorizedRead','authorizedCreate','authorizedReadback','unauthorizedRead','unauthorizedWrite','unauthorizedCreate','proposedDelete','proposedRename','inventory','insecureRejected','processCleanup','fixtureCleanup','accountCleanup','adversarialControls','supervisorInjected','supervisorFailure')) { $reportCases[$k]='NOT_RUN' }
$supervisorCases=@{}; foreach ($mode in @('supervisorDeath','jobClosure','timeout')) { $supervisorCases[$mode]=@{status='NOT_RUN';evidence='LIVE';reason='NOT_RUN'} }
$emptyVerdictInput=New-PhaseAManagerVerdictInput ('1'*40) '123'
$emptyFinal=@{schema='ether.t3.phase-a.final.v1';policy='phase-a-core-provisional-v1';repository='unknown';workflowRef='unknown';ref='unknown';event='unknown';runner='unknown';commit='unknown';runId='unknown';runAttempt='unknown';status='UNVERIFIED';reason='MISSING_OR_UNTRUSTED_EVIDENCE';cleanup='NOT_RUN';provenance='UNVERIFIED';cases=$emptyVerdictInput.cases}
$reportTest=@{verdict=$emptyFinal;supervisorCases=$supervisorCases;schema='ether.t3.phase-a.observations.v1';status='UNVERIFIED';source='42f9b5bdf94e47c4c69c0f87127eb545dff13ed1';commit='unknown';reason='IMPLEMENTATION_INCOMPLETE';cases=$reportCases}
if (-not (Test-PhaseAObservationReport $reportTest)) { throw 'Valid report rejected' }
$badReport=$reportTest.Clone(); $badCases=$reportCases.Clone(); $badCases.Remove('inventory'); $badReport.cases=$badCases
if (Test-PhaseAObservationReport $badReport) { throw 'Report with missing observation accepted' }
$badReport=$reportTest.Clone(); $badReport['privatePath']='x'
if (Test-PhaseAObservationReport $badReport) { throw 'Report with private extra field accepted' }
$badReport=$reportTest.Clone(); $badReport.status='GREEN'
if (Test-PhaseAObservationReport $badReport) { throw 'Premature GREEN accepted' }
$script:stage3events=New-Object 'System.Collections.Generic.List[string]'
$script:created3=$false
$stage3fixture=@{ Setup={ param($a) @{protectedFile='existing';newFile='new';deniedFile='missing';controlFile='control';initialDigest=('a'*64);writeDigest=('b'*64);aclInspected=$true} }; Exists={ param($p) if ($p -eq 'new') { $script:created3 } else { $p -ne 'missing' -and -not $p.EndsWith('.renamed') } }; Digest={ param($p) if ($p -eq 'existing') {'a'*64} else {'b'*64} }; Inventory={ param($f) 'unchanged' }; Cleanup={ param($f) $script:stage3events.Add('cleanup') } }
$stage3actors=@{Run={ param($a,$t,$operation,$target) $denied=($a.role -ceq 'legacy' -and -not [string]::IsNullOrEmpty($target) -and $target -ne 'control'); if ($a.role -eq 'broker' -and $operation -eq 'Create' -and $target -eq 'new') { $script:created3=$true }; $out=if ($denied) {'denied'} else {'allowed'}; $code=if ($denied) {20} else {0}; $o=@{expectedSid=$a.sid;observedSid=$a.sid;reportedSid=$a.sid;expectedPid=123;reportedPid=123;tokenNonAdmin=$true;tokenObserved=$true;createdAt='2026-01-01T00:00:00Z';observedCreatedAt='2026-01-01T00:00:00Z';expectedNonce='nonce';reportedNonce='nonce';exitCode=$code;outcome=$out;role=$a.role;contained=$true;terminated=$true}; if ($operation -eq 'Read' -and -not $denied) { $o.digest=if ($target -eq 'existing') {'a'*64} else {'b'*64} }; $o } }
$accounts3=@(@{role='broker';sid='S-1-5-21-1'},@{role='legacy';sid='S-1-5-21-2'}); $tokens3=@(@{sid='S-1-5-21-1'},@{sid='S-1-5-21-2'})
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $stage3fixture $stage3actors
if ($s3.status -cne 'STAGE3_COMPLETE' -or -not $script:stage3events.Contains('cleanup')) { throw 'Stage 3 simulated success or cleanup failed' }
$script:created3=$false
$mutated=$stage3fixture.Clone(); $script:inventoryCalls=0; $mutated.Inventory={ param($f) $script:inventoryCalls++; if ($script:inventoryCalls -gt 1) {'changed'} else {'unchanged'} }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $mutated $stage3actors
if ($s3.status -ceq 'STAGE3_COMPLETE') { throw 'Stage 3 accepted changed protected inventory' }
$script:created3=$false
$missing=$stage3fixture.Clone(); $missing.Exists={ param($p) $false }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $missing $stage3actors
if ($s3.status -ceq 'STAGE3_COMPLETE' -or -not $s3.cases.fixtureCleanup) { throw 'Missing source accepted or not cleaned' }
$noAcl=$stage3fixture.Clone(); $noAcl.Setup={ param($a) @{protectedFile='existing';newFile='new';deniedFile='missing';controlFile='control';initialDigest=('a'*64);writeDigest=('b'*64);aclInspected=$false} }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $noAcl $stage3actors
if ($s3.status -cne 'STAGE3_ACL_REJECTED') { throw 'Unverified ACL accepted' }
$aclError=$stage3fixture.Clone(); $aclError.Setup={ param($a) throw 'STAGE3_ACL_REJECTED' }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $aclError $stage3actors
if ($s3.status -cne 'STAGE3_ACL_REJECTED') { throw 'ACL setup error not classified' }
$script:created3=$false
$cleanup=$stage3fixture.Clone(); $cleanup.Cleanup={ param($f) throw 'synthetic cleanup failure' }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $cleanup $stage3actors
if ($s3.status -cne 'STAGE3_CLEANUP_FAILED') { throw 'Cleanup failure accepted' }
$script:created3=$false
$script:stage3Run=$stage3actors.Run
$blockedControl=@{Run={ param($a,$t,$op,$target) $v=& $script:stage3Run $a $t $op $target; if ($target -eq 'control') { $v.outcome='denied'; $v.exitCode=20 }; $v } }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $stage3fixture $blockedControl
if ($s3.status -ceq 'STAGE3_COMPLETE' -or $s3.cases.insecureRejected) { throw 'Unobserved insecure control accepted' }
$script:created3=$false
$missingRead=@{Run={ param($a,$t,$op,$target) $v=& $script:stage3Run $a $t $op $target; if ($a.role -eq 'legacy' -and $target -eq 'existing' -and $op -eq 'Read') { $v.outcome='error'; $v.exitCode=21 }; $v } }
$s3=Invoke-PhaseAStage3 $accounts3 $tokens3 $stage3fixture $missingRead
if ($s3.status -ceq 'STAGE3_COMPLETE' -or $s3.cases.unauthorizedRead) { throw 'Missing-resource error accepted as denial' }
$script:created3=$false
$script:stage2seen=New-Object 'System.Collections.Generic.List[string]'
$stage2fake=@{ Run={ param($account,$token) $script:stage2seen.Add("$($account.role):$($token.handle)"); @{ expectedSid=$account.sid; observedSid=$account.sid; reportedSid=$account.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=0; outcome='allowed'; role=$account.role; contained=$true; terminated=$true } } }
$ac=@(@{role='broker';sid='S-1-5-21-1'},@{role='legacy';sid='S-1-5-21-2'})
$tk=@(@{handle='broker';sid='S-1-5-21-1'},@{handle='legacy';sid='S-1-5-21-2'})
if ((Invoke-PhaseAStage2 $ac $tk $stage2fake) -cne 'STAGE2_COMPLETE' -or ($script:stage2seen -join ',') -cne 'broker:broker,legacy:legacy') { throw 'Stage 2 token binding failed' }
$wrong=$stage2fake.Clone(); $wrong.Run={ param($account,$token) @{ role=$account.role; expectedSid=$account.sid; observedSid='S-1-5-21-9'; reportedSid=$account.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=0; outcome='allowed'; contained=$true; terminated=$true } }
if ((Invoke-PhaseAStage2 $ac $tk $wrong) -cne 'STAGE2_OBSERVATION_REJECTED') { throw 'Stage 2 wrong SID accepted' }
$denied=$stage2fake.Clone()
$denied.Run={ param($account,$token,$operation,$target) @{ expectedSid=$account.sid; observedSid=$account.sid; reportedSid=$account.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=20; outcome='denied'; role=$account.role; contained=$true; terminated=$true } }
$op=Invoke-PhaseAActorOperation $ac[1] $tk[1] $denied 'Read' 'synthetic-target' 'denied'
if ($op.outcome -cne 'denied' -or $op.exitCode -ne 20) { throw 'Validated denied operation was not returned' }
$script:stage2mutation=''
foreach ($field in @('reportedPid','reportedSid','createdAt','contained')) {
  $script:stage2mutation=$field
  $badStage=$stage2fake.Clone()
  $badStage.Run={ param($a,$t) $v=@{ expectedSid=$a.sid; observedSid=$a.sid; reportedSid=$a.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=0; outcome='allowed'; role=$a.role; contained=$true; terminated=$true }; switch ($script:stage2mutation) { 'reportedPid' { $v.reportedPid=124 } 'reportedSid' { $v.reportedSid='S-1-5-21-9' } 'createdAt' { $v.createdAt='2026-01-01T00:00:01Z' } 'contained' { $v.contained=$false } 'terminated' { $v.terminated=$false } }; $v }
  if ((Invoke-PhaseAStage2 $ac $tk $badStage) -cne 'STAGE2_OBSERVATION_REJECTED') { throw "Stage 2 accepted invalid $field" }
}
Write-Output 'PASS injected Stage 2 token binding and SID rejection'
$script:events=New-Object 'System.Collections.Generic.List[string]'
$script:seq=0
$fake=@{
 Create={ param($role) $script:seq++; $script:events.Add("create:$role"); @{role=$role;sid="S-1-5-21-$script:seq"} }
 Authenticate={ param($account) $script:events.Add("auth:$($account.role)"); @{sid=$account.sid;primary=$true;admin=$false;elevated=$false;standard=$true;handle=$account.role} }
 Close={ param($token) $script:events.Add("close:$($token.handle)") }
 Remove={ param($account) $script:events.Add("remove:$($account.role)") }
}
$script:events.Clear(); $script:seq=0; $script:created3=$false; $result3=@{}
$r=Invoke-PhaseAStages $true $true $fake $stage3actors $true $stage3fixture $result3
if ($r -cne 'STAGE3_COMPLETE' -or -not $result3.cases.inventory -or -not $script:events.Contains('remove:broker')) { throw 'Stage 3 manager callback dispatch failed' }
$script:events.Clear(); $script:seq=0; $script:created3=$false
if ((Invoke-PhaseAStages $true $false $fake $stage3actors $true $stage3fixture @{}) -cne 'STAGE3_GUARD_REJECTED' -or $script:events.Count -ne 0) { throw 'Stage 3 guard failed' }
$script:events.Clear(); $script:seq=0; $script:stage2seen.Clear()
$r=Invoke-PhaseAStages $true $true $fake $stage2fake
if ($r -cne 'STAGE2_COMPLETE' -or ($script:stage2seen -join ',') -cne 'broker:broker,legacy:legacy' -or -not $script:events.Contains('close:legacy')) { throw 'Stage 1 to Stage 2 integration failed' }
$script:events.Clear(); $script:seq=0
$badLaunch=@{Run={ param($a,$t) throw 'STAGE2_TIMEOUT' }}
$r=Invoke-PhaseAStages $true $true $fake $badLaunch
if ($r -cne 'STAGE2_TIMEOUT' -or -not $script:events.Contains('close:legacy') -or -not $script:events.Contains('remove:broker')) { throw 'Stage 2 timeout cleanup failed' }
$script:events.Clear(); $script:seq=0
$badLaunch=@{Run={ param($a,$t) throw 'synthetic exited process' }}
$r=Invoke-PhaseAStages $true $true $fake $badLaunch
if ($r -cne 'STAGE2_LAUNCH_FAILED' -or -not $script:events.Contains('remove:broker')) { throw 'Exited process failure was not handled' }
$script:events.Clear(); $script:seq=0
$badLaunch=@{Run={ param($a,$t) return $null }}
$r=Invoke-PhaseAStages $true $true $fake $badLaunch
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $script:events.Contains('remove:broker')) { throw 'Missing observation did not fail closed' }
$script:events.Clear(); $script:seq=0
$badLaunch=@{Run={ param($a,$t) throw 'STAGE2_CLEANUP_FAILED' }}
$r=Invoke-PhaseAStages $true $true $fake $badLaunch
if ($r -cne 'STAGE2_CLEANUP_FAILED' -or -not $script:events.Contains('remove:broker')) { throw 'Stage 2 cleanup failure was not reported' }
$script:events.Clear(); $script:seq=0
$badLaunch=@{Run={ param($a,$t) throw 'STAGE2_CHILD_UNCONFIRMED' }}
$r=Invoke-PhaseAStages $true $true $fake $badLaunch
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $script:events.Contains('close:broker') -or $script:events.Contains('remove:broker')) { throw 'Stage 2 unconfirmed child cleanup policy failed' }
$script:events.Clear(); $script:seq=0
if ((Invoke-PhaseAStages $false $true $fake $stage2fake) -cne 'STAGE2_GUARD_REJECTED' -or $script:events.Count -ne 0) { throw 'Stage 2 guard failed' }
$script:events.Clear(); $script:seq=0
$r=Invoke-PhaseAAccountGate $true $fake { throw 'STAGE2_CHILD_UNCONFIRMED' }
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $script:events.Contains('close:broker') -or $script:events.Contains('remove:broker')) { throw 'Unconfirmed child triggered unsafe cleanup' }
$script:events.Clear(); $script:seq=0
$r=Invoke-PhaseAAccountGate $false $fake { throw 'should not be invoked' }
if ($r -cne 'LIVE_DISABLED' -or $script:events.Count -ne 0) { throw 'Disabled gate invoked backend' }
$r=Invoke-PhaseAAccountGate $true $fake { param($accounts,$tokens) if ($accounts.Count -ne 2 -or $tokens.Count -ne 2) { throw 'missing accounts' } }
if ($r -cne 'STAGE1_COMPLETE' -or ($script:events -join ',') -cne 'create:broker,create:legacy,auth:broker,auth:legacy,close:legacy,close:broker,remove:legacy,remove:broker') { throw 'Lifecycle success or cleanup ordering failed' }
$script:events.Clear(); $script:seq=0
$broken=$fake.Clone(); $broken.Authenticate={ param($a) $script:events.Add("auth:$($a.role)"); if ($a.role -eq 'legacy') { throw 'secret must not escape' }; @{sid=$a.sid;primary=$true;admin=$false;elevated=$false;standard=$true;handle=$a.role} }
$r=Invoke-PhaseAAccountGate $true $broken { throw 'callback must not run' }
if ($r -cne 'ACCOUNT_AUTHENTICATION_FAILED' -or -not $script:events.Contains('close:broker') -or -not $script:events.Contains('remove:legacy') -or -not $script:events.Contains('remove:broker')) { throw 'Partial failure cleanup failed' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Authenticate={ param($a) @{sid=$a.sid;primary=$true;admin=$true;elevated=$false;standard=$true;handle=$a.role} }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'callback must not run' }
if ($r -cne 'ACCOUNT_IDENTITY_REJECTED' -or -not $script:events.Contains('close:broker') -or -not $script:events.Contains('remove:legacy')) { throw 'Administrative identity was not rejected and cleaned' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Remove={ param($a) $script:events.Add("remove:$($a.role)"); if ($a.role -eq 'legacy') { throw 'cleanup error' } }
$r=Invoke-PhaseAAccountGate $true $bad { }
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or -not $script:events.Contains('remove:broker')) { throw 'Cleanup failure did not fail closed' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Create={ param($role) $script:events.Add("create:$role"); @{role=$role;sid='S-1-5-21-1'} }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'callback must not run' }
if ($r -cne 'ACCOUNT_IDENTITY_REJECTED' -or -not $script:events.Contains('remove:legacy') -or -not $script:events.Contains('remove:broker')) { throw 'Duplicate SID accepted or not cleaned' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Authenticate={ param($a) @{sid='S-1-5-21-999';primary=$true;admin=$false;elevated=$false;standard=$true;handle=$a.role} }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'callback must not run' }
if ($r -cne 'ACCOUNT_IDENTITY_REJECTED' -or -not $script:events.Contains('close:broker')) { throw 'Wrong token SID accepted or not closed' }
foreach ($field in @('primary','standard')) {
  $script:events.Clear(); $script:seq=0
  $script:invalidField=$field
  $bad=$fake.Clone(); $bad.Authenticate={ param($a) $token=@{sid=$a.sid;primary=$true;admin=$false;elevated=$false;standard=$true;handle=$a.role}; $token[$script:invalidField]=$false; $token }
  $r=Invoke-PhaseAAccountGate $true $bad { throw 'callback must not run' }
  if ($r -cne 'ACCOUNT_IDENTITY_REJECTED' -or -not $script:events.Contains('close:broker')) { throw "Invalid $field token accepted or not closed" }
}
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Close={ param($token) $script:events.Add("close:$($token.handle)"); if ($token.handle -eq 'legacy') { throw 'close error' } }
$r=Invoke-PhaseAAccountGate $true $bad { }
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or -not $script:events.Contains('close:broker') -or -not $script:events.Contains('remove:broker')) { throw 'Token cleanup failure not handled' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Create={ param($role) if ($role -eq 'legacy') { throw 'synthetic create failure' }; $script:events.Add("create:$role"); @{role=$role;sid='S-1-5-21-1'} }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'callback must not run' }
if ($r -cne 'ACCOUNT_CREATION_FAILED' -or -not $script:events.Contains('remove:broker')) { throw 'Partial creation cleanup failed' }
$script:events.Clear(); $script:seq=0
$r=Invoke-PhaseAAccountGate $true $fake { throw 'synthetic consumer failure' }
if ($r -cne 'ACCOUNT_CONSUMER_FAILED' -or -not $script:events.Contains('close:legacy') -or -not $script:events.Contains('remove:broker')) { throw 'Consumer failure cleanup failed' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Authenticate={ param($a) throw (New-Object ComponentModel.Win32Exception(1385)) }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'must not run' }
if ($r -cne 'ACCOUNT_LOGON_RIGHT_UNAVAILABLE' -or -not $script:events.Contains('remove:legacy')) { throw 'Logon right failure classification failed' }
$script:events.Clear(); $script:seq=0
$bad=$fake.Clone(); $bad.Create={ param($role) throw (New-Object ComponentModel.Win32Exception(5)) }
$r=Invoke-PhaseAAccountGate $true $bad { throw 'must not run' }
if ($r -cne 'ACCOUNT_PRIVILEGE_UNAVAILABLE') { throw 'Privilege failure classification failed' }
Write-Output 'PASS account gate injected lifecycle and failure controls'
try {
  foreach ($mode in @("missing","valid-looking","invalid-with-optin")) {
    $report=Join-Path $base ("ether-phase-a-failclosed-" + [Guid]::NewGuid().ToString("N") + ".json")
    $reports += $report
    if ($mode -eq "valid-looking") {
      $env:GITHUB_REPOSITORY="andyle777/Ether-Memories"; $env:GITHUB_EVENT_NAME="push"
      $env:GITHUB_REF="refs/heads/test/t3-windows-enforcement-run"; $env:RUNNER_ENVIRONMENT="github-hosted"
      $env:GITHUB_SHA="0123456789abcdef0123456789abcdef01234567"
    } else {
      $env:GITHUB_REPOSITORY="";$env:GITHUB_EVENT_NAME="";$env:GITHUB_REF="";$env:RUNNER_ENVIRONMENT="";$env:GITHUB_SHA=""
    }
    $manager=Join-Path $PSScriptRoot "Invoke-PhaseA.ps1"
    $arguments=@(
      "-NoProfile","-NonInteractive","-File",('"' + $manager + '"'),
      "-RequiredBase","42f9b5bdf94e47c4c69c0f87127eb545dff13ed1","-OutputFile",('"' + $report + '"')
    )
    if ($mode -eq 'invalid-with-optin') { $arguments += '-EnableAccountStage' }
    $p=Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList $arguments
    if (-not $p.WaitForExit(15000)) { $p.Kill(); throw "Manager test timeout" }
    if ($p.ExitCode -ne 2) { throw "Incomplete manager did not fail closed" }
    $value=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    $expected=if ($mode -eq "valid-looking") { "CHECKOUT_REJECTED" } else { "CONFIGURATION_REJECTED" }
    $names=@($value.PSObject.Properties.Name)
    if ($names.Count -ne 8 -or $value.status -cne "UNVERIFIED" -or
        $value.schema -cne "ether.t3.phase-a.observations.v1" -or $value.reason -cne $expected -or
        @($value.cases.PSObject.Properties.Name).Count -ne 22 -or $value.cases.adversarialControls -cne 'NOT_RUN' -or
        $value.cases.supervisorFailure -cne 'NOT_RUN' -or $value.verdict.provenance -cne 'UNVERIFIED' -or $value.verdict.cases.actorPidBinding.state -cne 'NOT_RUN') { throw "Invalid failure report" }
  }
  Write-Output "PASS invalid and valid-looking context remain UNVERIFIED with sanitized report"
} finally {
  foreach($report in $reports) { if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force } }
}
. "$PSScriptRoot/PhaseA.Stage2.ps1"
$controls=Invoke-PhaseAAdversarialControls
$required=@('wrongSid','sameSid','wrongPid','wrongCreationTime','forgedObservation','malformedObservation','missingObservation','wrongJob','unexpectedSuccess','wrongDenial','missingDenial')
if ($controls.kind -cne 'injected' -or $controls.cases.Count -ne $required.Count) { throw 'Invalid adversarial result' }
foreach ($name in $required) { if (-not $controls.cases.ContainsKey($name) -or $controls.cases[$name] -isnot [bool] -or -not $controls.cases[$name]) { throw "Adversarial control failed: $name" } }
Write-Output 'PASS injected adversarial observation controls (11)'
if ((Get-PhaseAAdversarialStatus $controls) -cne 'SIMULATED_PASS') { throw 'Simulated result not classified' }
$badControls=@{kind='injected';cases=$controls.cases.Clone()}; $badControls.cases.Remove('wrongJob')
if ((Get-PhaseAAdversarialStatus $badControls) -cne 'FAIL') { throw 'Missing control accepted' }
$badControls=@{kind='hosted';cases=$controls.cases.Clone()}
if ((Get-PhaseAAdversarialStatus $badControls) -cne 'FAIL') { throw 'Wrong evidence kind accepted' }
Write-Output 'PASS adversarial evidence classification (3)'
$simulated=$reportTest.Clone(); $simCases=$reportCases.Clone(); $simCases.adversarialControls='SIMULATED_PASS'; $simulated.cases=$simCases
if (-not (Test-PhaseAObservationReport $simulated)) { throw 'Correctly labeled simulated evidence rejected' }
$simCases.supervisorFailure='SIMULATED_PASS'
if (Test-PhaseAObservationReport $simulated) { throw 'Misplaced simulated evidence accepted' }
$probe={ return $true }
$supervision=Invoke-PhaseASupervisorEvidence $probe
if ($supervision.injected -cne 'SIMULATED_PASS' -or $supervision.sameIdentity -cne 'SAME_IDENTITY_PASS') { throw 'Supervisor evidence classification failed' }
$supervision=Invoke-PhaseASupervisorEvidence { return $false }
if ($supervision.sameIdentity -cne 'FAIL') { throw 'Failed local probe accepted' }
Write-Output 'PASS supervisor evidence classification (2)'
foreach ($op in @('Delete','Rename')) {
  $script:created3=$false; $script:attemptOp=$op
  $unexpected=@{Run={ param($a,$t,$operation,$target) $v=& $script:stage3Run $a $t $operation $target; if ($a.role -ceq 'legacy' -and $operation -ceq $script:attemptOp) { $v.outcome='allowed'; $v.exitCode=0 }; $v } }
  $r=Invoke-PhaseAStage3 $accounts3 $tokens3 $stage3fixture $unexpected
  if ($r.status -ceq 'STAGE3_COMPLETE') { throw "Unexpected $op success accepted" }
}
Write-Output 'PASS proposed delete and rename unexpected-success rejection (2)'
. "$PSScriptRoot/PhaseA.HostedSupervision.ps1"
$fakeHosted=@{Run={param($account,$token,$mode) @{outcome='OBSERVED';identity=$true;pid=$true;creationTime=$true;membership=$true;childTerminated=$true;supervisorTerminated=$true;cleanup=$true;timeoutObserved=$true} }}
$sv=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1';role='broker'} @{sid='S-1-5-21-1'} $fakeHosted 'INJECTED'
if ($sv.status -cne 'SIMULATED_PASS' -or $sv.cases.Count -ne 3) { throw 'Hosted supervisor injected success failed' }
$fakeHosted.Run={param($account,$token,$mode) @{outcome='OBSERVED';identity=$true;pid=$true;creationTime=$true;membership=$true;childTerminated=$false;supervisorTerminated=$true;cleanup=$true;timeoutObserved=$true} }
$sv=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1';role='broker'} @{sid='S-1-5-21-1'} $fakeHosted 'INJECTED'
if ($sv.status -cne 'FAIL' -or $sv.cases.supervisorDeath.reason -cne 'CHILD_SURVIVED') { throw 'Surviving supervisor child accepted' }
Write-Output 'PASS hosted supervisor injected orchestration (2)'
$hostedGood=@{Run={param($account,$token,$mode) @{outcome='OBSERVED';identity=$true;pid=$true;creationTime=$true;membership=$true;childTerminated=$true;supervisorTerminated=$true;cleanup=$true;timeoutObserved=$true} }}
$script:events.Clear(); $script:seq=0; $liveResult=@{}
$r=Invoke-PhaseAStages $true $true $fake $stage3actors $false @{} @{} $true $hostedGood $liveResult
if ($r -cne 'STAGE2_COMPLETE' -or $liveResult.cases.timeout.status -cne 'LIVE_OBSERVED' -or -not $script:events.Contains('remove:broker')) { throw 'Manager supervisor dispatch failed' }
foreach ($pair in @(@('identity','IDENTITY_MISMATCH'),@('pid','PID_MISMATCH'),@('creationTime','TIME_MISMATCH'),@('membership','JOB_MISMATCH'),@('supervisorTerminated','SUPERVISOR_SURVIVED'),@('cleanup','CLEANUP_FAILED'),@('timeoutObserved','TIMEOUT_NOT_OBSERVED'))) {
  $script:badSupervisorField=$pair[0]
  $bad=@{Run={param($a,$t,$mode) $v=@{outcome='OBSERVED';identity=$true;pid=$true;creationTime=$true;membership=$true;childTerminated=$true;supervisorTerminated=$true;cleanup=$true;timeoutObserved=$true}; $v[$script:badSupervisorField]=$false; $v }}
  $v=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $bad 'INJECTED'
  $entry=if ($pair[0] -ceq 'timeoutObserved') { $v.cases.timeout } else { $v.cases.supervisorDeath }
  if ($v.status -cne 'FAIL' -or $entry.reason -cne $pair[1]) { throw "Supervisor failure not classified: $($pair[0])" }
}
$bad=@{Run={param($a,$t,$mode) throw 'STAGE2_CHILD_UNCONFIRMED'}}
$script:events.Clear(); $script:seq=0
$r=Invoke-PhaseAStages $true $true $fake $stage3actors $false @{} @{} $true $bad @{}
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $script:events.Contains('remove:broker')) { throw 'Unconfirmed supervisor child was not fail-closed' }
Write-Output 'PASS manager-connected supervisor controls and failure categories (9)'
$script:events.Clear(); $script:seq=0; $uncertain=@{}
$r=Invoke-PhaseAStages $true $true $fake $stage3actors $false @{} @{} $true $bad $uncertain
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $uncertain.cases.supervisorDeath.reason -cne 'CHILD_UNCONFIRMED') { throw 'Unconfirmed child reason lost' }
$malformed=$reportTest.Clone(); $malformed.supervisorCases=@{}
if (Test-PhaseAObservationReport $malformed) { throw 'Missing supervisor observations accepted' }
$malformed=$reportTest.Clone(); $badCases=$supervisorCases.Clone(); $badCases.timeout=@{status='LIVE_OBSERVED';reason='NOT_RUN';evidence='LIVE'}; $malformed.supervisorCases=$badCases
if (Test-PhaseAObservationReport $malformed) { throw 'Invalid supervisor status and reason accepted' }
Write-Output 'PASS supervisor report fail-closed controls (3)'
$missingHosted=@{Run={param($a,$t,$mode) $null}}
$v=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $missingHosted 'INJECTED'
if ($v.status -cne 'FAIL' -or $v.cases.supervisorDeath.reason -cne 'MISSING_OBSERVATION' -or $v.cases.jobClosure.status -cne 'NOT_RUN') { throw 'Missing observation accepted' }
$badReason=@{Run={param($a,$t,$mode) @{outcome='FAILED';reason='LAUNCH_FAILED'}}}
$v=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $badReason 'INJECTED'
if ($v.status -cne 'FAIL' -or $v.cases.supervisorDeath.reason -cne 'LAUNCH_FAILED') { throw 'Launch failure reason lost' }
$badReason.Run={param($a,$t,$mode) @{outcome='FAILED';reason='untrusted details'}}
$v=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $badReason 'INJECTED'
if ($v.cases.supervisorDeath.reason -cne 'MISSING_OBSERVATION') { throw 'Untrusted failure detail accepted' }
Write-Output 'PASS missing, launch and untrusted supervisor reports (3)'
. "$PSScriptRoot/PhaseA.Verdict.ps1"
. "$PSScriptRoot/PhaseA.Evidence.ps1"
$actorJournal=New-Object 'System.Collections.Generic.List[object]'
$journalBackend=New-PhaseAActorJournalBackend $stage2fake $actorJournal
if ((Invoke-PhaseAStage2 $ac $tk $journalBackend) -cne 'STAGE2_COMPLETE' -or $actorJournal.Count -ne 2) { throw 'Actor journal backend did not capture returned observations' }
$unproven=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $unproven $actorJournal.ToArray() 'SIMULATED_PASS'
if ($unproven.cases.brokerActorBinding.state -cne 'NOT_RUN') { throw 'Stage COMPLETE alone generated evidence' }
Write-Output 'PASS manager-connected journal and incomplete-stage control (2)'
$fullJournal=New-Object 'System.Collections.Generic.List[object]'; $journalBackend=New-PhaseAActorJournalBackend $stage3actors $fullJournal
$script:events.Clear(); $script:seq=0; $script:created3=$false
$r=Invoke-PhaseAStages $true $true $fake $journalBackend $true $stage3fixture @{}
$mapped=New-PhaseAManagerVerdictInput ('1'*40) '123'; Add-PhaseAActorEvidence $mapped $fullJournal.ToArray() 'SIMULATED_PASS'
if ($r -cne 'STAGE3_COMPLETE' -or $fullJournal.Count -ne 11 -or $mapped.cases.brokerActorBinding.state -cne 'PASS' -or $mapped.cases.unauthorizedRead.state -cne 'NOT_RUN') { throw 'Full actor journal bridge failed' }
Write-Output 'PASS full injected stage path records bounded actor evidence'
$complete=New-PhaseAManagerVerdictInput ('1'*40) '123'
foreach ($key in @(Get-PhaseAVerdictPolicy)) { $complete.cases[$key]=@{state='PASS';evidence='LIVE_OBSERVED';reason='NONE';proof=('a'*64)} }
$final=@{schema='ether.t3.phase-a.final.v1';policy='phase-a-core-provisional-v1';repository='andyle777/Ether-Memories';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted';commit=('1'*40);runId='123';runAttempt='1';status='GREEN';reason='ALL_MANDATORY_CONTROLS_VERIFIED';cleanup='COMPLETE';provenance='VERIFIED';cases=$complete.cases}
$top=$reportTest.Clone(); $top.commit=('1'*40); $top.status='GREEN'; $top.reason='VERDICT_GREEN'; $top.verdict=$final
$top.cases=$reportCases.Clone(); foreach ($key in @('accountIdentity','brokerIdentity','legacyIdentity','actorIdentity','containment','acl','authorizedRead','authorizedCreate','authorizedReadback','unauthorizedRead','unauthorizedWrite','unauthorizedCreate','inventory','insecureRejected','processCleanup','fixtureCleanup','accountCleanup')) { $top.cases[$key]='PASS' }
$top.supervisorCases=@{}; foreach ($mode in @('supervisorDeath','jobClosure','timeout')) { $top.supervisorCases[$mode]=@{status='LIVE_OBSERVED';evidence='LIVE';reason='NONE'} }
$trustFake={param($kind,$entry,$record) return $true}
if (-not (Test-PhaseAObservationReport $top $trustFake)) { throw 'Complete synthetic GREEN report rejected' }
if (Test-PhaseAObservationReport $top) { throw 'GREEN accepted without trusted verifier' }
$top.cases.actorIdentity='NOT_RUN'
if (Test-PhaseAObservationReport $top $trustFake) { throw 'GREEN accepted with missing actor observation' }
Write-Output 'PASS nested GREEN report consistency controls (3)'
$redNested=$final.Clone(); $redNested.cases=@{}; foreach ($key in $final.cases.Keys) { $redNested.cases[$key]=$final.cases[$key].Clone() }; $redNested.cases.unauthorizedWrite.state='FAIL'; $redNested.cases.unauthorizedWrite.reason='VIOLATION'; $redNested.status='RED'; $redNested.reason='MANDATORY_CONTROL_FAILED'
$redTop=$top.Clone(); $redTop.status='RED'; $redTop.reason='VERDICT_RED'; $redTop.verdict=$redNested
if (-not (Test-PhaseAObservationReport $redTop $trustFake)) { throw 'Verified synthetic RED report rejected' }
$badRed=$redTop.Clone(); $badRed.status='GREEN'; $badRed.reason='VERDICT_GREEN'
if (Test-PhaseAObservationReport $badRed $trustFake) { throw 'RED evidence accepted as GREEN' }
Write-Output 'PASS nested RED report consistency controls (2)'
. "$PSScriptRoot/PhaseA.Evidence.ps1"
$script:events.Clear(); $script:seq=0
$tokenJournal=New-Object 'System.Collections.Generic.List[object]'
$wrappedAccount=New-PhaseATokenJournalBackend $fake $tokenJournal { param($token) return @{sid=$token.sid;primary=$true;admin=$false;elevated=$false;standard=$true;handleOpen=$true} }
$r=Invoke-PhaseAStages $true $true $wrappedAccount $stage2fake
if ($r -cne 'STAGE2_COMPLETE' -or $tokenJournal.Count -ne 2 -or -not $tokenJournal[0].closed -or -not $tokenJournal[1].closed) { throw 'Manager-connected token journal did not retain inspection and closure' }
$script:events.Clear(); $script:seq=0
$tokenJournal=New-Object 'System.Collections.Generic.List[object]'
$wrappedAccount=New-PhaseATokenJournalBackend $fake $tokenJournal { param($token) throw 'inspection failed' }
$r=Invoke-PhaseAStages $true $true $wrappedAccount $stage2fake
if ($r -cne 'ACCOUNT_AUTHENTICATION_FAILED' -or -not $script:events.Contains('close:broker') -or $tokenJournal.Count -ne 0) { throw 'Failed inspection leaked token or recorded proof' }
Write-Output 'PASS manager-connected token inspection and failure cleanup (2)'
$script:events.Clear(); $script:seq=0
$tokenJournal=New-Object 'System.Collections.Generic.List[object]'
$closeFailure=$fake.Clone(); $closeFailure.Close={ param($token) throw 'injected close failure' }
$wrappedAccount=New-PhaseATokenJournalBackend $closeFailure $tokenJournal { param($token) return @{sid=$token.sid;primary=$true;admin=$false;elevated=$false;standard=$true;handleOpen=$true} }
$r=Invoke-PhaseAStages $true $true $wrappedAccount $stage2fake
if ($r -cne 'ACCOUNT_CLEANUP_FAILED' -or $tokenJournal[0].closed -or $tokenJournal[1].closed) { throw 'Failed handle cleanup was recorded as successful' }
Write-Output 'PASS token handle cleanup failure remains unconfirmed'
$lifeSink=@{}
$lifeBackend=@{Run={param($account,$token,$mode) @{outcome='OBSERVED';identity=$true;pid=$true;creationTime=$true;membership=$true;childTerminated=$true;supervisorTerminated=$true;cleanup=$true;timeoutObserved=$true;processLifetime=@{mode=$mode;source='INJECTED';jobLimitFlags=8192;handleCountBeforeClose=1;lastHandleVerified=$false}} }}
$life=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $lifeBackend 'INJECTED' $lifeSink
if (-not $lifeSink.ContainsKey('processLifetime') -or $lifeSink.processLifetime.Count -ne 3) { throw 'Supervisor process lifetime observations not retained' }
if ($lifeSink.processLifetime.jobClosure.source -cne 'INJECTED' -or $lifeSink.processLifetime.jobClosure.lastHandleVerified) { throw 'Simulated or unconfirmed last-handle evidence misclassified' }
Write-Output 'PASS injected supervisor lifetime evidence retention'
$lifeSink=@{}
$unconfirmed=@{Run={param($account,$token,$mode) throw 'STAGE2_CHILD_UNCONFIRMED'}}
try { $null=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $unconfirmed 'INJECTED' $lifeSink; throw 'Unconfirmed child was accepted' } catch { if ($_.Exception.GetBaseException().Message -cne 'STAGE2_CHILD_UNCONFIRMED') { throw } }
if (-not $lifeSink.processLifetime.ContainsKey('supervisorDeath') -or $lifeSink.processLifetime.supervisorDeath.error -cne 'CHILD_UNCONFIRMED') { throw 'Unconfirmed child failure was not retained' }
Write-Output 'PASS unconfirmed child failure retained'
. "$PSScriptRoot/PhaseA.Oidc.ps1"
$policyInput=New-PhaseAManagerVerdictInput ('1'*40) '123'
$proofVerifier=New-PhaseAEvidenceVerifier @() $policyInput '1' $true $true 'SIMULATED_PASS'
foreach ($control in @('jobContainment','jobClosure','childTermination','processCleanup')) {
 if (& $proofVerifier $control @{state='PASS';evidence='LIVE_OBSERVED';reason='NONE';proof=('a'*64)} $policyInput) { throw "Unverified lifetime proof accepted: $control" }
}
Write-Output 'PASS incomplete lifetime observations cannot satisfy verdict controls (4)'
$partialSink=@{}
$partialBackend=@{Run={param($a,$t,$mode) $e=New-Object InvalidOperationException('STAGE2_CHILD_UNCONFIRMED');$e.Data['PhaseAProcessLifetime']=@{mode=$mode;childWaitOutcome='TIMEOUT';childAliveAfterWait=$true;cleanupSucceeded=$false};throw $e}}
try {$null=Invoke-PhaseAHostedSupervision @{sid='S-1-5-21-1'} @{sid='S-1-5-21-1'} $partialBackend 'INJECTED' $partialSink;throw 'Expected unconfirmed child'} catch {if($_.Exception.GetBaseException().Message -cne 'STAGE2_CHILD_UNCONFIRMED'){throw}}
if ($partialSink.processLifetime.supervisorDeath.childWaitOutcome -cne 'TIMEOUT' -or -not $partialSink.processLifetime.supervisorDeath.childAliveAfterWait -or $partialSink.processLifetime.supervisorDeath.cleanupSucceeded) {throw 'Original unconfirmed-child observation was discarded'}
Write-Output 'PASS retained original unconfirmed-child observation'
$script:created3=$false
$evidenceFixture=$stage3fixture.Clone();$evidenceFixture.DirectoryExists={param($path) $true};$evidenceFixture.CleanupVerified={param($f) $true}
$evidenceActors=$stage3actors.Clone();$script:baseEvidenceRun=$stage3actors.Run
$evidenceActors.Run={param($a,$t,$op,$target) $v=& $script:baseEvidenceRun $a $t $op $target;$v.errorCategory=if($v.outcome -ceq 'denied'){'ACCESS_DENIED'}else{'NONE'};$v}
$evidenceFixture.Setup={param($a) @{protectedFile='existing';protectedDir='protected';newFile='new';deniedFile='missing';controlFile='control';initialDigest=('a'*64);writeDigest=('b'*64);aclInspected=$true;aclEvidence=@{expected='test';actual='test';protected=$true}}}
$e=Invoke-PhaseAStage3 $accounts3 $tokens3 $evidenceFixture $evidenceActors
if (-not $e.ContainsKey('evidence') -or -not $e.evidence.ContainsKey('unauthorizedRead')) {throw 'Stage 3 operation evidence missing'}
if ($e.evidence.unauthorizedRead.observation.errorCategory -cne 'ACCESS_DENIED' -or -not $e.evidence.cleanupVerified) {throw 'Stage 3 evidence classification or cleanup missing'}
Write-Output 'PASS Stage 3 injected operation evidence retention'
$script:events.Clear();$script:seq=0;$script:created3=$false;$script:didWrite=$false
$journalFixture=$evidenceFixture.Clone();$journalFixture.Inventory={param($f) if($script:didWrite){'c'*64}else{'b'*64}}
$script:baseEvidenceRun=$stage3actors.Run
$violationActors=@{Run={param($a,$t,$op,$target) $v=& $script:baseEvidenceRun $a $t $op $target;if($a.role -ceq 'legacy' -and $op -ceq 'Overwrite'){$v.outcome='allowed';$v.exitCode=0;$script:didWrite=$true};$v.errorCategory=if($v.outcome -ceq 'denied'){'ACCESS_DENIED'}else{'NONE'};$v.errorCode=if($v.outcome -ceq 'denied'){5}else{0};$v}}
$operationJournal=New-Object 'System.Collections.Generic.List[object]';$wrappedActors=New-PhaseAActorJournalBackend $violationActors $operationJournal;$stageResult=@{}
$stage=Invoke-PhaseAStages $true $true $fake $wrappedActors $true $journalFixture $stageResult
if($stage -cne 'STAGE3_CASE_FAILED' -or -not $stageResult.ContainsKey('evidence')){throw 'Stage 3 manager did not retain failed operation evidence'}
$v=New-PhaseAManagerVerdictInput ('1'*40) '123';Add-PhaseAStage3Evidence $v $stageResult.evidence 'SIMULATED_PASS' $operationJournal.ToArray()
if($v.cases.unauthorizedWrite.state -cne 'FAIL'){throw 'Manager-connected violation did not reach provisional adapter'}
Write-Output 'PASS Stage 3 manager retains and maps injected write violation'
