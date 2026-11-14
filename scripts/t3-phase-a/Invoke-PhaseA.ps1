[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$RequiredBase,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [switch]$EnableAccountStage,
  [switch]$EnableActorStage,
  [switch]$EnableFilesystemStage,
  [switch]$EnableSupervisorProbe
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Core.ps1"
. "$PSScriptRoot/PhaseA.Verdict.ps1"
. "$PSScriptRoot/PhaseA.Evidence.ps1"
. "$PSScriptRoot/PhaseA.Oidc.ps1"
. "$PSScriptRoot/PhaseA.Accounts.ps1"
. "$PSScriptRoot/PhaseA.Stage2.ps1"
. "$PSScriptRoot/PhaseA.Stage3.ps1"
$config = @{
  repository=[Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY")
  event=[Environment]::GetEnvironmentVariable("GITHUB_EVENT_NAME")
  ref=[Environment]::GetEnvironmentVariable("GITHUB_REF")
  runner=[Environment]::GetEnvironmentVariable("RUNNER_ENVIRONMENT")
  sha=[Environment]::GetEnvironmentVariable("GITHUB_SHA")
  base=$RequiredBase
}
$repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$tokenJournal=New-Object 'System.Collections.Generic.List[object]'
$actorJournal=New-Object 'System.Collections.Generic.List[object]'
$stage3Result=@{}; $hostedResult=@{}; $stage=$null; $adversarialStatus='NOT_RUN'; $supervision=@{injected='NOT_RUN';sameIdentity='NOT_RUN'}
$reason = if (-not (Test-PhaseAConfig $config)) { "CONFIGURATION_REJECTED" }
  elseif (-not (Test-PhaseACheckout $repository $config.sha $RequiredBase)) { "CHECKOUT_REJECTED" }
  elseif (($adversarialStatus=Get-PhaseAAdversarialStatus (Invoke-PhaseAAdversarialControls)) -ceq 'FAIL') { 'ADVERSARIAL_CONTROL_FAILED' }
  elseif ($EnableSupervisorProbe -and (($supervision=Invoke-PhaseASupervisorEvidence { try { $null=& (Join-Path $PSScriptRoot 'PhaseA.Job.Tests.ps1') } catch { throw 'SUPERVISOR_JOB_PROBE_FAILED' }; try { $null=& (Join-Path $PSScriptRoot 'PhaseA.Supervisor.Tests.ps1') } catch { throw 'SUPERVISOR_DEATH_PROBE_FAILED' }; return $true }).sameIdentity -cne 'SAME_IDENTITY_PASS' -or $supervision.injected -cne 'SIMULATED_PASS')) { $supervision.reason }
  elseif ($EnableAccountStage -and -not $EnableSupervisorProbe) { 'SUPERVISOR_PROBE_REQUIRED' }
  elseif ($EnableFilesystemStage -and (-not $EnableAccountStage -or -not $EnableActorStage)) { 'STAGE3_GUARD_REJECTED' }
  elseif ($EnableActorStage -and -not $EnableAccountStage) { 'STAGE2_GUARD_REJECTED' }
  elseif (-not $EnableAccountStage) { "IMPLEMENTATION_INCOMPLETE" }
  else {
    try {
      $backend=New-PhaseATokenJournalBackend (New-PhaseAWindowsAccountBackend) $tokenJournal { param($token)
        $open= -not $token.handle.IsClosed -and -not $token.handle.IsInvalid
        $v=[EtherPhaseAAccountNative]::Inspect($token.handle)
        return @{sid=$v.sid;primary=$v.primary;admin=$v.admin;elevated=$v.elevated;standard=$v.standard;handleOpen=[bool]$open}
      }
      $launchBackend=if ($EnableActorStage) { New-PhaseAActorJournalBackend (New-PhaseAStage2Backend) $actorJournal } else { @{} }
      $fixtureBackend=if ($EnableFilesystemStage) { New-PhaseAStage3Backend } else { @{} }
      $supervisorBackend=if ($EnableActorStage) { New-PhaseAHostedSupervisorBackend } else { @{} }
      $stage=Invoke-PhaseAStages $true ([bool]$EnableActorStage) $backend $launchBackend ([bool]$EnableFilesystemStage) $fixtureBackend $stage3Result ([bool]$EnableActorStage) $supervisorBackend $hostedResult
      if ($stage -in @('STAGE1_COMPLETE','STAGE2_COMPLETE','STAGE3_COMPLETE')) { 'IMPLEMENTATION_INCOMPLETE' } else { $stage }
    } catch { 'ACCOUNT_MANAGEMENT_UNAVAILABLE' }
  }
$cases=[ordered]@{ accountIdentity='NOT_RUN'; brokerIdentity='NOT_RUN'; legacyIdentity='NOT_RUN'; actorIdentity='NOT_RUN'; containment='NOT_RUN'; acl='NOT_RUN';
  authorizedRead='NOT_RUN'; authorizedCreate='NOT_RUN'; authorizedReadback='NOT_RUN'; unauthorizedRead='NOT_RUN';
  unauthorizedWrite='NOT_RUN'; unauthorizedCreate='NOT_RUN'; proposedDelete='NOT_RUN'; proposedRename='NOT_RUN'; inventory='NOT_RUN'; insecureRejected='NOT_RUN';
  processCleanup='NOT_RUN'; fixtureCleanup='NOT_RUN'; accountCleanup='NOT_RUN'; adversarialControls='NOT_RUN'; supervisorInjected='NOT_RUN'; supervisorFailure='NOT_RUN' }
$cases.adversarialControls=$adversarialStatus; $cases.supervisorInjected=$supervision.injected; $cases.supervisorFailure=$supervision.sameIdentity
if ($stage -in @('STAGE1_COMPLETE','STAGE2_COMPLETE','STAGE3_COMPLETE')) { $cases.accountIdentity='PASS'; $cases.brokerIdentity='PASS'; $cases.legacyIdentity='PASS'; $cases.accountCleanup='PASS' }
if ($stage -in @('STAGE2_COMPLETE','STAGE3_COMPLETE')) { $cases.actorIdentity='PASS'; $cases.containment='PASS'; $cases.processCleanup='PASS' }
if ($stage -ceq 'ACCOUNT_CLEANUP_FAILED') { $cases.accountCleanup='FAIL' }
if ($stage3Result.ContainsKey('cases')) {
  foreach ($key in @('acl','authorizedRead','authorizedCreate','authorizedReadback','unauthorizedRead','unauthorizedWrite','unauthorizedCreate','proposedDelete','proposedRename','inventory','insecureRejected','fixtureCleanup')) {
    if ($stage3Result.cases.ContainsKey($key) -and $stage3Result.cases[$key] -ceq $true) { $cases[$key]='PASS' }
  }
}
$commit=if ($config.sha -cmatch '^[0-9a-f]{40}$') { $config.sha } else { 'unknown' }
$supervisorCases=@{}
foreach ($mode in @('supervisorDeath','jobClosure','timeout')) { $supervisorCases[$mode]=@{status='NOT_RUN';evidence='LIVE';reason='NOT_RUN'} }
if ($hostedResult.ContainsKey('cases')) { $supervisorCases=$hostedResult.cases }
# Only the actor journal has an evidence adapter. Other controls remain
# NOT_RUN until their independent producers are connected.
$runId=[Environment]::GetEnvironmentVariable('GITHUB_RUN_ID')
$runRef=if ($runId -cmatch '^[1-9][0-9]{0,19}$') { $runId } else { 'unknown' }
$attemptRaw=[Environment]::GetEnvironmentVariable('GITHUB_RUN_ATTEMPT'); $attempt=if ($attemptRaw -cmatch '^[1-9][0-9]{0,9}$') { $attemptRaw } else { 'unknown' }
$verdictInput=New-PhaseAManagerVerdictInput $commit $runRef
Add-PhaseAActorEvidence $verdictInput $actorJournal.ToArray() 'LIVE_OBSERVED'
Add-PhaseAPrimaryTokenEvidence $verdictInput $tokenJournal.ToArray() $actorJournal.ToArray() 'LIVE_OBSERVED'
$liveExecutionRequested=[bool]($EnableAccountStage -and $EnableActorStage -and $EnableFilesystemStage -and $EnableSupervisorProbe -and $null -ne $stage)
$provenanceVerified=$false
if ($liveExecutionRequested -and $runRef -cne 'unknown' -and $attempt -cne 'unknown' -and $commit -cne 'unknown') { $provenanceVerified=Test-PhaseAGitHubOidcProvenance $verdictInput $attempt }
# Signed run provenance and explicit switches do not themselves prove owner approval.
$ownerAuthorizationVerified=$false
$evidenceVerifier=New-PhaseAEvidenceVerifier $actorJournal.ToArray() $verdictInput $attempt $provenanceVerified $ownerAuthorizationVerified 'LIVE_OBSERVED' $tokenJournal.ToArray()
$verdict=Get-PhaseAVerdict $verdictInput $evidenceVerifier
if ($verdict.status -ceq 'GREEN') { $reason='VERDICT_GREEN' }
elseif ($verdict.status -ceq 'RED') { $reason='VERDICT_RED' }
$expectedWorkflow='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run'
$workflowRaw=[Environment]::GetEnvironmentVariable('GITHUB_WORKFLOW_REF'); $workflowRef=if ($workflowRaw -ceq $expectedWorkflow) { $workflowRaw } else { 'unknown' }
$finalReport=@{schema='ether.t3.phase-a.final.v1';policy='phase-a-core-provisional-v1';repository=$(if ($config.repository -ceq 'andyle777/Ether-Memories') {$config.repository} else {'unknown'});workflowRef=$workflowRef;ref=$(if ($config.ref -ceq 'refs/heads/test/t3-windows-enforcement-run') {$config.ref} else {'unknown'});event=$(if ($config.event -ceq 'push') {$config.event} else {'unknown'});runner=$(if ($config.runner -ceq 'github-hosted') {$config.runner} else {'unknown'});commit=$commit;runId=$runRef;runAttempt=$attempt;status=$verdict.status;reason=$verdict.reason;cleanup='NOT_RUN';provenance=$(if ($provenanceVerified) {'VERIFIED'} else {'UNVERIFIED'});cases=$verdictInput.cases}
if ($stage -ceq 'ACCOUNT_CLEANUP_FAILED') { $finalReport.cleanup='UNCONFIRMED' }
$report = [ordered]@{ schema='ether.t3.phase-a.observations.v1'; status=$verdict.status; source='42f9b5bdf94e47c4c69c0f87127eb545dff13ed1'; commit=$commit; reason=$reason; cases=$cases; supervisorCases=$supervisorCases; verdict=$finalReport }
if (-not (Test-PhaseAObservationReport $report $evidenceVerifier)) { Write-Error 'Sanitized Phase A report validation failed.'; exit 2 }
try {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Compress -Depth 8))
  $stream=[IO.File]::Open($OutputFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
} catch {
  Write-Error "Sanitized Phase A failure report could not be created."
  exit 2
}
Write-Output "Phase A $($verdict.status): $reason"
exit (Get-PhaseAExitCode $verdict.status)
