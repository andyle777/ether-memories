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
      $backend=New-PhaseAWindowsAccountBackend
      $launchBackend=if ($EnableActorStage) { New-PhaseAStage2Backend } else { @{} }
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
# The existing stages do not retain independent per-control proof, and the
# environment variables cannot establish workflow provenance. The production
# verifier therefore denies until a trusted evidence adapter is implemented.
$runId=[Environment]::GetEnvironmentVariable('GITHUB_RUN_ID')
$verdictInput=New-PhaseAManagerVerdictInput $commit $runId
$verdict=Get-PhaseAVerdict $verdictInput { param($kind,$entry,$record) return $false }
$report = [ordered]@{ schema='ether.t3.phase-a.observations.v1'; status=$verdict.status; source='42f9b5bdf94e47c4c69c0f87127eb545dff13ed1'; commit=$commit; reason=$reason; cases=$cases; supervisorCases=$supervisorCases }
if (-not (Test-PhaseAObservationReport $report)) { Write-Error 'Sanitized Phase A report validation failed.'; exit 2 }
try {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Compress))
  $stream=[IO.File]::Open($OutputFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
} catch {
  Write-Error "Sanitized Phase A failure report could not be created."
  exit 2
}
Write-Output "Phase A $($verdict.status): $reason"
exit (Get-PhaseAExitCode $verdict.status)
