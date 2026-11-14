Set-StrictMode -Version Latest
function Test-ActorObservation([hashtable]$Observation, [string]$Role, [string]$ExpectedOutcome) {
  $keys = @("role","expectedSid","observedSid","reportedSid","expectedPid","reportedPid","tokenNonAdmin","tokenObserved","createdAt","observedCreatedAt","reportedNonce","expectedNonce","exitCode","outcome")
  foreach ($key in $keys) { if (-not $Observation.ContainsKey($key) -or $null -eq $Observation[$key]) { return $false } }
  if ($Role -notin @("broker","legacy") -or $ExpectedOutcome -notin @("allowed","denied")) { return $false }
  if ($Observation.role -cne $Role -or $Observation.outcome -cne $ExpectedOutcome) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$Observation.expectedSid) -or
      $Observation.expectedSid -cne $Observation.observedSid -or
      $Observation.expectedSid -cne $Observation.reportedSid) { return $false }
  $expectedPid = 0; $reportedPid = 0
  if (-not [int]::TryParse([string]$Observation.expectedPid, [ref]$expectedPid) -or
      -not [int]::TryParse([string]$Observation.reportedPid, [ref]$reportedPid) -or
      $expectedPid -le 0 -or $expectedPid -ne $reportedPid) { return $false }
  if ($Observation.tokenNonAdmin -isnot [bool] -or -not $Observation.tokenNonAdmin -or
      $Observation.tokenObserved -isnot [bool] -or -not $Observation.tokenObserved) { return $false }
  $time = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Observation.createdAt, [ref]$time)) { return $false }
  $observedTime = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Observation.observedCreatedAt, [ref]$observedTime) -or $time -ne $observedTime) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$Observation.expectedNonce) -or
      $Observation.expectedNonce -cne $Observation.reportedNonce) { return $false }
  $expectedExit = if ($ExpectedOutcome -eq "allowed") { 0 } else { 20 }
  return ($Observation.exitCode -eq $expectedExit)
}
function Test-DistinctActorSids([string]$BrokerSid, [string]$LegacySid) {
  return (-not [string]::IsNullOrWhiteSpace($BrokerSid) -and
          -not [string]::IsNullOrWhiteSpace($LegacySid) -and $BrokerSid -cne $LegacySid)
}
function Test-RequiredCases([hashtable]$Cases) {
  $required = @("brokerCreate","brokerRead","legacyControl","legacyCreateDenied","legacyWriteDenied",
    "legacyReadDenied","protectedUnchanged","insecureRejected","sameSidRejected","wrongPidRejected",
    "spoofRejected","missingRejected","timeoutRejected","childTerminated","cleanupComplete")
  if ($Cases.Count -ne $required.Count) { return $false }
  foreach ($key in $required) {
    if (-not $Cases.ContainsKey($key) -or $Cases[$key] -isnot [bool] -or -not $Cases[$key]) { return $false }
  }
  return $true
}
function Get-PhaseAExitCode([string]$Status) {
  switch ($Status) { "GREEN" { return 0 } "RED" { return 1 } default { return 2 } }
}
function Test-SanitizedReport([hashtable]$Report) {
  $keys = @("schema","status","source","cases","cleanup")
  if ($Report.Count -ne $keys.Count) { return $false }
  foreach ($key in $keys) { if (-not $Report.ContainsKey($key)) { return $false } }
  if ($Report.schema -cne "ether.t3.phase-a.v1" -or $Report.status -cne "GREEN" -or
      $Report.source -cne "42f9b5bdf94e47c4c69c0f87127eb545dff13ed1" -or
      $Report.cleanup -cne "complete" -or $Report.cases -isnot [hashtable]) { return $false }
  return (Test-RequiredCases $Report.cases)
}
function Wait-PhaseAProcess($Process, [int]$TimeoutMilliseconds) {
  if ($TimeoutMilliseconds -lt 1 -or $TimeoutMilliseconds -gt 120000) {
    return @{completed=$false; timeout=$false; terminated=$false}
  }
  try {
    if ($Process.WaitForExit($TimeoutMilliseconds)) {
      return @{completed=$true; timeout=$false; terminated=$true}
    }
    try {
      $Process.Kill()
      $terminated = [bool]$Process.WaitForExit(5000)
      return @{completed=$false; timeout=$true; terminated=$terminated}
    } catch { return @{completed=$false; timeout=$true; terminated=$false} }
  } catch { return @{completed=$false; timeout=$false; terminated=$false} }
}
function Test-PhaseAReport([hashtable]$Report) {
  $keys = @("schema","status","source","commit","filesystem","cases","cleanup","brokerTag","legacyTag")
  if ($Report.Count -ne $keys.Count) { return $false }
  foreach ($key in $keys) { if (-not $Report.ContainsKey($key)) { return $false } }
  if ($Report.schema -cne "ether.t3.phase-a.v2" -or $Report.status -cne "GREEN" -or
      $Report.source -cne "42f9b5bdf94e47c4c69c0f87127eb545dff13ed1" -or
      $Report.commit -cnotmatch '^[0-9a-f]{40}$' -or $Report.filesystem -cne "NTFS" -or
      $Report.cleanup -cne "complete" -or $Report.brokerTag -cnotmatch '^[0-9a-f]{64}$' -or
      $Report.legacyTag -cnotmatch '^[0-9a-f]{64}$' -or $Report.brokerTag -ceq $Report.legacyTag -or
      $Report.cases -isnot [hashtable]) { return $false }
  return (Test-RequiredCases $Report.cases)
}
function Test-PhaseAConfig([hashtable]$Config) {
  $keys = @("repository","event","ref","runner","sha","base")
  if ($Config.Count -ne $keys.Count) { return $false }
  foreach ($key in $keys) { if (-not $Config.ContainsKey($key)) { return $false } }
  return ($Config.repository -ceq "andyle777/Ether-Memories" -and
    $Config.event -ceq "push" -and
    $Config.ref -ceq "refs/heads/test/t3-windows-enforcement-run" -and
    $Config.runner -ceq "github-hosted" -and
    $Config.sha -cmatch '^[0-9a-f]{40}$' -and
    $Config.base -ceq "42f9b5bdf94e47c4c69c0f87127eb545dff13ed1")
}
function Test-PhaseAPins([hashtable]$Pins) {
  $expected = @{
    ".t3-phase2-harness/Actor.ps1"="197e2198739c7b5267c7523af746757b74f78f9ba64ba2964941c73d8a02e7a1"
    ".t3-phase2-harness/Invoke-Phase2.ps1"="b7468536670a17d5a42c4eef0ea67bee54f632cba644941ad2e7b1e518cd5bf3"
    ".t3-phase2-harness/JobSupervisor.ps1"="1e975c73e04f04ef819cb4c11252932bfbb9a77367e5e7475d79919e33a98c07"
    ".t3-phase2-harness/Test-JobObject.ps1"="a4fa0aca1b4e9e5115024cc2ba3fe5f7a8a00375ccd688067e3caf2b94017e31"
    ".t3-phase2-harness/README.md"="125bf675e3d2d21f96ac10f5da597369537036f0edf77a3aeb7533759c1744a0"
    "src/persistence/productionOperations.ts"="51afc2951d2997892bd938d63bb77add0a55297b1e86c2cef2be17401dc1129f"
  }
  if ($Pins.Count -ne $expected.Count) { return $false }
  foreach ($key in $expected.Keys) {
    if (-not $Pins.ContainsKey($key) -or $Pins[$key] -cne $expected[$key]) { return $false }
  }
  return $true
}
function Invoke-PhaseAGit([string]$Repository, [string]$Arguments) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = 'git.exe'; $start.Arguments = $Arguments; $start.WorkingDirectory = $Repository
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process; $p.StartInfo = $start
  try {
    if (-not $p.Start()) { return $null }
    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(10000)) { $p.Kill(); $null = $p.WaitForExit(5000); return $null }
    return @{ code=$p.ExitCode; output=$out.Result.Trim(); error=$err.Result }
  } catch { return $null } finally { $p.Dispose() }
}
function Test-PhaseACheckout([string]$Repository, [string]$ExpectedHead, [string]$Base) {
  if ($ExpectedHead -cnotmatch '^[0-9a-f]{40}$' -or $Base -cnotmatch '^[0-9a-f]{40}$') { return $false }
  $head = Invoke-PhaseAGit $Repository 'rev-parse HEAD'
  if ($null -eq $head -or $head.code -ne 0 -or $head.output -cne $ExpectedHead) { return $false }
  $ancestor = Invoke-PhaseAGit $Repository ("merge-base --is-ancestor " + $Base + " " + $ExpectedHead)
  if ($null -eq $ancestor -or $ancestor.code -ne 0) { return $false }
  $clean = Invoke-PhaseAGit $Repository 'diff --quiet HEAD --'
  if ($null -eq $clean -or $clean.code -ne 0) { return $false }
  $pins = @{}
  foreach ($path in @('.t3-phase2-harness/Actor.ps1','.t3-phase2-harness/Invoke-Phase2.ps1',
    '.t3-phase2-harness/JobSupervisor.ps1','.t3-phase2-harness/Test-JobObject.ps1',
    '.t3-phase2-harness/README.md','src/persistence/productionOperations.ts')) {
    try { $pins[$path] = (Get-FileHash -LiteralPath (Join-Path $Repository $path) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    catch { return $false }
  }
  return (Test-PhaseAPins $pins)
}
