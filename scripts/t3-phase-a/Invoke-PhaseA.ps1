[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$RequiredBase,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [switch]$EnableAccountStage,
  [switch]$EnableActorStage
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Core.ps1"
. "$PSScriptRoot/PhaseA.Accounts.ps1"
. "$PSScriptRoot/PhaseA.Stage2.ps1"
$config = @{
  repository=[Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY")
  event=[Environment]::GetEnvironmentVariable("GITHUB_EVENT_NAME")
  ref=[Environment]::GetEnvironmentVariable("GITHUB_REF")
  runner=[Environment]::GetEnvironmentVariable("RUNNER_ENVIRONMENT")
  sha=[Environment]::GetEnvironmentVariable("GITHUB_SHA")
  base=$RequiredBase
}
$repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$reason = if (-not (Test-PhaseAConfig $config)) { "CONFIGURATION_REJECTED" }
  elseif (-not (Test-PhaseACheckout $repository $config.sha $RequiredBase)) { "CHECKOUT_REJECTED" }
  elseif ($EnableActorStage -and -not $EnableAccountStage) { 'STAGE2_GUARD_REJECTED' }
  elseif (-not $EnableAccountStage) { "IMPLEMENTATION_INCOMPLETE" }
  else {
    try {
      $backend=New-PhaseAWindowsAccountBackend
      $launchBackend=if ($EnableActorStage) { New-PhaseAStage2Backend } else { @{} }
      $stage=Invoke-PhaseAStages $true ([bool]$EnableActorStage) $backend $launchBackend
      if ($stage -in @('STAGE1_COMPLETE','STAGE2_COMPLETE')) { 'IMPLEMENTATION_INCOMPLETE' } else { $stage }
    } catch { 'ACCOUNT_MANAGEMENT_UNAVAILABLE' }
  }
$report = [ordered]@{ schema="ether.t3.phase-a.failure.v1"; status="UNVERIFIED"; reason=$reason }
try {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Compress))
  $stream=[IO.File]::Open($OutputFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
} catch {
  Write-Error "Sanitized Phase A failure report could not be created."
  exit 2
}
Write-Output "Phase A UNVERIFIED: $reason"
exit 2
