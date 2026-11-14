$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Native.ps1"
. "$PSScriptRoot/PhaseA.Core.ps1"
. "$PSScriptRoot/PhaseA.Atomic.ps1"
$marker = Join-Path ([IO.Path]::GetTempPath()) ("ether-phase-a-atomic-" + [Guid]::NewGuid().ToString('N') + '.txt')
$atomic = $null; $atomicJob = [IntPtr]::Zero
$previousSentinel = [Environment]::GetEnvironmentVariable('PHASE_A_PRIVATE_SENTINEL', 'Process')
try {
  [Environment]::SetEnvironmentVariable('PHASE_A_PRIVATE_SENTINEL', 'sensitive-test-value', 'Process')
  $atomicJob = [EtherPhaseAJob]::Create()
  $payload = "`$v=[Environment]::GetEnvironmentVariable('PHASE_A_PRIVATE_SENTINEL'); if (`$null -eq `$v) { `$v='clean' }; [IO.File]::WriteAllText('" + $marker + "',`$v); Start-Sleep -Seconds 60"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
  $exe = Join-Path $PSHOME 'powershell.exe'
  $atomic = [EtherPhaseAAtomic]::CreateCurrentUser($atomicJob, $exe, ('"' + $exe + '" -NoProfile -NonInteractive -EncodedCommand ' + $encoded))
  if (-not $atomic.InJob()) { throw 'Atomic child was not assigned during creation' }
  $runningRejected=$false
  try { $null=$atomic.ExitCode() } catch { $runningRejected=$true }
  if (-not $runningRejected) { throw 'Running child exit code was accepted' }
  $osObservation = Get-PhaseAProcessToken (Get-Process -Id $atomic.Pid -ErrorAction Stop)
  if ($osObservation.pid -ne $atomic.Pid -or $osObservation.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
      [string]::IsNullOrWhiteSpace($osObservation.createdAt)) { throw 'Atomic child OS token observation failed' }
  try {
    $unexpected = [EtherPhaseAAtomic]::CreateWithToken([IntPtr]::Zero, $atomicJob, $exe, ('"' + $exe + '"'))
    throw 'Null token unexpectedly accepted'
  } catch [System.Management.Automation.MethodInvocationException] {
    if ($_.Exception.InnerException -isnot [ArgumentException]) { throw }
  }
  Start-Sleep -Milliseconds 300
  if ([IO.File]::Exists($marker)) { throw 'Suspended child executed before resume' }
  $atomic.Resume()
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists($marker)) {
    if ($atomic.Exited() -or [DateTime]::UtcNow -gt $deadline) { throw 'Atomic child did not resume' }
    Start-Sleep -Milliseconds 50
  }
  if ([IO.File]::ReadAllText($marker) -cne 'clean') { throw 'Parent environment leaked into child' }
  if ($atomic.Exited()) { throw 'Child exited before job closure' }
  if (([EtherPhaseAJob]::QueryLimitFlags($atomicJob) -band 0x2000) -eq 0 -or [EtherPhaseAJob]::QueryHandleCount($atomicJob) -ne 1) { throw 'Job limit or handle ownership not established' }
  [EtherPhaseAJob]::Close($atomicJob); $atomicJob = [IntPtr]::Zero
  if (-not $atomic.Wait(10000)) { throw 'Atomic job child survived job close' }
  if ($atomic.ExitCode() -eq 259) { throw 'Terminated child reported as active' }
  Write-Output 'PASS atomic job assignment, suspended start, resume and kill-on-close'
} finally {
  [Environment]::SetEnvironmentVariable('PHASE_A_PRIVATE_SENTINEL', $previousSentinel, 'Process')
  if ($atomicJob -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($atomicJob) }
  if ($atomic) { $atomic.Dispose() }
  if ([IO.File]::Exists($marker)) { [IO.File]::Delete($marker) }
}
$child = $null; $job = [IntPtr]::Zero
try {
  $job = [EtherPhaseAJob]::Create()
  $child = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @("-NoProfile","-NonInteractive","-Command","Start-Sleep -Seconds 60")
  [EtherPhaseAJob]::Assign($job, $child.Handle)
  [EtherPhaseAJob]::Close($job); $job = [IntPtr]::Zero
  if (-not $child.WaitForExit(10000)) { throw "Assigned test child remained alive" }
  Write-Output "PASS kill-on-close terminated the assigned test child"
} finally {
  if ($job -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($job) }
  if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }
}

