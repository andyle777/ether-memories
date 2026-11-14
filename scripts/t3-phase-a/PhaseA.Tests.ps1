$ErrorActionPreference = "Stop"
. "$PSScriptRoot/PhaseA.Core.ps1"
$script:passed = 0
function Check([bool]$value, [string]$name) { if (-not $value) { throw "FAIL: $name" }; $script:passed++ }
$good = @{
  role="broker"; expectedSid="S-1-5-21-1"; observedSid="S-1-5-21-1"; reportedSid="S-1-5-21-1"
  expectedPid=123; reportedPid=123; tokenNonAdmin=$true; tokenObserved=$true
  createdAt="2026-01-01T00:00:00Z"; observedCreatedAt="2026-01-01T00:00:00Z"; reportedNonce="fresh"; expectedNonce="fresh"; exitCode=0; outcome="allowed"
}
Check (Test-ActorObservation $good "broker" "allowed") "valid independent token identity"
foreach ($case in @(
  @{key="observedSid";value="S-1-5-21-2"},
  @{key="reportedSid";value="S-1-5-21-2"},
  @{key="reportedPid";value=124},
  @{key="tokenNonAdmin";value=$false},
  @{key="tokenObserved";value=$false},
  @{key="reportedNonce";value="spoofed"},
  @{key="exitCode";value=1},
  @{key="outcome";value="denied"},
  @{key="createdAt";value=""},
  @{key="observedCreatedAt";value="2026-01-01T00:00:01Z"},
  @{key="observedCreatedAt";value="not-a-time"}
)) {
  $x = $good.Clone(); $x[$case.key] = $case.value
  Check (-not (Test-ActorObservation $x "broker" "allowed")) ("reject invalid " + $case.key)
}
$x = $good.Clone(); $x.expectedPid = 'not-a-pid'
Check (-not (Test-ActorObservation $x "broker" "allowed")) "reject malformed PID without throwing"
Check (-not (Test-ActorObservation @{} "broker" "allowed")) "reject missing observation"
Check (-not (Test-DistinctActorSids "S-1-5-21-1" "S-1-5-21-1")) "reject same SID"
Check (Test-DistinctActorSids "S-1-5-21-1" "S-1-5-21-2") "accept distinct SID"
$cases = @{
 brokerCreate=$true; brokerRead=$true; legacyControl=$true; legacyCreateDenied=$true
 legacyWriteDenied=$true; legacyReadDenied=$true; protectedUnchanged=$true; insecureRejected=$true
 sameSidRejected=$true; wrongPidRejected=$true; spoofRejected=$true; missingRejected=$true
 timeoutRejected=$true; childTerminated=$true; cleanupComplete=$true
}
Check (Test-RequiredCases $cases) "complete set passes"
foreach ($key in @($cases.Keys)) {
 $x=$cases.Clone(); $x.Remove($key)
 Check (-not (Test-RequiredCases $x)) ("missing case " + $key)
 $x=$cases.Clone(); $x[$key]=$false
 Check (-not (Test-RequiredCases $x)) ("false case " + $key)
}
$x=$cases.Clone(); $x['extra']=$true
Check (-not (Test-RequiredCases $x)) "unexpected case rejected"
Check ((Get-PhaseAExitCode 'GREEN') -eq 0) "green exit"
Check ((Get-PhaseAExitCode 'RED') -eq 1) "red exit"
Check ((Get-PhaseAExitCode 'UNVERIFIED') -eq 2) "unverified exit"
Check ((Get-PhaseAExitCode 'PREFLIGHT_READY') -eq 2) "preflight is not green"
$report=@{schema="ether.t3.phase-a.v1";status="GREEN";source="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1";cases=$cases;cleanup="complete"}
Check (Test-SanitizedReport $report) "report allowlist passes"
$x=$report.Clone();$x['password']="bad"
Check (-not (Test-SanitizedReport $x)) "secret extra property rejected"
$x=$report.Clone();$x['cases']=@{}
Check (-not (Test-SanitizedReport $x)) "missing report cases rejected"
$x=$report.Clone();$x['cleanup']="unknown"
Check (-not (Test-SanitizedReport $x)) "cleanup failure rejected"
$script:killed = 0
$fake = New-Object psobject
$fake | Add-Member ScriptMethod WaitForExit { param($ms) return $false }
$fake | Add-Member ScriptMethod Kill { $script:killed++ }
$timed = Wait-PhaseAProcess $fake 1
Check (-not $timed.completed -and $timed.timeout -and $script:killed -eq 1) "timeout kills child and fails closed"
$bad = New-Object psobject
$bad | Add-Member ScriptMethod WaitForExit { param($ms) return $false }
$bad | Add-Member ScriptMethod Kill { throw "mock kill failure" }
$timed = Wait-PhaseAProcess $bad 1
Check (-not $timed.completed -and -not $timed.terminated) "kill failure does not pass"
Write-Output "PASS timeout controls"
$nativePath = Join-Path $PSScriptRoot "PhaseA.Native.ps1"
. $nativePath
$observed = Get-PhaseAProcessToken ([Diagnostics.Process]::GetCurrentProcess())
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Check ($observed.sid -ceq $current -and $observed.pid -eq $PID) "native token query matches current process"
Write-Output "PASS native token self-observation"
$proof = @{
 schema="ether.t3.phase-a.v2"; status="GREEN"; source="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1"
 commit="0123456789abcdef0123456789abcdef01234567"; filesystem="NTFS"; cases=$cases; cleanup="complete"
 brokerTag=("a"*64); legacyTag=("b"*64)
}
Check (Test-PhaseAReport $proof) "complete sanitized schema"
$x=$proof.Clone(); $x['machineName']="private"
Check (-not (Test-PhaseAReport $x)) "report rejects unexpected machine identity"
$x=$proof.Clone(); $x['legacyTag']=$x['brokerTag']
Check (-not (Test-PhaseAReport $x)) "report rejects same identity pseudonym"
$x=$proof.Clone(); $x['cases']=@{}
Check (-not (Test-PhaseAReport $x)) "report rejects missing security cases"
Write-Output "PASS report schema controls"
$config=@{
 repository="andyle777/Ether-Memories"; event="push"; ref="refs/heads/test/t3-windows-enforcement-run"
 runner="github-hosted"; sha="0123456789abcdef0123456789abcdef01234567"
 base="42f9b5bdf94e47c4c69c0f87127eb545dff13ed1"
}
Check (Test-PhaseAConfig $config) "valid hosted configuration"
foreach ($case in @(
 @{key="repository";value="elsewhere/repo"}, @{key="event";value="workflow_dispatch"},
 @{key="ref";value="refs/heads/main"}, @{key="runner";value="self-hosted"},
 @{key="sha";value="not-a-sha"}, @{key="base";value="deadbeef"}
)) {
 $x=$config.Clone();$x[$case.key]=$case.value
 Check (-not (Test-PhaseAConfig $x)) ("reject config " + $case.key)
}
Check (-not (Test-PhaseAConfig @{})) "reject missing configuration"
Write-Output "PASS configuration controls"
$pins = @{
 ".t3-phase2-harness/Actor.ps1"="197e2198739c7b5267c7523af746757b74f78f9ba64ba2964941c73d8a02e7a1"
 ".t3-phase2-harness/Invoke-Phase2.ps1"="b7468536670a17d5a42c4eef0ea67bee54f632cba644941ad2e7b1e518cd5bf3"
 ".t3-phase2-harness/JobSupervisor.ps1"="1e975c73e04f04ef819cb4c11252932bfbb9a77367e5e7475d79919e33a98c07"
 ".t3-phase2-harness/Test-JobObject.ps1"="a4fa0aca1b4e9e5115024cc2ba3fe5f7a8a00375ccd688067e3caf2b94017e31"
 ".t3-phase2-harness/README.md"="125bf675e3d2d21f96ac10f5da597369537036f0edf77a3aeb7533759c1744a0"
 "src/persistence/productionOperations.ts"="51afc2951d2997892bd938d63bb77add0a55297b1e86c2cef2be17401dc1129f"
}
Check (Test-PhaseAPins $pins) "all pinned sources pass"
$x=$pins.Clone();$x["src/persistence/productionOperations.ts"]="0"*64
Check (-not (Test-PhaseAPins $x)) "mismatched source pin rejected"
$x=$pins.Clone();$x.Remove(".t3-phase2-harness/Actor.ps1")
Check (-not (Test-PhaseAPins $x)) "missing pinned source rejected"
Write-Output "PASS source-pin controls"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Check (-not (Test-PhaseACheckout $repo 'not-a-sha' $config.base)) 'malformed checkout SHA rejected'
Check (-not (Test-PhaseACheckout $repo ('0'*40) $config.base)) 'mismatched checkout SHA rejected'
Write-Output 'PASS checkout controls'
Write-Output "PASS: $script:passed assertions total"
