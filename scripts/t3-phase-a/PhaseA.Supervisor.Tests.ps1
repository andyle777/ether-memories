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
$ready=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-hosted-ready-'+[Guid]::NewGuid().ToString('N')+'.json')
$gate=Join-Path ([IO.Path]::GetTempPath()) ('ether-phase-a-hosted-gate-'+[Guid]::NewGuid().ToString('N'))
$supervisor=$null; $child=$null
try {
  $script=Join-Path $PSScriptRoot 'PhaseA.HostedSupervisor.ps1'
  $supervisor=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$script+'"'),'-Ready',('"'+$ready+'"'),'-Gate',('"'+$gate+'"'),'-Mode','jobClosure')
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while (-not [IO.File]::Exists($ready)) { if ($supervisor.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Hosted helper readiness failed' }; Start-Sleep -Milliseconds 100 }
  $record=Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  $child=Get-Process -Id ([int]$record.pid) -ErrorAction Stop
  if ([DateTimeOffset]::Parse($record.createdAt) -ne [DateTimeOffset]$child.StartTime.ToUniversalTime()) { throw 'Hosted helper creation time mismatch' }
  [IO.File]::WriteAllText($gate,'go')
  if (-not $supervisor.WaitForExit(15000) -or $supervisor.ExitCode -ne 0 -or -not $child.WaitForExit(10000)) { throw 'Hosted helper job close failed' }
  Write-Output 'PASS hosted supervisor helper with same-identity child'
} finally {
  if ($supervisor -and -not $supervisor.HasExited) { $supervisor.Kill(); $null=$supervisor.WaitForExit(5000) }
  if ($child -and -not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(5000) }
  foreach ($file in @($ready,$gate)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
