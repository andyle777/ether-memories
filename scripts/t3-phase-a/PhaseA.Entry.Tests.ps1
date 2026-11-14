$ErrorActionPreference = "Stop"
$base=[IO.Path]::GetTempPath()
$reports=@()
. "$PSScriptRoot/PhaseA.Accounts.ps1"
. "$PSScriptRoot/PhaseA.Stage2.ps1"
$script:stage2seen=New-Object 'System.Collections.Generic.List[string]'
$stage2fake=@{ Run={ param($account,$token) $script:stage2seen.Add("$($account.role):$($token.handle)"); @{ expectedSid=$account.sid; observedSid=$account.sid; reportedSid=$account.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=0; outcome='allowed'; role=$account.role; contained=$true; terminated=$true } } }
$ac=@(@{role='broker';sid='S-1-5-21-1'},@{role='legacy';sid='S-1-5-21-2'})
$tk=@(@{handle='broker';sid='S-1-5-21-1'},@{handle='legacy';sid='S-1-5-21-2'})
if ((Invoke-PhaseAStage2 $ac $tk $stage2fake) -cne 'STAGE2_COMPLETE' -or ($script:stage2seen -join ',') -cne 'broker:broker,legacy:legacy') { throw 'Stage 2 token binding failed' }
$wrong=$stage2fake.Clone(); $wrong.Run={ param($account,$token) @{ role=$account.role; expectedSid=$account.sid; observedSid='S-1-5-21-9'; reportedSid=$account.sid; expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true; createdAt='2026-01-01T00:00:00Z'; observedCreatedAt='2026-01-01T00:00:00Z'; expectedNonce='nonce'; reportedNonce='nonce'; exitCode=0; outcome='allowed'; contained=$true; terminated=$true } }
if ((Invoke-PhaseAStage2 $ac $tk $wrong) -cne 'STAGE2_OBSERVATION_REJECTED') { throw 'Stage 2 wrong SID accepted' }
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
    if ($names.Count -ne 3 -or $value.status -cne "UNVERIFIED" -or
        $value.schema -cne "ether.t3.phase-a.failure.v1" -or $value.reason -cne $expected) { throw "Invalid failure report" }
  }
  Write-Output "PASS invalid and valid-looking context remain UNVERIFIED with sanitized report"
} finally {
  foreach($report in $reports) { if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force } }
}
