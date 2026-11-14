param([Parameter(Mandatory=$true)][string]$Ready)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Native.ps1"
$job = [IntPtr]::Zero; $child = $null
try {
  $job = [EtherPhaseAJob]::Create()
  $child = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @("-NoProfile","-NonInteractive","-Command","Start-Sleep -Seconds 90")
  [EtherPhaseAJob]::Assign($job, $child.Handle)
  [IO.File]::WriteAllText($Ready, [string]$child.Id)
  $null = $child.WaitForExit(90000)
} finally {
  if ($job -ne [IntPtr]::Zero) { [EtherPhaseAJob]::Close($job) }
  if ($null -ne $child -and -not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }
}
