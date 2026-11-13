param(
  [Parameter(Mandatory = $true)][ValidateSet("Write", "HoldWrite", "HoldLock", "TryLock", "Idle")][string]$Mode,
  [string]$Path,
  [string]$ReadyPath,
  [string]$TriggerPath,
  [string]$ResultPath
)

$ErrorActionPreference = "Stop"

function Ensure-ParentDirectory([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath)) { return }
  $parent = Split-Path -Parent $TargetPath
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Write-Result([string]$Status, [string]$Detail) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $record = [ordered]@{
    status = $Status
    detail = $Detail
    identity = $identity.Name
    sid = $identity.User.Value
    pid = $PID
    timeUtc = [DateTime]::UtcNow.ToString("o")
  }
  if ($ResultPath) {
    Ensure-ParentDirectory $ResultPath
    [IO.File]::WriteAllText($ResultPath, ($record | ConvertTo-Json -Compress))
  }
  if ($ReadyPath) {
    Ensure-ParentDirectory $ReadyPath
  }
}

if ($Mode -eq "Idle") {
  if ($ReadyPath) {
    Ensure-ParentDirectory $ReadyPath
    [IO.File]::WriteAllText($ReadyPath, "$PID")
  }
  Start-Sleep -Seconds 300
  exit 0
}

if ($Mode -eq "HoldLock" -or $Mode -eq "TryLock") {
  $lock = $null
  try {
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $lock = [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if ($Mode -eq "TryLock") {
      Write-Result "exclusive-lock-acquired" "The lock path was opened exclusively."
      exit 0
    }
    if ($ReadyPath) {
      Ensure-ParentDirectory $ReadyPath
      [IO.File]::WriteAllText($ReadyPath, "$PID")
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not [IO.File]::Exists($TriggerPath)) {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for the harness trigger."
      }
      Start-Sleep -Milliseconds 50
    }
    Write-Result "lock-released" "The exclusive lock handle was closed."
    exit 0
  } catch [IO.IOException] {
    Write-Result "exclusive-lock-unavailable" $_.Exception.Message
    exit 21
  } finally {
    if ($null -ne $lock) {
      $lock.Dispose()
    }
  }
}

if ($Mode -eq "Write") {
  try {
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, "written-by-$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)")
    Write-Result "write-succeeded" "WriteAllText completed."
    exit 0
  } catch [UnauthorizedAccessException] {
    Write-Result "access-denied" $_.Exception.Message
    exit 20
  } catch [IO.IOException] {
    Write-Result "io-error" $_.Exception.Message
    exit 21
  }
}

$stream = $null
try {
  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write,
    ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  if ($ReadyPath) {
    Ensure-ParentDirectory $ReadyPath
    [IO.File]::WriteAllText($ReadyPath, "$PID")
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not [IO.File]::Exists($TriggerPath)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Timed out waiting for the harness trigger."
    }
    Start-Sleep -Milliseconds 50
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes("write-through-preexisting-handle")
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
  Write-Result "existing-handle-write-succeeded" "The already-open handle wrote after its DACL changed."
  exit 0
} catch {
  Write-Result "existing-handle-write-failed" $_.Exception.Message
  exit 22
} finally {
  if ($null -ne $stream) {
    $stream.Dispose()
  }
}
