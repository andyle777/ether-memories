[CmdletBinding()]
param(
  [switch]$PreflightOnly,
  [string]$BrokerUser,
  [string]$LegacyUser
)

$ErrorActionPreference = "Stop"
$harness = $PSScriptRoot
$repo = Split-Path -Parent $harness
$runId = [Guid]::NewGuid().ToString("N")
$evidence = Join-Path $harness "evidence\run-$runId"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$transcriptPath = Join-Path $evidence "transcript.txt"
Start-Transcript -Path $transcriptPath -Force | Out-Null

$steps = New-Object System.Collections.Generic.List[object]
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$rootCommit = (& git -C $repo rev-parse HEAD 2>$null | Out-String).Trim()
$branch = (& git -C $repo branch --show-current 2>$null | Out-String).Trim()
$sourceHashes = @(
  Get-ChildItem -LiteralPath $harness -File -Filter "*.ps1" |
    Sort-Object Name |
    ForEach-Object {
      [ordered]@{ path = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
)
$productionSources = @(
  "src\persistence\FsWalStore.ts",
  "src\persistence\productionOperations.ts",
  "src\persistence\recoveryAuthority.ts",
  "src\persistence\directoryIO.ts",
  "src\persistence\FsDurableStore.ts",
  "src\persistence\walIO.ts",
  "tests\b24-t3-pending-write.test.ts"
)
$productionHashes = @(
  foreach ($relative in $productionSources) {
    $file = Join-Path $repo $relative
    if (Test-Path -LiteralPath $file) {
      [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
  }
)
$worktreeStatus = (& git -C $repo status --short 2>$null | Out-String).Trim()
$nodeVersion = if (Get-Command node -ErrorAction SilentlyContinue) { (& node --version 2>$null | Out-String).Trim() } else { $null }
$requiredPhase1Hash = "51afc2951d2997892bd938d63bb77add0a55297b1e86c2cef2be17401dc1129f"
$phase1SourcePath = Join-Path $repo "src\persistence\productionOperations.ts"
$phase1ActualHash = if (Test-Path -LiteralPath $phase1SourcePath) { (Get-FileHash -LiteralPath $phase1SourcePath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
$phase1MismatchProbe = Join-Path $env:TEMP "ether-phase1-sha256-mismatch-probe-$([Guid]::NewGuid().ToString('N')).ts"
$hashMismatchProbeValue = $null
if (Test-Path -LiteralPath $phase1SourcePath) {
  Copy-Item -LiteralPath $phase1SourcePath -Destination $phase1MismatchProbe -Force
  Add-Content -LiteralPath $phase1MismatchProbe -Value "// mismatch probe"
  $hashMismatchProbeValue = (Get-FileHash -LiteralPath $phase1MismatchProbe -Algorithm SHA256).Hash.ToLowerInvariant()
}

$environment = [ordered]@{
  capturedUtc = [DateTime]::UtcNow.ToString("o")
  computerName = $env:COMPUTERNAME
  identity = $identity.Name
  identitySid = $identity.User.Value
  elevatedAdministrator = $isAdmin
  integrity = ((& whoami /groups 2>$null | Select-String "Mandatory Label" | ForEach-Object { $_.Line.Trim() }) -join "; ")
  osVersion = [Environment]::OSVersion.VersionString
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  nodeVersion = $nodeVersion
  currentDirectory = $repo
  gitBranch = $branch
  gitHead = $rootCommit
  gitStatusShort = $worktreeStatus
  phase1SourceSha256Claim = $requiredPhase1Hash
  phase1SourceSha256Actual = $phase1ActualHash
  phase1SourceSha256Verification = if ($phase1ActualHash -eq $requiredPhase1Hash) { "Matches the SHA-256 of src\persistence\productionOperations.ts in this checkout." } else { "MISMATCH DETECTED: actual hash does not match the pinned Phase 1 preservation invariant." }
  phase1SourceSha256MismatchProbe = $hashMismatchProbeValue
  phase1SourceSha256MismatchProbeDetected = if ($null -ne $hashMismatchProbeValue) { $hashMismatchProbeValue -ne $requiredPhase1Hash } else { $false }
  harnessHashes = $sourceHashes
  productionAndRegressionSourceHashes = $productionHashes
}

function Ensure-ParentDirectory([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath)) { return }
  $parent = Split-Path -Parent $TargetPath
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Save-Report([string]$status, [string]$reason) {
  $report = [ordered]@{
    mission = "ORION ASCENDANT - ETHER MEMORIES T3 Phase 2 Windows Enforcement"
    enforcementResult = $status
    reason = $reason
    environment = $environment
    tests = @($steps.ToArray())
    limitations = @(
      "The harness is disposable and does not modify production persistence files.",
      "A same-user or simulated-token result is not proof of Windows ACL enforcement.",
      "The existing-handle case intentionally tests whether a previously granted handle survives a later DACL change.",
      "The stale-lock case separates kernel handle exclusion from application policy for refusing stale authority.",
      "Pending transaction visibility must be checked against the application regression test; this harness does not invent a production transaction."
    )
  }
  Ensure-ParentDirectory (Join-Path $evidence "report.json")
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence "report.json") -Encoding UTF8
  Write-Output "Evidence directory: $evidence"
  Write-Output "Enforcement result: $status"
}

try {
  $testTempBase = Join-Path $env:SystemRoot "Temp"
  if (-not (Test-Path -LiteralPath $testTempBase -PathType Container)) {
    throw "The system temp directory is unavailable; a per-user temp directory is not suitable for authentic cross-identity probes."
  }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($testTempBase))
  $environment.testTempBase = $testTempBase
  $environment.tempVolume = $drive.Name
  $environment.tempFileSystem = $drive.DriveFormat

  if ($PreflightOnly -or -not $isAdmin) {
    $steps.Add([ordered]@{
      id = "host-capability"
      status = if ($isAdmin -and $drive.DriveFormat -eq "NTFS") { "READY" } else { "UNVERIFIED" }
      detail = "Administrator=$isAdmin; temp volume=$($drive.Name); filesystem=$($drive.DriveFormat)."
    })
    if (-not $isAdmin) {
      Save-Report "UNVERIFIED" "The current token is not elevated; it cannot provision the isolated ACL and identity test boundary."
      exit 3
    }
    if ($drive.DriveFormat -ne "NTFS") {
      Save-Report "UNVERIFIED" "The temporary volume is not NTFS; the requested NTFS ACL and hard-link proof cannot run there."
      exit 3
    }
    Save-Report "PREFLIGHT_READY" "The host is elevated and the temporary volume is NTFS; run without -PreflightOnly to execute tests."
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($BrokerUser)) {
    $BrokerUser = Read-Host "Dedicated broker account (DOMAIN\user or COMPUTER\user)"
  }
  if ([string]::IsNullOrWhiteSpace($LegacyUser)) {
    $LegacyUser = Read-Host "Dedicated legacy-writer account (DOMAIN\user or COMPUTER\user)"
  }
  if ($BrokerUser -eq $LegacyUser) {
    throw "BrokerUser and LegacyUser must identify different Windows accounts."
  }
  $brokerCredential = Get-Credential -UserName $BrokerUser -Message "Broker account credential"
  $legacyCredential = Get-Credential -UserName $LegacyUser -Message "Legacy-writer account credential"
  $brokerSid = ([Security.Principal.NTAccount]::new($BrokerUser)).Translate([Security.Principal.SecurityIdentifier]).Value
  $legacySid = ([Security.Principal.NTAccount]::new($LegacyUser)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($brokerSid -eq $legacySid -or $brokerCredential.UserName -eq $legacyCredential.UserName) {
    throw "The resolved broker and legacy credentials are not distinct."
  }
  $environment.brokerAccount = $BrokerUser
  $environment.brokerSid = $brokerSid
  $environment.legacyAccount = $LegacyUser
  $environment.legacySid = $legacySid
  if ($drive.DriveFormat -ne "NTFS") {
    throw "The temporary volume is not NTFS; no ACL test will be reported as a pass."
  }

  $testRoot = Join-Path $testTempBase "EtherPhase2-$runId"
  $dataRoot = Join-Path $testRoot "broker-data"
  $shared = Join-Path $testTempBase "EtherPhase2-shared-$runId"
  $support = Join-Path $testTempBase "EtherPhase2-support-$runId"
  $actorEvidenceRoot = Join-Path $evidence "actors"
  New-Item -ItemType Directory -Path $testRoot,$dataRoot,$shared,$support,$actorEvidenceRoot -Force | Out-Null

  function Set-DirectoryAllowList([string]$Path, [string[]]$Sids) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $Sids) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.SetAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Set-FileAllowList([string]$Path, [string[]]$Sids) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $Sids) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.SetAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Get-InventorySnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    Get-ChildItem -LiteralPath $Root -Recurse -Force | Sort-Object FullName | ForEach-Object {
      $relative = if ($_.FullName.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        $_.FullName.Substring($rootPath.Length + 1)
      } else {
        $_.Name
      }
      $kind = if ($_.PSIsContainer) { "directory" } else { "file" }
      $size = if ($kind -eq "file") { [int]$_.Length } else { 0 }
      $sha256 = if ($kind -eq "file") { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
      [pscustomobject]@{
        path = $relative
        kind = $kind
        size = $size
        sha256 = $sha256
      }
    }
  }

  function Normalize-InventoryPath([string]$Root, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $fullRoot = [System.IO.Path]::GetFullPath($Root)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $fullPath.Substring($fullRoot.Length + 1)
    }
    return $Path
  }

  function Resolve-IdentitySid([string]$IdentityName) {
    if ([string]::IsNullOrWhiteSpace($IdentityName)) { return $null }
    try {
      return ([Security.Principal.NTAccount]::new($IdentityName)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      return $null
    }
  }

  function Set-RestrictedEvidenceRoot([string]$Path, [string[]]$ActorSids) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $manageRights = [Security.AccessControl.FileSystemRights]::FullControl
    foreach ($sid in @($ownerSid, $systemSid, $adminsSid) | Select-Object -Unique) {
      if ([string]::IsNullOrWhiteSpace($sid)) { continue }
      $manageRule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        $manageRights,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.SetAccessRule($manageRule)
    }
    $sharedRootReadRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    foreach ($sid in @($ActorSids | Select-Object -Unique)) {
      if ([string]::IsNullOrWhiteSpace($sid)) { continue }
      $readRule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        $sharedRootReadRights,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.SetAccessRule($readRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Set-RestrictedActorDirectory([string]$Path, [string[]]$AdditionalSids = @(), [string]$ActorSid = $null) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allAllowed = @($ownerSid, $systemSid, $adminsSid) + $AdditionalSids + @($ActorSid) | Select-Object -Unique
    foreach ($sid in $allAllowed) {
      if ([string]::IsNullOrWhiteSpace($sid)) { continue }
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.SetAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Start-IdentityActor([string]$Mode, [string]$Path, [PSCredential]$Credential, [string]$ReadyPath, [string]$TriggerPath, [string]$ResultPath, [int]$TimeoutSeconds = 30) {
    $args = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$actorPath`"", "-Mode", $Mode)
    if ($Path) { $args += @("-Path", "`"$Path`"") }
    if ($ReadyPath) { $args += @("-ReadyPath", "`"$ReadyPath`"") }
    if ($TriggerPath) { $args += @("-TriggerPath", "`"$TriggerPath`"") }
    if ($ResultPath) { $args += @("-ResultPath", "`"$ResultPath`"") }
    $process = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -Credential $Credential `
      -ArgumentList $args -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force
      throw "Actor timed out: $Mode, PID $($process.Id)."
    }
    $process.Refresh()
    $record = $null
    $pidMatchesObservedProcess = $false
    $sidMatchesObservedIdentity = $false
    $accepted = $false
    $expectedSid = $null
    if ($Credential) {
      $expectedSid = Resolve-IdentitySid $Credential.UserName
    }
    if ($ResultPath -and (Test-Path -LiteralPath $ResultPath)) {
      $record = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
      if ($record -and $record.pid -ne $null) {
        $reportedPid = [int]$record.pid
        $pidMatchesObservedProcess = ($reportedPid -eq $process.Id)
        $record | Add-Member -NotePropertyName pidMatchesObservedProcess -NotePropertyValue $pidMatchesObservedProcess -Force
      }
      if ($record -and $record.sid -ne $null) {
        $sidMatchesObservedIdentity = ($expectedSid -and $record.sid -eq $expectedSid)
        $record | Add-Member -NotePropertyName sidMatchesObservedIdentity -NotePropertyValue $sidMatchesObservedIdentity -Force
      }
    }
    $accepted = ($record -and $pidMatchesObservedProcess -and $sidMatchesObservedIdentity)
    if ($record) {
      $record | Add-Member -NotePropertyName accepted -NotePropertyValue $accepted -Force
    }
    [pscustomobject]@{ exitCode = $process.ExitCode; pid = $process.Id; result = $record; pidMatchesObservedProcess = $pidMatchesObservedProcess; sidMatchesObservedIdentity = $sidMatchesObservedIdentity; accepted = $accepted }
  }

  function Get-InventoryDelta([object[]]$Before, [object[]]$After) {
    $beforeMap = @{}
    foreach ($entry in @($Before)) { if ($entry -and $entry.path) { $beforeMap[$entry.path] = $entry } }
    $afterMap = @{}
    foreach ($entry in @($After)) { if ($entry -and $entry.path) { $afterMap[$entry.path] = $entry } }
    $changes = New-Object System.Collections.Generic.List[object]
    foreach ($key in ($beforeMap.Keys + $afterMap.Keys | Select-Object -Unique)) {
      $beforeEntry = $beforeMap[$key]
      $afterEntry = $afterMap[$key]
      $beforeToken = if ($beforeEntry) { "$($beforeEntry.kind)|$($beforeEntry.size)|$($beforeEntry.sha256)" } else { $null }
      $afterToken = if ($afterEntry) { "$($afterEntry.kind)|$($afterEntry.size)|$($afterEntry.sha256)" } else { $null }
      if ($beforeToken -ne $afterToken) {
        $changes.Add([pscustomobject]@{ path = $key; before = $beforeEntry; after = $afterEntry })
      }
    }
    return @($changes)
  }

  function Add-ActorEvidenceBaseline([object[]]$Snapshot, [hashtable]$Baseline) {
    foreach ($entry in @($Snapshot)) {
      if ($entry -and $entry.path -and -not $Baseline.ContainsKey($entry.path)) {
        $Baseline[$entry.path] = $entry
      }
    }
  }

  function Test-ActorEvidenceAcl([object[]]$AccessRules, [string[]]$ExpectedSids, [string[]]$ManagerSids = @()) {
    $readRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    $allowedRights = $readRights -bor [Security.AccessControl.FileSystemRights]::Synchronize
    $actors = @{}
    foreach ($sid in @($ExpectedSids | Select-Object -Unique)) {
      $matching = @($AccessRules | Where-Object { $_.sid -eq $sid })
      $allows = @($matching | Where-Object { $_.accessType -eq [Security.AccessControl.AccessControlType]::Allow })
      $denies = @($matching | Where-Object { $_.accessType -eq [Security.AccessControl.AccessControlType]::Deny })
      $validAllows = @($allows | Where-Object {
        (($_.rights -band $readRights) -eq $readRights) -and
        (($_.rights -band (-bnot $allowedRights)) -eq 0)
      })
      $actors[$sid] = [pscustomobject]@{
        allowCount = $allows.Count
        denyCount = $denies.Count
        validAllowCount = $validAllows.Count
        accepted = ($allows.Count -gt 0 -and $denies.Count -eq 0 -and $validAllows.Count -eq $allows.Count)
      }
    }
    $unexpectedAccess = @($AccessRules | Where-Object {
      $_.accessType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.sid -notin $ManagerSids -and
      $_.sid -notin $ExpectedSids
    })
    $accepted = ($unexpectedAccess.Count -eq 0)
    foreach ($sid in $actors.Keys) {
      if (-not $actors[$sid].accepted) { $accepted = $false }
    }
    [pscustomobject]@{ accepted = $accepted; actors = $actors; unexpectedAccess = $unexpectedAccess }
  }

  function Compare-ActorEvidenceInventory([object[]]$Actual, [object[]]$Expected, [hashtable]$Baseline) {
    $actualMap = @{}
    foreach ($entry in @($Actual)) { if ($entry -and $entry.path) { $actualMap[$entry.path] = $entry } }
    $expectedMap = @{}
    foreach ($entry in @($Expected)) { if ($entry -and $entry.path) { $expectedMap[$entry.path] = $entry } }
    $unexpected = @($Actual | Where-Object { -not $expectedMap.ContainsKey($_.path) })
    $missing = @($Expected | Where-Object {
      -not $actualMap.ContainsKey($_.path) -or
      $actualMap[$_.path].kind -ne $_.kind -or
      ($_.kind -eq "file" -and -not $Baseline.ContainsKey($_.path))
    })
    $modified = @()
    foreach ($path in $Baseline.Keys) {
      $before = $Baseline[$path]
      $after = $actualMap[$path]
      if (-not $after -or $before.kind -ne $after.kind -or $before.size -ne $after.size -or $before.sha256 -ne $after.sha256) {
        $modified += [pscustomobject]@{ path = $path; before = $before; after = $after }
      }
    }
    [pscustomobject]@{
      accepted = ($unexpected.Count -eq 0 -and $missing.Count -eq 0 -and $modified.Count -eq 0)
      unexpected = $unexpected
      missing = $missing
      modified = @($modified)
    }
  }

  function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $Path)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for $Path." }
      Start-Sleep -Milliseconds 50
    }
  }

  function Parse-JobReadyRecord([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "jobReady record is missing: $Path." }
    $raw = Get-Content -LiteralPath $Path -Raw
    $lines = @($raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
    if ($lines.Count -lt 2) { throw "jobReady record is empty or missing required child process IDs." }
    if (($lines | Group-Object | Where-Object { $_.Count -gt 1 }).Count -gt 0) { throw "jobReady record contains duplicate process IDs." }
    foreach ($line in $lines) {
      if (-not ($line -match '^\d+$')) { throw "jobReady record contains a malformed PID: '$line'." }
    }
    return $lines
  }

  function Add-Test([string]$Id, [string]$Status, [string]$Detail, $Data = $null) {
    $steps.Add([ordered]@{ id = $Id; status = $Status; detail = $Detail; data = $Data })
    Write-Output "$Id : $Status - $Detail"
  }

  $phase1Expected = if ($phase1ActualHash -eq $requiredPhase1Hash) { "GREEN" } else { "RED" }
  Add-Test "phase1-source-sha256" $phase1Expected "Pinned Phase 1 SHA-256 check for src\persistence\productionOperations.ts: actual $phase1ActualHash, required $requiredPhase1Hash." @{
    expected = $requiredPhase1Hash
    actual = $phase1ActualHash
    mismatchProbe = $hashMismatchProbeValue
    mismatchDetected = if ($null -ne $hashMismatchProbeValue) { $hashMismatchProbeValue -ne $requiredPhase1Hash } else { $false }
  }
  if ($phase1Expected -eq "RED") {
    Save-Report "RED" "Phase 1 SHA-256 mismatch detected; the trusted reviewer requirement is violated."
    exit 4
  }

  $systemSid = "S-1-5-18"
  $adminsSid = "S-1-5-32-544"
  Set-DirectoryAllowList $testRoot @($systemSid, $adminsSid, $brokerSid)
  Set-DirectoryAllowList $dataRoot @($systemSid, $adminsSid, $brokerSid)
  $actorPath = Join-Path $support "Actor.ps1"
  $jobSupervisorPath = Join-Path $support "JobSupervisor.ps1"
  Copy-Item -LiteralPath (Join-Path $harness "Actor.ps1") -Destination $actorPath
  Copy-Item -LiteralPath (Join-Path $harness "JobSupervisor.ps1") -Destination $jobSupervisorPath
  Set-RestrictedEvidenceRoot $actorEvidenceRoot @($brokerSid, $legacySid)
  $actorRootAcl = Get-Acl -LiteralPath $actorEvidenceRoot
  $sharedRootForbidden = [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  $actorRootAccess = @($actorRootAcl.Access | ForEach-Object {
    $resolvedSid = try {
      $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      $_.IdentityReference.Value
    }
    [pscustomobject]@{
      rawIdentity = $_.IdentityReference.Value
      sid = $resolvedSid
      rights = $_.FileSystemRights
      accessType = $_.AccessControlType
    }
  })
  $rootManagerSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, $systemSid, $adminsSid)
  $actorAclCheck = Test-ActorEvidenceAcl $actorRootAccess @($brokerSid, $legacySid) $rootManagerSids
  $unexpectedRootAccess = @($actorAclCheck.unexpectedAccess)
  $actorAclViolations = @($actorRootAccess | Where-Object {
    $_.sid -in @($brokerSid, $legacySid) -and (
      $_.accessType -eq [Security.AccessControl.AccessControlType]::Allow -and
      (($_.rights -band $sharedRootForbidden) -ne 0)
    )
  })
  Add-Test "actor-evidence-parent-acl" $(if ($actorAclCheck.accepted -and $actorAclViolations.Count -eq 0) { "GREEN" } else { "RED" }) "Both expected actor SIDs must have an Allow ACE containing only read/traversal rights on the shared parent; no other non-manager SID may have an Allow ACE." @{
    actorRoot = $actorEvidenceRoot
    actorAccess = @($actorRootAccess)
    forbiddenRights = $sharedRootForbidden
    actorChecks = $actorAclCheck.actors
    violatingAccess = @($actorAclViolations)
    unexpectedNonActorAllowAccess = @($unexpectedRootAccess)
  }
  $actorInventoryBefore = Get-InventorySnapshot $actorEvidenceRoot
  $protectedDataBefore = @()
  $protectedDataAfter = @()
  $expectedActorEvidence = [System.Collections.Generic.List[object]]::new()
  $actorEvidenceBaseline = @{}

  $brokerFile = Join-Path $dataRoot "broker-only.txt"
  $brokerActorDir = Join-Path $actorEvidenceRoot "broker-write-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $brokerActorDir -Force | Out-Null
  $expectedActorEvidence.Add([pscustomobject]@{ path = $brokerActorDir; kind = "directory" })
  Set-RestrictedActorDirectory $brokerActorDir @() $brokerSid
  $brokerResultPath = Join-Path $brokerActorDir "result.json"
  $expectedActorEvidence.Add([pscustomobject]@{ path = $brokerResultPath; kind = "file" })
  $brokerWrite = Start-IdentityActor "Write" $brokerFile $brokerCredential $null $null $brokerResultPath
  Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
  if ($brokerWrite.exitCode -eq 0 -and $brokerWrite.accepted) {
    $protectedDataBefore = Get-InventorySnapshot $dataRoot
    Add-Test "broker-write-authority" "GREEN" "The dedicated broker token created a file in the protected data root." $brokerWrite.result
  } else {
    Add-Test "broker-write-authority" "RED" "The broker write failed or ran under a different SID." $brokerWrite.result
  }

  $legacyActorDir = Join-Path $actorEvidenceRoot "legacy-write-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $legacyActorDir -Force | Out-Null
  $expectedActorEvidence.Add([pscustomobject]@{ path = $legacyActorDir; kind = "directory" })
  Set-RestrictedActorDirectory $legacyActorDir @() $legacySid
  $legacyResultPath = Join-Path $legacyActorDir "result.json"
  $expectedActorEvidence.Add([pscustomobject]@{ path = $legacyResultPath; kind = "file" })
  $legacyBefore = Get-InventorySnapshot $dataRoot
  $legacyWrite = Start-IdentityActor "Write" $brokerFile $legacyCredential $null $null $legacyResultPath
  Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
  $legacyAfter = Get-InventorySnapshot $dataRoot
  $legacyDeniedDelta = Get-InventoryDelta $legacyBefore $legacyAfter
  if ($legacyWrite.exitCode -eq 20 -and $legacyWrite.accepted) {
    Add-Test "authentic-legacy-exclusion" "GREEN" "A distinct legacy token was denied a new write to the broker-protected root." $legacyWrite.result
  } else {
    Add-Test "authentic-legacy-exclusion" "RED" "The legacy token was not reliably excluded from a new write." $legacyWrite.result
  }
  if (@($legacyDeniedDelta).Count -gt 0) {
    Add-Test "legacy-write-protected-data" "RED" "Denied legacy write changed the protected data inventory." @{
      before = $legacyBefore
      after = $legacyAfter
      delta = @($legacyDeniedDelta)
    }
  }

  $extendedActorDir = Join-Path $actorEvidenceRoot "extended-alias-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $extendedActorDir -Force | Out-Null
  $expectedActorEvidence.Add([pscustomobject]@{ path = $extendedActorDir; kind = "directory" })
  Set-RestrictedActorDirectory $extendedActorDir @() $legacySid
  $extendedPath = "\\?\$brokerFile"
  $extendedResultPath = Join-Path $extendedActorDir "result.json"
  $expectedActorEvidence.Add([pscustomobject]@{ path = $extendedResultPath; kind = "file" })
  $extendedBefore = Get-InventorySnapshot $dataRoot
  $extendedWrite = Start-IdentityActor "Write" $extendedPath $legacyCredential $null $null $extendedResultPath
  Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
  $extendedAfter = Get-InventorySnapshot $dataRoot
  $extendedDeniedDelta = Get-InventoryDelta $extendedBefore $extendedAfter
  $extendedStatus = if ($extendedWrite.exitCode -eq 20 -and $extendedWrite.accepted) { "GREEN" } else { "RED" }
  Add-Test "extended-path-alias" $extendedStatus `
    "Legacy write through the Win32 extended-length path prefix returned exit $($extendedWrite.exitCode)." $extendedWrite.result
  if (@($extendedDeniedDelta).Count -gt 0) {
    Add-Test "extended-path-alias-protected-data" "RED" "Denied extended-path write changed the protected data inventory." @{
      before = $extendedBefore
      after = $extendedAfter
      delta = @($extendedDeniedDelta)
    }
  }

  try {
    $hardlinkPath = Join-Path $shared "hardlink.txt"
    New-Item -ItemType HardLink -Path $hardlinkPath -Target $brokerFile | Out-Null
    $hardlinkActorDir = Join-Path $actorEvidenceRoot "hardlink-alias-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $hardlinkActorDir -Force | Out-Null
    $expectedActorEvidence.Add([pscustomobject]@{ path = $hardlinkActorDir; kind = "directory" })
    Set-RestrictedActorDirectory $hardlinkActorDir @() $legacySid
    $hardlinkResultPath = Join-Path $hardlinkActorDir "result.json"
    $expectedActorEvidence.Add([pscustomobject]@{ path = $hardlinkResultPath; kind = "file" })
    $hardlinkBefore = Get-InventorySnapshot $dataRoot
    $hardlinkWrite = Start-IdentityActor "Write" $hardlinkPath $legacyCredential $null $null $hardlinkResultPath
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    $hardlinkAfter = Get-InventorySnapshot $dataRoot
    $hardlinkDeniedDelta = Get-InventoryDelta $hardlinkBefore $hardlinkAfter
    $hardlinkStatus = if ($hardlinkWrite.exitCode -eq 20 -and $hardlinkWrite.accepted) { "GREEN" } else { "RED" }
    Add-Test "hardlink-alias" $hardlinkStatus `
      "Legacy write through a hard link to the protected file returned exit $($hardlinkWrite.exitCode)." $hardlinkWrite.result
    if (@($hardlinkDeniedDelta).Count -gt 0) {
      Add-Test "hardlink-alias-protected-data" "RED" "Denied hard-link write changed the protected data inventory." @{
        before = $hardlinkBefore
        after = $hardlinkAfter
        delta = @($hardlinkDeniedDelta)
      }
    }
  } catch {
    Add-Test "hardlink-alias" "UNVERIFIED" "Hard-link setup or test failed: $($_.Exception.Message)"
  }

  try {
    $junctionPath = Join-Path $shared "broker-root-junction"
    New-Item -ItemType Junction -Path $junctionPath -Target $dataRoot | Out-Null
    $junctionActorDir = Join-Path $actorEvidenceRoot "junction-alias-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $junctionActorDir -Force | Out-Null
    $expectedActorEvidence.Add([pscustomobject]@{ path = $junctionActorDir; kind = "directory" })
    Set-RestrictedActorDirectory $junctionActorDir @() $legacySid
    $junctionResultPath = Join-Path $junctionActorDir "result.json"
    $expectedActorEvidence.Add([pscustomobject]@{ path = $junctionResultPath; kind = "file" })
    $junctionBefore = Get-InventorySnapshot $dataRoot
    $junctionWrite = Start-IdentityActor "Write" (Join-Path $junctionPath "broker-only.txt") $legacyCredential $null $null $junctionResultPath
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    $junctionAfter = Get-InventorySnapshot $dataRoot
    $junctionDeniedDelta = Get-InventoryDelta $junctionBefore $junctionAfter
    $junctionStatus = if ($junctionWrite.exitCode -eq 20 -and $junctionWrite.accepted) { "GREEN" } else { "RED" }
    Add-Test "junction-alias" $junctionStatus `
      "Legacy write through a junction to the protected root returned exit $($junctionWrite.exitCode)." $junctionWrite.result
    if (@($junctionDeniedDelta).Count -gt 0) {
      Add-Test "junction-alias-protected-data" "RED" "Denied junction write changed the protected data inventory." @{
        before = $junctionBefore
        after = $junctionAfter
        delta = @($junctionDeniedDelta)
      }
    }
  } catch {
    Add-Test "junction-alias" "UNVERIFIED" "Junction setup or test failed: $($_.Exception.Message)"
  }

  $heldFile = Join-Path $shared "preexisting-handle.dat"
  [IO.File]::WriteAllText($heldFile, "preexisting")
  Set-FileAllowList $heldFile @($systemSid, $adminsSid, $brokerSid, $legacySid)
  $heldActorDir = Join-Path $actorEvidenceRoot "held-write-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $heldActorDir -Force | Out-Null
  $expectedActorEvidence.Add([pscustomobject]@{ path = $heldActorDir; kind = "directory" })
  Set-RestrictedActorDirectory $heldActorDir @() $legacySid
  $heldReady = Join-Path $heldActorDir "ready.txt"
  $heldTrigger = Join-Path $heldActorDir "trigger.txt"
  $heldResult = Join-Path $heldActorDir "result.json"
  $expectedActorEvidence.Add([pscustomobject]@{ path = $heldReady; kind = "file" })
  $expectedActorEvidence.Add([pscustomobject]@{ path = $heldTrigger; kind = "file" })
  $expectedActorEvidence.Add([pscustomobject]@{ path = $heldResult; kind = "file" })
  $heldArgs = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$actorPath`"",
    "-Mode", "HoldWrite", "-Path", "`"$heldFile`"", "-ReadyPath", "`"$heldReady`"",
    "-TriggerPath", "`"$heldTrigger`"", "-ResultPath", "`"$heldResult`"")
  $heldProcess = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -Credential $legacyCredential `
    -ArgumentList $heldArgs -PassThru -WindowStyle Hidden
  try {
    Wait-ForFile $heldReady
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    Set-FileAllowList $heldFile @($systemSid, $adminsSid, $brokerSid)
    [IO.File]::WriteAllText($heldTrigger, "go")
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    if (-not $heldProcess.WaitForExit(30000)) {
      Stop-Process -Id $heldProcess.Id -Force
      throw "The preexisting-handle actor did not finish."
    }
    $heldRecord = Get-Content -LiteralPath $heldResult -Raw | ConvertFrom-Json
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    if ($heldRecord.sid -ne $legacySid) { throw "The preexisting-handle actor SID did not match the legacy SID." }
    $handleStatus = if ($heldRecord.status -eq "existing-handle-write-succeeded") { "RED" } else { "GREEN" }
    Add-Test "existing-writable-handle" $handleStatus `
      "After the legacy process opened a write handle, its DACL grant was removed before the handle wrote." $heldRecord
  } finally {
    if (-not $heldProcess.HasExited) { Stop-Process -Id $heldProcess.Id -Force }
  }

  $lockPath = Join-Path $shared "writer.lock"
  $lockActorDir = Join-Path $actorEvidenceRoot "lock-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $lockActorDir -Force | Out-Null
  $expectedActorEvidence.Add([pscustomobject]@{ path = $lockActorDir; kind = "directory" })
  Set-RestrictedActorDirectory $lockActorDir @() $brokerSid
  $lockReady = Join-Path $lockActorDir "ready.txt"
  $lockTrigger = Join-Path $lockActorDir "trigger.txt"
  $lockResult = Join-Path $lockActorDir "result.json"
  $expectedActorEvidence.Add([pscustomobject]@{ path = $lockReady; kind = "file" })
  $lockArgs = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$actorPath`"",
    "-Mode", "HoldLock", "-Path", "`"$lockPath`"", "-ReadyPath", "`"$lockReady`"",
    "-TriggerPath", "`"$lockTrigger`"", "-ResultPath", "`"$lockResult`"")
  $oldBroker = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -Credential $brokerCredential `
    -ArgumentList $lockArgs -PassThru -WindowStyle Hidden
  try {
    Wait-ForFile $lockReady
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    $busyActorDir = Join-Path $actorEvidenceRoot "lock-busy-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $busyActorDir -Force | Out-Null
    $expectedActorEvidence.Add([pscustomobject]@{ path = $busyActorDir; kind = "directory" })
    Set-RestrictedActorDirectory $busyActorDir @() $brokerSid
    $busyResultPath = Join-Path $busyActorDir "result.json"
    $expectedActorEvidence.Add([pscustomobject]@{ path = $busyResultPath; kind = "file" })
    $busyBefore = Get-InventorySnapshot $dataRoot
    $busyAttempt = Start-IdentityActor "TryLock" $lockPath $brokerCredential $null $null $busyResultPath
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    $busyAfter = Get-InventorySnapshot $dataRoot
    $busyDeniedDelta = Get-InventoryDelta $busyBefore $busyAfter
    $liveLockStatus = if ($busyAttempt.exitCode -eq 21 -and $busyAttempt.accepted) { "GREEN" } else { "RED" }
    Add-Test "stale-broker-live-handle" $liveLockStatus `
      "A second broker attempted exclusive open while the first broker held the lock; exit $($busyAttempt.exitCode)." $busyAttempt.result
    if (@($busyDeniedDelta).Count -gt 0) {
      Add-Test "stale-broker-live-handle-protected-data" "RED" "The active lock probe modified the protected data inventory." @{
        before = $busyBefore
        after = $busyAfter
        delta = @($busyDeniedDelta)
      }
    }
    Stop-Process -Id $oldBroker.Id -Force
    $oldBroker.WaitForExit()
    $afterDeathActorDir = Join-Path $actorEvidenceRoot "lock-after-death-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $afterDeathActorDir -Force | Out-Null
    $expectedActorEvidence.Add([pscustomobject]@{ path = $afterDeathActorDir; kind = "directory" })
    Set-RestrictedActorDirectory $afterDeathActorDir @() $brokerSid
    $afterDeathResult = Join-Path $afterDeathActorDir "result.json"
    $expectedActorEvidence.Add([pscustomobject]@{ path = $afterDeathResult; kind = "file" })
    $afterDeathBefore = Get-InventorySnapshot $dataRoot
    $afterDeath = Start-IdentityActor "TryLock" $lockPath $brokerCredential $null $null $afterDeathResult
    Add-ActorEvidenceBaseline (Get-InventorySnapshot $actorEvidenceRoot) $actorEvidenceBaseline
    $afterDeathAfter = Get-InventorySnapshot $dataRoot
    $afterDeathDelta = Get-InventoryDelta $afterDeathBefore $afterDeathAfter
    $takeover = if ($afterDeath.exitCode -eq 0 -and $afterDeath.accepted) { "RED" } elseif ($afterDeath.exitCode -ne 0) { "GREEN" } else { "RED" }
    Add-Test "stale-lock-policy-boundary" $takeover `
      "After broker death, Windows released its handle but retained writer.lock; raw OS exclusivity alone does not enforce stale-lock refusal." $afterDeath.result
    if (@($afterDeathDelta).Count -gt 0) {
      Add-Test "stale-lock-policy-boundary-protected-data" "RED" "The stale lock boundary check mutated the protected data inventory." @{
        before = $afterDeathBefore
        after = $afterDeathAfter
        delta = @($afterDeathDelta)
      }
    }
  } finally {
    if (-not $oldBroker.HasExited) { Stop-Process -Id $oldBroker.Id -Force }
  }

  $jobReady = Join-Path $shared "job-ready.txt"
  $supervisor = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") `
    -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$jobSupervisorPath`"",
      "-WorkerScript", "`"$actorPath`"", "-ReadyPath", "`"$jobReady`"") -PassThru -WindowStyle Hidden
  try {
    Wait-ForFile $jobReady
    $jobPids = @()
    try {
      $jobPids = Parse-JobReadyRecord $jobReady
    } catch {
      Add-Test "job-ready-record" "UNVERIFIED" $_.Exception.Message @{
        path = $jobReady
        record = if (Test-Path -LiteralPath $jobReady) { Get-Content -LiteralPath $jobReady -Raw } else { $null }
      }
      throw
    }
    $workerPid = [int]$jobPids[1]
    Stop-Process -Id $supervisor.Id -Force
    $supervisor.WaitForExit()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $workerAlive = $true
    while ($workerAlive -and [DateTime]::UtcNow -lt $deadline) {
      $workerAlive = [bool](Get-Process -Id $workerPid -ErrorAction SilentlyContinue)
      if ($workerAlive) { Start-Sleep -Milliseconds 100 }
    }
    Add-Test "job-object-supervisor-crash-cleanup" $(if (-not $workerAlive) { "GREEN" } else { "RED" }) `
      "Supervisor PID $($jobPids[0]) was terminated; assigned worker PID $workerPid alive=$workerAlive."
  } finally {
    if (-not $supervisor.HasExited) { Stop-Process -Id $supervisor.Id -Force }
  }

  $pendingTest = Join-Path $repo "tests\b24-t3-pending-write.test.ts"
  if (Test-Path -LiteralPath $pendingTest) {
    $vitest = Join-Path $repo "node_modules\.bin\vitest.cmd"
    $testOutput = Join-Path $evidence "pending-write-vitest.txt"
    Push-Location $repo
    try {
      & $vitest run "tests\b24-t3-pending-write.test.ts" "tests\b24-t3-admission.test.ts" "tests\b24-t3-session.test.ts" 2>&1 |
        Tee-Object -FilePath $testOutput
      $testExit = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    Add-Test "pending-transaction-regression" $(if ($testExit -eq 0) { "GREEN" } else { "RED" }) `
      "Three same-process Windows/runtime regression suites exit code $testExit. This is not a cross-identity transaction test." @{
        command = "$vitest run tests/b24-t3-pending-write.test.ts tests/b24-t3-admission.test.ts tests/b24-t3-session.test.ts"
        exitCode = $testExit
        output = "pending-write-vitest.txt"
      }
  } else {
    Add-Test "pending-transaction-regression" "UNVERIFIED" "The expected repository regression test was absent."
  }

  $protectedDataAfter = Get-InventorySnapshot $dataRoot
  $protectedDataDelta = Get-InventoryDelta $protectedDataBefore $protectedDataAfter
  $actorInventoryAfter = Get-InventorySnapshot $actorEvidenceRoot
  $expectedActorInventory = @($expectedActorEvidence | ForEach-Object {
    [pscustomobject]@{
      path = Normalize-InventoryPath $actorEvidenceRoot $_.path
      kind = $_.kind
    }
  } | Where-Object { $_.path -ne $null })
  $actorInventoryCheck = Compare-ActorEvidenceInventory $actorInventoryAfter $expectedActorInventory $actorEvidenceBaseline
  Add-Test "actor-evidence-isolation" $(if ($actorInventoryCheck.accepted) { "GREEN" } else { "RED" }) "The inventory must contain every expected actor directory and result file, preserve captured file identities, and contain no unexpected files or directories." @{
    beforeCount = @($actorInventoryBefore).Count
    afterCount = @($actorInventoryAfter).Count
    expectedPathCount = @($expectedActorInventory).Count
    unexpectedActorEntries = @($actorInventoryCheck.unexpected)
    missingOrWrongKindEntries = @($actorInventoryCheck.missing)
    modifiedProtectedEvidence = @($actorInventoryCheck.modified)
    protectedDataBefore = $protectedDataBefore
    protectedDataAfter = $protectedDataAfter
    protectedDataDelta = @($protectedDataDelta)
  }
  if (@($protectedDataDelta).Count -gt 0) {
    Add-Test "protected-data-integrity" "RED" "Protected data changed unexpectedly after denied mutation attempts." @{
      before = $protectedDataBefore
      after = $protectedDataAfter
      delta = @($protectedDataDelta)
    }
  }
  $red = @($steps | Where-Object { $_.status -eq "RED" }).Count
  $unknown = @($steps | Where-Object { $_.status -eq "UNVERIFIED" }).Count
  $final = if ($red -gt 0) { "RED" } elseif ($unknown -gt 0) { "UNVERIFIED" } else { "GREEN" }
  $exitCode = switch ($final) { "GREEN" { 0 }; "RED" { 1 }; "UNVERIFIED" { 2 }; default { 2 } }
  Save-Report $final "RED=$red; UNVERIFIED=$unknown. A RED outcome identifies a challenge that passed its adversarial objective, not a harness crash."
  exit $exitCode
} catch {
  Add-Test "harness-execution" "ERROR" $_.Exception.ToString()
  Save-Report "UNVERIFIED" "Harness execution did not complete; see transcript and the error entry."
  exit 2
} finally {
  Stop-Transcript | Out-Null
}
