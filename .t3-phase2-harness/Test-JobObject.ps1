$ErrorActionPreference = "Stop"

function Ensure-ParentDirectory([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath)) { return }
  $parent = Split-Path -Parent $TargetPath
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

$harness = $PSScriptRoot
$runId = [Guid]::NewGuid().ToString("N")
$evidence = Join-Path $harness "evidence\job-only-$runId"
$temporary = Join-Path $env:TEMP "EtherPhase2-Job-$runId"
New-Item -ItemType Directory -Path $evidence,$temporary -Force | Out-Null
$ready = Join-Path $temporary "ready.txt"
$supervisorScript = Join-Path $harness "JobSupervisor.ps1"
$workerScript = Join-Path $harness "Actor.ps1"
$supervisor = $null
$workerPid = $null
$status = "UNVERIFIED"
$detail = "The supervisor did not publish an assigned worker PID."

try {
  $supervisor = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") `
    -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$supervisorScript`"",
      "-WorkerScript", "`"$workerScript`"", "-ReadyPath", "`"$ready`"") -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($supervisor.HasExited) { throw "Supervisor exited before assigning a child; exit code $($supervisor.ExitCode)." }
    if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for the supervisor ready file." }
    Start-Sleep -Milliseconds 100
  }
  $pids = Get-Content -LiteralPath $ready
  if ($pids.Count -lt 2) { throw "Supervisor ready file did not contain both process IDs." }
  $workerPid = [int]$pids[1]
  Stop-Process -Id $supervisor.Id -Force
  $supervisor.WaitForExit()

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  $workerAlive = $true
  while ($workerAlive -and [DateTime]::UtcNow -lt $deadline) {
    $workerAlive = [bool](Get-Process -Id $workerPid -ErrorAction SilentlyContinue)
    if ($workerAlive) { Start-Sleep -Milliseconds 100 }
  }
  if ($workerAlive) {
    $status = "RED"
    $detail = "Supervisor was terminated, but its assigned child remained alive."
  } else {
    $status = "GREEN"
    $detail = "Terminating the supervisor closed its Job Object; the assigned child exited."
  }
} catch {
  $status = "UNVERIFIED"
  $detail = $_.Exception.ToString()
} finally {
  if ($null -ne $supervisor -and -not $supervisor.HasExited) {
    Stop-Process -Id $supervisor.Id -Force
    $supervisor.WaitForExit()
  }
  if ($null -ne $workerPid -and (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $workerPid -Force
  }
}

$sourceFiles = @("Actor.ps1", "JobSupervisor.ps1", "Test-JobObject.ps1")
$hashes = @(
  foreach ($name in $sourceFiles) {
    $path = Join-Path $harness $name
    [ordered]@{ path = $name; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
)
$report = [ordered]@{
  id = "job-object-supervisor-crash-cleanup"
  status = $status
  detail = $detail
  capturedUtc = [DateTime]::UtcNow.ToString("o")
  computerName = $env:COMPUTERNAME
  identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  osVersion = [Environment]::OSVersion.VersionString
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  supervisorPid = if ($null -ne $supervisor) { $supervisor.Id } else { $null }
  workerPid = $workerPid
  harnessHashes = $hashes
}
Ensure-ParentDirectory (Join-Path $evidence "report.json")
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence "report.json") -Encoding UTF8
Write-Output "Evidence directory: $evidence"
Write-Output "Job Object result: $status - $detail"
if ($status -eq "RED") { exit 1 }
if ($status -eq "UNVERIFIED") { exit 2 }
