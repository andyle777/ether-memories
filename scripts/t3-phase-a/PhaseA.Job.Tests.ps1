$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Native.ps1"
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
  [EtherPhaseAJob]::Close($atomicJob); $atomicJob = [IntPtr]::Zero
  if (-not $atomic.Wait(10000)) { throw 'Atomic job child survived job close' }
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
