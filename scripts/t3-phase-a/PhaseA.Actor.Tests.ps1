$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("ether-phase-a-actor-test-" + [Guid]::NewGuid().ToString("N"))
. "$PSScriptRoot/PhaseA.Inventory.ps1"
New-Item -ItemType Directory -Path $root | Out-Null
$p = $null
try {
  $actor = Join-Path $PSScriptRoot "Actor.ps1"
  $target = Join-Path $root "probe.bin"; $ready = Join-Path $root "ready.json"
  $gate = Join-Path $root "gate.txt"; $result = Join-Path $root "result.json"
  $p = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile","-NonInteractive","-File",('"' + $actor + '"'),"-Operation","Create",
    "-Target",('"' + $target + '"'),"-Ready",('"' + $ready + '"'),
    "-Gate",('"' + $gate + '"'),"-Result",('"' + $result + '"'),"-Nonce","offline-test"
  )
  $until = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists($ready)) {
    if ($p.HasExited -or [DateTime]::UtcNow -ge $until) { throw 'Actor failed readiness' }
    Start-Sleep -Milliseconds 25
  }
  $handshake = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  $actorTime = [DateTimeOffset]::Parse($handshake.createdAt)
  $osTime = [DateTimeOffset]$p.StartTime.ToUniversalTime()
  if ($actorTime -ne $osTime) { throw 'Actor creation time does not match OS process record' }
  [IO.File]::WriteAllText($gate,"go")
  if (-not $p.WaitForExit(15000)) { $p.Kill(); throw "Actor timed out" }
  $record = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($p.ExitCode -ne 0 -or $record.pid -ne $p.Id -or $record.outcome -cne "allowed" -or
      $record.nonce -cne "offline-test" -or -not (Test-Path -LiteralPath $target)) { throw "Actor positive control failed" }
  Write-Output "PASS actor nonprivileged create and identity record"
  Remove-Item -LiteralPath $ready, $result
  $missing = Join-Path $root "missing.bin"
  $p = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile","-NonInteractive","-File",('"' + $actor + '"'),"-Operation","Read",
    "-Target",('"' + $missing + '"'),"-Ready",('"' + $ready + '"'),
    "-Gate",('"' + $gate + '"'),"-Result",('"' + $result + '"'),"-Nonce","offline-test"
  )
  if (-not $p.WaitForExit(15000)) { $p.Kill(); throw "Actor timed out" }
  $record = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($p.ExitCode -ne 21 -or $record.outcome -cne "error") { throw "Missing file was incorrectly treated as access denial" }
  Write-Output "PASS actor missing-file error is not access denial"
  $first = Get-PhaseAInventory $root
  $second = Get-PhaseAInventory $root
  if ($first -cne $second) { throw "Unchanged inventory differed" }
  [IO.File]::WriteAllText($target, "changed")
  $changed = Get-PhaseAInventory $root
  if ($first -ceq $changed) { throw "Changed inventory was not detected" }
  [IO.File]::WriteAllText($target, "abcdefg")
  $sameSize = Get-PhaseAInventory $root
  if ($changed -ceq $sameSize) { throw "Same-size content change was not detected" }
  $emptyDirectory = Join-Path $root 'empty-directory'
  [void][IO.Directory]::CreateDirectory($emptyDirectory)
  $withDirectory = Get-PhaseAInventory $root
  if ($sameSize -ceq $withDirectory) { throw "Empty directory was not detected" }
  [IO.Directory]::Delete($emptyDirectory)
  if ((Get-PhaseAInventory $root) -cne $sameSize) { throw "Restored layout did not match" }
  Write-Output "PASS inventory detects file mutation"
} finally {
  if ($null -ne $p -and -not $p.HasExited) { $p.Kill(); $null = $p.WaitForExit(5000) }
  $resolved = [IO.Path]::GetFullPath($root)
  $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($resolved).StartsWith("ether-phase-a-actor-test-")) { throw "Unsafe cleanup path" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
