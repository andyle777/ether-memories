$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Native.ps1"
. "$PSScriptRoot/PhaseA.HostedSupervision.ps1"
$ready = Join-Path ([IO.Path]::GetTempPath()) ("ether-phase-a-ready-" + [Guid]::NewGuid().ToString("N") + ".txt")
$supervisor = $null; $child = $null
try {
  $script = Join-Path $PSScriptRoot "PhaseA.JobSupervisor.ps1"
  $supervisor = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @("-NoProfile","-NonInteractive","-File",('"' + $script + '"'),"-Ready",('"' + $ready + '"'))
  $until = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($supervisor.HasExited -or [DateTime]::UtcNow -gt $until) { throw "Supervisor failed readiness" }
    Start-Sleep -Milliseconds 100
  }
  $id = [int](Get-Content -LiteralPath $ready -Raw)
  $child = Get-Process -Id $id -ErrorAction Stop
  $supervisor.Kill()
  if (-not $supervisor.WaitForExit(5000)) { throw "Supervisor failed to exit" }
  if (-not $child.WaitForExit(10000)) { throw "Job child survived supervisor death" }
  Write-Output "PASS supervisor death terminated assigned child"
} finally {
  if ($supervisor -and -not $supervisor.HasExited) { $supervisor.Kill(); $null=$supervisor.WaitForExit(5000) }
  if ($child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(5000) }
  if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready -Force }
}
$ready = Join-Path ([IO.Path]::GetTempPath()) ("ether-phase-a-atomic-ready-" + [Guid]::NewGuid().ToString('N') + '.txt')
$supervisor = $null; $child = $null
try {
  $script = Join-Path $PSScriptRoot 'PhaseA.AtomicSupervisor.ps1'
  $supervisor = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $script + '"'),'-Ready',('"' + $ready + '"'))
  $until = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($supervisor.HasExited -or [DateTime]::UtcNow -gt $until) { throw 'Atomic supervisor failed readiness' }
    Start-Sleep -Milliseconds 100
  }
  $child = Get-Process -Id ([int](Get-Content -LiteralPath $ready -Raw)) -ErrorAction Stop
  $supervisor.Kill()
  if (-not $supervisor.WaitForExit(5000) -or -not $child.WaitForExit(10000)) { throw 'Atomic suspended child survived supervisor death' }
  Write-Output 'PASS atomic suspended child terminated on supervisor death'
} finally {
  if ($supervisor -and -not $supervisor.HasExited) { $supervisor.Kill(); $null=$supervisor.WaitForExit(5000) }
  if ($child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(5000) }
  if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready -Force }
}
$ready=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-hosted-ready-'+[Guid]::NewGuid().ToString('N')+'.json')
$gate=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-hosted-gate-'+[Guid]::NewGuid().ToString('N'))
$supervisor=$null; $child=$null
try {
  $script=Join-Path $PSScriptRoot 'PhaseA.HostedSupervisor.ps1'
  $supervisor=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$script+'"'),'-Ready',('"'+$ready+'"'),'-Gate',('"'+$gate+'"'),'-Mode','jobClosure')
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while (-not [IO.File]::Exists($ready)) { if ($supervisor.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Hosted helper readiness failed' }; Start-Sleep -Milliseconds 100 }
  $record=Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  if ($record.PSObject.Properties.Name -cnotcontains 'innerJobHandle') { throw 'Inner job inspection handle is missing' }
  $child=Get-Process -Id ([int]$record.pid) -ErrorAction Stop
  $inspection=[IntPtr]::Zero
  try {
    $inspection=[EtherPhaseAJob]::DuplicateQueryFromProcess($supervisor.Id,[long]$record.innerJobHandle)
    if (([EtherPhaseAJob]::QueryLimitFlags($inspection) -band 0x2000) -eq 0) { throw 'Inner job lacks kill-on-close' }
    if (-not [EtherPhaseAJob]::Contains($inspection,$child.Handle)) { throw 'Child is not in inner job' }
    if ([EtherPhaseAJob]::Contains($inspection,$supervisor.Handle)) { throw 'Supervisor unexpectedly belongs to inner job' }
  } finally { if ($inspection -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($inspection) } }
  if ([DateTimeOffset]::Parse($record.createdAt) -ne [DateTimeOffset]$child.StartTime.ToUniversalTime()) { throw 'Hosted helper creation time mismatch' }
  if (-not (Get-Command Get-PhaseAInnerJobInspection -ErrorAction SilentlyContinue)) { throw 'Manager inner-job inspection is missing' }
  $inspectionResult=Get-PhaseAInnerJobInspection $supervisor $child ([long]$record.innerJobHandle) ([int]$record.pid) ([string]$record.createdAt)
  if ($inspectionResult.status -cne 'OBSERVED' -or -not $inspectionResult.released -or -not $inspectionResult.member -or $inspectionResult.supervisorMember) { throw 'Independent inner-job inspection failed' }
  $wrong=Get-PhaseAInnerJobInspection $supervisor $child ([long]$record.innerJobHandle) ($child.Id+1) ([string]$record.createdAt)
  if ($wrong.status -cne 'FAILED' -or $wrong.reason -cne 'PID_MISMATCH') { throw 'Wrong child PID accepted' }
  $wrong=Get-PhaseAInnerJobInspection $supervisor $child ([long]$record.innerJobHandle) ([int]$record.pid) '2020-01-01T00:00:00Z'
  if ($wrong.status -cne 'FAILED' -or $wrong.reason -cne 'TIME_MISMATCH') { throw 'Wrong child creation time accepted' }
  [IO.File]::WriteAllText($gate,'go')
  if (-not $supervisor.WaitForExit(15000) -or $supervisor.ExitCode -ne 0 -or -not $child.WaitForExit(10000)) { throw 'Hosted helper job close failed' }
  Write-Output 'PASS hosted supervisor helper with same-identity child'
} finally {
  if ($supervisor -and -not $supervisor.HasExited) { $supervisor.Kill(); $null=$supervisor.WaitForExit(5000) }
  if ($child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(5000) }
  foreach ($file in @($ready,$gate)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class InnerJobTestNative {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attrs,string name);
}
"@
$child=$null; $own=$null; $job=[IntPtr]::Zero; $other=[IntPtr]::Zero; $unconfigured=[IntPtr]::Zero
try {
  $own=Get-Process -Id $PID
  $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30')
  $job=[EtherPhaseAJob]::Create(); [EtherPhaseAJob]::Assign($job,$child.Handle)
  $other=[EtherPhaseAJob]::Create()
  $created=$child.StartTime.ToUniversalTime().ToString('o')
  $v=Get-PhaseAInnerJobInspection $own $child $other.ToInt64() $child.Id $created
  if ($v.reason -cne 'JOB_MISMATCH' -or -not $v.released) { throw 'Wrong inner job accepted' }
  $unconfigured=[InnerJobTestNative]::CreateJobObject([IntPtr]::Zero,$null)
  if ($unconfigured -eq [IntPtr]::Zero) { throw 'Unconfigured job creation failed' }
  $v=Get-PhaseAInnerJobInspection $own $child $unconfigured.ToInt64() $child.Id $created
  if ($v.reason -cne 'LIMIT_MISMATCH' -or -not $v.released) { throw 'Missing kill-on-close accepted' }
  $v=Get-PhaseAInnerJobInspection $own $child 123 $child.Id $created
  if ($v.status -cne 'FAILED') { throw 'Invalid job query accepted' }
  Write-Output 'PASS same-identity wrong-job, limit and unavailable-query controls (3)'
} finally {
  if ($other -ne [IntPtr]::Zero) {[EtherPhaseAJob]::Close($other)}
  if ($unconfigured -ne [IntPtr]::Zero) {[EtherPhaseAJob]::Close($unconfigured)}
  if ($job -ne [IntPtr]::Zero) {[EtherPhaseAJob]::Close($job)}
  if ($child -and -not $child.HasExited) {$child.Kill(); $null=$child.WaitForExit(5000)}
  if ($child) {$child.Dispose()}; if ($own) {$own.Dispose()}
}
$ready=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-inner-death-'+[Guid]::NewGuid().ToString('N')+'.json')
$gate=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-inner-unused-'+[Guid]::NewGuid().ToString('N'))
$supervisor=$null; $child=$null
try {
  $script=Join-Path $PSScriptRoot 'PhaseA.HostedSupervisor.ps1'
  $supervisor=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$script+'"'),'-Ready',('"'+$ready+'"'),'-Gate',('"'+$gate+'"'),'-Mode','supervisorDeath')
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while (-not [IO.File]::Exists($ready)) { if ($supervisor.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Death helper not ready' }; Start-Sleep -Milliseconds 100 }
  $record=Get-Content -Raw -LiteralPath $ready | ConvertFrom-Json
  $child=Get-Process -Id ([int]$record.pid) -ErrorAction Stop
  $v=Get-PhaseAInnerJobInspection $supervisor $child ([long]$record.innerJobHandle) ([int]$record.pid) ([string]$record.createdAt)
  if ($v.status -cne 'OBSERVED' -or -not $v.released -or $child.HasExited) { throw 'Death helper inner job was not verified and released' }
  $supervisor.Kill()
  if (-not $supervisor.WaitForExit(5000) -or -not $child.WaitForExit(10000)) { throw 'Supervisor death or child termination unconfirmed' }
  Write-Output 'PASS same-identity inner inspection released before supervisor death'
} finally {
  if ($supervisor -and -not $supervisor.HasExited) {$supervisor.Kill(); $null=$supervisor.WaitForExit(5000)}
  if ($child -and -not $child.HasExited) {$child.Kill(); $null=$child.WaitForExit(5000)}
  if ($supervisor) {$supervisor.Dispose()}; if ($child) {$child.Dispose()}
  if ([IO.File]::Exists($ready)) {[IO.File]::Delete($ready)}
  if ([IO.File]::Exists($gate)) {[IO.File]::Delete($gate)}
}