$timeoutChild=$null
try {
  $timeoutChild=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60')
  $timeoutResult=Wait-PhaseAProcess $timeoutChild 100
  if ($timeoutResult.completed -or -not $timeoutResult.timeout -or -not $timeoutResult.terminated) { throw 'Timed out child not confirmed terminated' }
  Write-Output 'PASS real same-identity child timeout and termination'
} finally {
  if ($timeoutChild -and -not $timeoutChild.HasExited) { $timeoutChild.Kill(); $null=$timeoutChild.WaitForExit(5000) }
}
$selfJob=[IntPtr]::Zero; $selfChild=$null
try {
  $selfJob=[EtherPhaseAJob]::Create(); $exe=Join-Path $PSHOME 'powershell.exe'
  $selfChild=[EtherPhaseAAtomic]::CreateSelfInDirectory($selfJob,$exe,('"'+$exe+'" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'),[IO.Path]::GetTempPath())
  if (-not $selfChild.InJob() -or $selfChild.Exited()) { throw 'Self-token atomic child not contained' }
  $selfProcess=Get-Process -Id $selfChild.Pid -ErrorAction Stop; $otherJob=[EtherPhaseAJob]::Create()
  try { if (-not [EtherPhaseAJob]::Contains($selfJob,$selfProcess.Handle) -or [EtherPhaseAJob]::Contains($otherJob,$selfProcess.Handle)) { throw 'Independent job membership check failed' } } finally { [EtherPhaseAJob]::Close($otherJob); $selfProcess.Dispose() }
  [EtherPhaseAJob]::Close($selfJob); $selfJob=[IntPtr]::Zero
  if (-not $selfChild.Wait(10000)) { throw 'Self-token atomic child survived' }
  Write-Output 'PASS atomic current-process token child and job cleanup'
} finally { if ($selfJob -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($selfJob) }; if ($selfChild) { $selfChild.Dispose() } }
# Same-identity native observation only; no accounts or policy changes.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PhaseATestHandle {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 public static IntPtr Duplicate(IntPtr h) { IntPtr d; if (!DuplicateHandle(GetCurrentProcess(),h,GetCurrentProcess(),out d,0,false,2)) throw new Exception("duplicate failed"); return d; }
}
"@
$probeJob=[IntPtr]::Zero; $duplicate=[IntPtr]::Zero
try {
  $probeJob=[EtherPhaseAJob]::Create()
  if (-not ([EtherPhaseAJob].GetMethod('QueryLimitFlags')) -or -not ([EtherPhaseAJob].GetMethod('QueryHandleCount'))) { throw 'Job limit and handle count observation is missing' }
  if (([EtherPhaseAJob]::QueryLimitFlags($probeJob) -band 0x2000) -eq 0) { throw 'Kill-on-close flag missing' }
  if ([EtherPhaseAJob]::QueryHandleCount($probeJob) -ne 1) { throw 'New job did not have one handle' }
  $duplicate=[PhaseATestHandle]::Duplicate($probeJob)
  if ([EtherPhaseAJob]::QueryHandleCount($probeJob) -ne 2) { throw 'Duplicate job handle was not observed' }
  if (-not [PhaseATestHandle]::CloseHandle($duplicate)) { throw 'Duplicate close failed' }; $duplicate=[IntPtr]::Zero
  if ([EtherPhaseAJob]::QueryHandleCount($probeJob) -ne 1) { throw 'Job handle close was not observed' }
  Write-Output 'PASS same-identity job limit and duplicate-handle observations'
} finally {
  if ($duplicate -ne [IntPtr]::Zero) { [void][PhaseATestHandle]::CloseHandle($duplicate) }
  if ($probeJob -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($probeJob) }
}
$retainedJob=[IntPtr]::Zero; $retainedCopy=[IntPtr]::Zero; $retainedChild=$null
try {
  $retainedJob=[EtherPhaseAJob]::Create()
  $retainedChild=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30')
  [EtherPhaseAJob]::Assign($retainedJob,$retainedChild.Handle)
  $retainedCopy=[EtherPhaseAJob]::DuplicateQueryFromProcess($PID,$retainedJob.ToInt64())
  [EtherPhaseAJob]::Close($retainedJob); $retainedJob=[IntPtr]::Zero
  if ($retainedChild.WaitForExit(300)) { throw 'Child unexpectedly exited while duplicate job handle remained open' }
  [EtherPhaseAJob]::Close($retainedCopy); $retainedCopy=[IntPtr]::Zero
  if (-not $retainedChild.WaitForExit(10000)) { throw 'Child survived release of duplicate job handle' }
  Write-Output 'PASS retained query handle delays job termination until released'
} finally {
  if ($retainedJob -ne [IntPtr]::Zero) {[EtherPhaseAJob]::Close($retainedJob)}
  if ($retainedCopy -ne [IntPtr]::Zero) {[EtherPhaseAJob]::Close($retainedCopy)}
  if ($retainedChild -and -not $retainedChild.HasExited) {$retainedChild.Kill(); $null=$retainedChild.WaitForExit(5000)}
  if ($retainedChild) {$retainedChild.Dispose()}
}
