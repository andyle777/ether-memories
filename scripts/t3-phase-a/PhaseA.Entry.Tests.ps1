$ErrorActionPreference = "Stop"
$base=[IO.Path]::GetTempPath()
$reports=@()
try {
  foreach ($mode in @("missing","valid-looking")) {
    $report=Join-Path $base ("ether-phase-a-failclosed-" + [Guid]::NewGuid().ToString("N") + ".json")
    $reports += $report
    if ($mode -eq "valid-looking") {
      $env:GITHUB_REPOSITORY="andyle777/Ether-Memories"; $env:GITHUB_EVENT_NAME="push"
      $env:GITHUB_REF="refs/heads/test/t3-windows-enforcement-run"; $env:RUNNER_ENVIRONMENT="github-hosted"
      $env:GITHUB_SHA="0123456789abcdef0123456789abcdef01234567"
    } else {
      $env:GITHUB_REPOSITORY="";$env:GITHUB_EVENT_NAME="";$env:GITHUB_REF="";$env:RUNNER_ENVIRONMENT="";$env:GITHUB_SHA=""
    }
    $manager=Join-Path $PSScriptRoot "Invoke-PhaseA.ps1"
    $p=Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -WindowStyle Hidden -PassThru -ArgumentList @(
      "-NoProfile","-NonInteractive","-File",('"' + $manager + '"'),
      "-RequiredBase","42f9b5bdf94e47c4c69c0f87127eb545dff13ed1","-OutputFile",('"' + $report + '"')
    )
    if (-not $p.WaitForExit(15000)) { $p.Kill(); throw "Manager test timeout" }
    if ($p.ExitCode -ne 2) { throw "Incomplete manager did not fail closed" }
    $value=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    $expected=if ($mode -eq "missing") { "CONFIGURATION_REJECTED" } else { "CHECKOUT_REJECTED" }
    $names=@($value.PSObject.Properties.Name)
    if ($names.Count -ne 3 -or $value.status -cne "UNVERIFIED" -or
        $value.schema -cne "ether.t3.phase-a.failure.v1" -or $value.reason -cne $expected) { throw "Invalid failure report" }
  }
  Write-Output "PASS invalid and valid-looking context remain UNVERIFIED with sanitized report"
} finally {
  foreach($report in $reports) { if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force } }
}
