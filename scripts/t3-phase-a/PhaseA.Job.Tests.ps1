$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Native.ps1"
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
