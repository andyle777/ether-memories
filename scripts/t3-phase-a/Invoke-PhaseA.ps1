[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$RequiredBase,
  [Parameter(Mandatory=$true)][string]$OutputFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Core.ps1"
$config = @{
  repository=[Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY")
  event=[Environment]::GetEnvironmentVariable("GITHUB_EVENT_NAME")
  ref=[Environment]::GetEnvironmentVariable("GITHUB_REF")
  runner=[Environment]::GetEnvironmentVariable("RUNNER_ENVIRONMENT")
  sha=[Environment]::GetEnvironmentVariable("GITHUB_SHA")
  base=$RequiredBase
}
$reason = if (Test-PhaseAConfig $config) { "IMPLEMENTATION_INCOMPLETE" } else { "CONFIGURATION_REJECTED" }
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
