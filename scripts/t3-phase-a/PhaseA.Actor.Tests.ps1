$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("ether-phase-a-actor-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $actor = Join-Path $PSScriptRoot "Actor.ps1"
  $target = Join-Path $root "probe.bin"; $ready = Join-Path $root "ready.json"
  $gate = Join-Path $root "gate.txt"; $result = Join-Path $root "result.json"
  [IO.File]::WriteAllText($gate,"go")
  $p = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile","-NonInteractive","-File",('"' + $actor + '"'),"-Operation","Create",
    "-Target",('"' + $target + '"'),"-Ready",('"' + $ready + '"'),
    "-Gate",('"' + $gate + '"'),"-Result",('"' + $result + '"'),"-Nonce","offline-test"
  )
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
} finally {
  $resolved = [IO.Path]::GetFullPath($root)
  $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($resolved).StartsWith("ether-phase-a-actor-test-")) { throw "Unsafe cleanup path" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
