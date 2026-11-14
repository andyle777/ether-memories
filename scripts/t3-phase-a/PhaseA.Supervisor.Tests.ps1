$ErrorActionPreference = "Stop"
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
