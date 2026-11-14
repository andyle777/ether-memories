Set-StrictMode -Version Latest
. "$PSScriptRoot/PhaseA.Stage2.ps1"
. "$PSScriptRoot/PhaseA.Inventory.ps1"
function Invoke-PhaseAStage3($Accounts,$Tokens,[hashtable]$FixtureBackend,[hashtable]$ActorBackend) {
  $cases=@{acl=$false;authorizedRead=$false;authorizedCreate=$false;authorizedReadback=$false;
    unauthorizedRead=$false;unauthorizedWrite=$false;unauthorizedCreate=$false;inventory=$false;insecureRejected=$false;fixtureCleanup=$false}
  $fixture=$null; $status='STAGE3_SETUP_FAILED'; $unconfirmed=$false
  try {
    $fixture=& $FixtureBackend.Setup $Accounts
    if ($null -eq $fixture -or ($fixture.aclInspected -isnot [bool] -or -not $fixture.aclInspected)) { throw 'STAGE3_ACL_REJECTED' }
    $cases.acl=$true; $status='STAGE3_CASE_FAILED'
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile) -or -not (& $FixtureBackend.Exists $fixture.controlFile) -or
        (& $FixtureBackend.Exists $fixture.newFile)) { throw 'fixture paths invalid' }
    if ((& $FixtureBackend.Digest $fixture.protectedFile) -cne $fixture.initialDigest) { throw 'initial digest mismatch' }
    $read=Invoke-PhaseAActorOperation $Accounts[0] $Tokens[0] $ActorBackend 'Read' $fixture.protectedFile 'allowed'
    if ($read.digest -cne $fixture.initialDigest) { throw 'authorized read mismatch' }; $cases.authorizedRead=$true
    $null=Invoke-PhaseAActorOperation $Accounts[0] $Tokens[0] $ActorBackend 'Create' $fixture.newFile 'allowed'
    if (-not (& $FixtureBackend.Exists $fixture.newFile) -or (& $FixtureBackend.Digest $fixture.newFile) -cne $fixture.writeDigest) { throw 'authorized create mismatch' }
    $cases.authorizedCreate=$true
    $readback=Invoke-PhaseAActorOperation $Accounts[0] $Tokens[0] $ActorBackend 'Read' $fixture.newFile 'allowed'
    if ($readback.digest -cne $fixture.writeDigest) { throw 'authorized readback mismatch' }; $cases.authorizedReadback=$true
    $before=& $FixtureBackend.Inventory $fixture
    if ([string]::IsNullOrWhiteSpace([string]$before)) { throw 'inventory missing' }
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile)) { throw 'protected file missing' }
    $null=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Read' $fixture.protectedFile 'denied'; $cases.unauthorizedRead=$true
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile)) { throw 'protected file missing' }
    $null=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Overwrite' $fixture.protectedFile 'denied'; $cases.unauthorizedWrite=$true
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after write' }
    $deniedPath=$fixture.deniedFile
    if ([string]::IsNullOrWhiteSpace([string]$deniedPath) -or (& $FixtureBackend.Exists $deniedPath)) { throw 'create control invalid' }
    $null=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Create' $deniedPath 'denied'; $cases.unauthorizedCreate=$true
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after create' }; $cases.inventory=$true
    $insecure=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Read' $fixture.controlFile 'allowed'
    if (Test-ActorObservation $insecure $Accounts[1].role 'denied') { throw 'insecure control accepted' }; $cases.insecureRejected=$true
    $status='STAGE3_COMPLETE'
  } catch {
    $base=$_.Exception.GetBaseException().Message
    if ($base -ceq 'STAGE2_CHILD_UNCONFIRMED') { $unconfirmed=$true }
    elseif ($base -ceq 'STAGE3_ACL_REJECTED') { $status='STAGE3_ACL_REJECTED' }
    elseif ($base -ceq 'STAGE3_CLEANUP_FAILED') { $status='STAGE3_CLEANUP_FAILED' }
  } finally {
    if ($null -ne $fixture -and -not $unconfirmed) {
      try { $null=& $FixtureBackend.Cleanup $fixture; $cases.fixtureCleanup=$true } catch { $status='STAGE3_CLEANUP_FAILED' }
    }
  }
  if ($unconfirmed) { throw 'STAGE2_CHILD_UNCONFIRMED' }
  if ($status -ceq 'STAGE3_COMPLETE' -and @($cases.Values | Where-Object { $_ -isnot [bool] -or -not $_ }).Count -ne 0) { $status='STAGE3_CASE_FAILED' }
  return @{status=$status;cases=$cases}
}
function Set-PhaseAFixtureAcl([string]$Path,[string[]]$FullSids,[string[]]$ReadSids) {
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($item in @(@{sids=$FullSids;rights='FullControl'},@{sids=$ReadSids;rights='ReadAndExecute'})) {
    foreach ($sidText in $item.sids) {
      $sid=New-Object Security.Principal.SecurityIdentifier($sidText)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,$item.rights,'ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
  $actual=Get-Acl -LiteralPath $Path -ErrorAction Stop
  $section=[Security.AccessControl.AccessControlSections]::Access
  if (-not $actual.AreAccessRulesProtected -or
      $actual.GetSecurityDescriptorSddlForm($section) -cne $acl.GetSecurityDescriptorSddlForm($section)) { throw 'STAGE3_ACL_REJECTED' }
}
function Remove-PhaseAFixture($Fixture) {
  $root=[IO.Path]::GetFullPath($Fixture.root); $parent=[IO.Path]::GetFullPath($Fixture.parent).TrimEnd('\')
  if (-not $root.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($root).StartsWith('ether-phase-a-store-')) { throw 'fixture cleanup path rejected' }
  if (-not [IO.Directory]::Exists($root)) { return }
  foreach ($dir in @($root,$Fixture.protectedDir,$Fixture.controlDir)) {
    if ([IO.Directory]::Exists($dir) -and ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fixture reparse point rejected' }
  }
  foreach ($file in @($Fixture.protectedFile,$Fixture.newFile,$Fixture.deniedFile,$Fixture.controlFile)) {
    if (Test-Path -LiteralPath $file) {
      $entry=Get-Item -LiteralPath $file -Force -ErrorAction Stop
      if (($entry.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw 'unexpected fixture entry' }
      [IO.File]::Delete($file)
    }
  }
  foreach ($dir in @($Fixture.protectedDir,$Fixture.controlDir,$root)) { if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir,$false) } }
}
function New-PhaseAStage3Backend {
  return @{
    Setup={ param($accounts)
      $common=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
      if ([string]::IsNullOrWhiteSpace($common)) { throw 'STAGE3_SETUP_FAILED' }
      $parent=[IO.Path]::GetFullPath($common).TrimEnd('\')
      $root=Join-Path $parent ('ether-phase-a-store-'+[Guid]::NewGuid().ToString('N'))
      $protectedDir=Join-Path $root 'protected'; $controlDir=Join-Path $root 'control'
      $f=@{parent=$parent;root=$root;protectedDir=$protectedDir;controlDir=$controlDir;
        protectedFile=(Join-Path $protectedDir 'original.bin');newFile=(Join-Path $protectedDir 'committed.bin');
        deniedFile=(Join-Path $protectedDir 'rejected.bin');controlFile=(Join-Path $controlDir 'original.bin');aclInspected=$false}
      $created=$false
      try {
        $manager=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ($accounts[0].sid -ceq $accounts[1].sid -or $accounts[0].sid -ceq $manager -or $accounts[1].sid -ceq $manager -or
            $accounts[0].sid -ceq 'S-1-5-18' -or $accounts[1].sid -ceq 'S-1-5-18') { throw 'identity overlap' }
        $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
        if ($drive.DriveFormat -cne 'NTFS') { throw 'NTFS required' }
        $null=New-Item -ItemType Directory -Path $root -ErrorAction Stop; $created=$true
        if (((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fixture reparse point rejected' }
        try { Set-PhaseAFixtureAcl $root @($manager,'S-1-5-18') @($accounts[0].sid,$accounts[1].sid) } catch { throw 'STAGE3_ACL_REJECTED' }
        $null=New-Item -ItemType Directory -Path $protectedDir -ErrorAction Stop
        $null=New-Item -ItemType Directory -Path $controlDir -ErrorAction Stop
        try {
          Set-PhaseAFixtureAcl $protectedDir @($manager,'S-1-5-18',$accounts[0].sid) @()
          Set-PhaseAFixtureAcl $controlDir @($manager,'S-1-5-18',$accounts[0].sid,$accounts[1].sid) @()
        } catch { throw 'STAGE3_ACL_REJECTED' }
        [IO.File]::WriteAllText($f.protectedFile,'ether-phase-a-synthetic',[Text.Encoding]::ASCII)
        [IO.File]::WriteAllText($f.controlFile,'ether-phase-a-control',[Text.Encoding]::ASCII)
        $sha=[Security.Cryptography.SHA256]::Create()
        try {
          $f.initialDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes('ether-phase-a-synthetic'))).Replace('-','').ToLowerInvariant()
          $f.writeDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes('A'))).Replace('-','').ToLowerInvariant()
        } finally { $sha.Dispose() }
        $f.aclInspected=$true; return $f
      } catch {
        if ($created) { try { Remove-PhaseAFixture $f } catch { throw 'STAGE3_CLEANUP_FAILED' } }
        throw
      }
    }
    Exists={ param($path) [IO.File]::Exists($path) }
    Digest={ param($path) (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    Inventory={ param($f) Get-PhaseAInventory $f.protectedDir }
    Cleanup={ param($f) Remove-PhaseAFixture $f }
  }
}
