param([Parameter(Mandatory=$true)][string]$Ready,[Parameter(Mandatory=$true)][string]$Gate,[Parameter(Mandatory=$true)][string]$Mode)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/PhaseA.Native.ps1"
. "$PSScriptRoot/PhaseA.Atomic.ps1"
$job=[IntPtr]::Zero; $child=$null
try {
  $job=[EtherPhaseAJob]::Create()
  $exe=Join-Path $PSHOME 'powershell.exe'
  $child=[EtherPhaseAAtomic]::CreateSelfInDirectory($job,$exe,('"'+$exe+'" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90"'),$PSScriptRoot)
  if (-not $child.InJob()) { throw 'child job missing' }
  $process=Get-Process -Id $child.Pid -ErrorAction Stop
  try { $createdAt=$process.StartTime.ToUniversalTime().ToString('o') } finally { $process.Dispose() }
  $child.Resume()
  if ($child.Exited()) { throw 'child exited before readiness' }
  [IO.File]::WriteAllText($Ready,(@{pid=$child.Pid;createdAt=$createdAt} | ConvertTo-Json -Compress))
  if ($Mode -ceq 'jobClosure') {
    $deadline=[DateTime]::UtcNow.AddSeconds(40)
    while (-not [IO.File]::Exists($Gate)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'gate timeout' }; Start-Sleep -Milliseconds 50 }
    [EtherPhaseAJob]::Close($job); $job=[IntPtr]::Zero
    if (-not $child.Wait(10000)) { throw 'child termination not observed' }
  } else { Start-Sleep -Seconds 90 }
} finally {
  if ($job -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($job) }
  if ($child) { $child.Dispose() }
}
