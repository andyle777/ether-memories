[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet("Create","Read","Overwrite")][string]$Operation,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Ready,
  [Parameter(Mandatory=$true)][string]$Gate,
  [Parameter(Mandatory=$true)][string]$Result,
  [Parameter(Mandatory=$true)][string]$Nonce
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$record = [ordered]@{ pid=$PID; sid=$identity.User.Value; nonce=$Nonce; createdAt=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText($Ready, ($record | ConvertTo-Json -Compress))
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while (-not [IO.File]::Exists($Gate)) {
  if ([DateTime]::UtcNow -ge $deadline) { exit 22 }
  Start-Sleep -Milliseconds 50
}
$outcome = "error"; $code = 21
try {
  if ($Operation -eq "Read") {
    $stream = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $sha=[Security.Cryptography.SHA256]::Create()
      try { $record['digest']=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
      finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
  } else {
    $mode = if ($Operation -eq "Create") { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Open }
    $stream = [IO.File]::Open($Target, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.WriteByte(65); $stream.Flush($true) } finally { $stream.Dispose() }
  }
  $outcome = "allowed"; $code = 0
} catch {
  $inner = $_.Exception.GetBaseException()
  if ($inner -is [UnauthorizedAccessException]) { $outcome = "denied"; $code = 20 }
}
$record["outcome"] = $outcome
[IO.File]::WriteAllText($Result, ($record | ConvertTo-Json -Compress))
exit $code
