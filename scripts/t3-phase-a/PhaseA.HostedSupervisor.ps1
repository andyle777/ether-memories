param([Parameter(Mandatory=$true)][string]$Ready,[Parameter(Mandatory=$true)][string]$Gate,[Parameter(Mandatory=$true)][string]$Mode,[string]$Receipt,[string]$Attempt)
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
  [IO.File]::WriteAllText($Ready,(@{pid=$child.Pid;createdAt=$createdAt;innerJobHandle=$job.ToInt64()} | ConvertTo-Json -Compress))
  if ($Mode -ceq 'jobClosure') {
    $deadline=[DateTime]::UtcNow.AddSeconds(40)
    while (-not [IO.File]::Exists($Gate)) { if ([DateTime]::UtcNow -ge $deadline) { throw 'gate timeout' }; Start-Sleep -Milliseconds 50 }
    if ([string]::IsNullOrWhiteSpace($Receipt) -or $Attempt -cnotmatch '^[0-9a-f]{32}$') { throw 'receipt parameters rejected' }
    $self=Get-Process -Id $PID -ErrorAction Stop
    try { $supervisorCreatedAt=$self.StartTime.ToUniversalTime().ToString('o') } finally { $self.Dispose() }
    $closeRecord=@{schema='ether.phase-a.close-receipt.v1';mode='jobClosure';attempt=$Attempt;supervisorPid=$PID;supervisorCreatedAt=$supervisorCreatedAt;childPid=$child.Pid;childCreatedAt=$createdAt;attempted=$true;succeeded=$false;error='NON_WIN32'}
    $closeFailed=$false
    try { [EtherPhaseAJob]::Close($job); $job=[IntPtr]::Zero; $closeRecord.succeeded=$true; $closeRecord.error='NONE' }
    catch {
      $closeFailed=$true; $base=$_.Exception.GetBaseException()
      if ($base -is [ComponentModel.Win32Exception]) { $closeRecord.error=if($base.NativeErrorCode -eq 5){'WIN32_ACCESS_DENIED'}elseif($base.NativeErrorCode -eq 6){'WIN32_INVALID_HANDLE'}else{'WIN32_OTHER'} }
    } finally { [IO.File]::WriteAllText($Receipt,($closeRecord | ConvertTo-Json -Compress)) }
    if ($closeFailed) { throw 'job close failed' }
    if (-not $child.Wait(10000)) { throw 'child termination not observed' }
  } else { Start-Sleep -Seconds 90 }
} finally {
  if ($job -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($job) }
  if ($child) { $child.Dispose() }
}
