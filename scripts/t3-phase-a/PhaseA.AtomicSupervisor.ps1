param([Parameter(Mandatory=$true)][string]$Ready)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/PhaseA.Native.ps1"
. "$PSScriptRoot/PhaseA.Atomic.ps1"
$job = [IntPtr]::Zero; $child = $null
try {
  $job = [EtherPhaseAJob]::Create()
  $exe = Join-Path $PSHOME 'powershell.exe'
  $child = [EtherPhaseAAtomic]::CreateCurrentUser($job, $exe, ('"' + $exe + '" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90"'))
  if (-not $child.InJob()) { throw 'Atomic child not in job' }
  [IO.File]::WriteAllText($Ready, [string]$child.Pid)
  Start-Sleep -Seconds 90
} finally {
  if ($job -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($job) }
  if ($child) { $child.Dispose() }
}
