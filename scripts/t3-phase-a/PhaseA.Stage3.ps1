Set-StrictMode -Version Latest
. "$PSScriptRoot/PhaseA.Stage2.ps1"
. "$PSScriptRoot/PhaseA.Inventory.ps1"
. "$PSScriptRoot/PhaseA.AccessWitness.ps1"
. "$PSScriptRoot/PhaseA.ReadProcess.ps1"
function Invoke-PhaseATrustedAccess([hashtable]$Backend,[hashtable]$Fixture,$Token,[string]$ExpectedSid,[string]$Operation,[string]$TargetId,[string]$EvidenceClass) {
  $failure=@{status='UNVERIFIED';reason='WITNESS_UNAVAILABLE';evidence=$EvidenceClass}
  try {
    if ($EvidenceClass -cnotin @('LIVE','INJECTED') -or $Token.sid -cne $ExpectedSid -or [string]::IsNullOrWhiteSpace($ExpectedSid) -or $Operation -cnotin @('Read','Overwrite','Create') -or $TargetId -cnotin @('protectedFile','deniedFile','controlFile','authorizedProbeFile','controlProbeFile')) { return $failure }
    if (($Operation -ceq 'Create' -and $TargetId -cnotin @('deniedFile','authorizedProbeFile','controlProbeFile')) -or ($Operation -ceq 'Overwrite' -and $TargetId -cnotin @('protectedFile','controlFile')) -or ($Operation -ceq 'Read' -and $TargetId -cnotin @('protectedFile','controlFile'))) { return $failure }
    $path=$Fixture[$TargetId]; if ([string]::IsNullOrWhiteSpace([string]$path)) { return $failure }
    if ($Operation -ceq 'Create') { $parent=if ($TargetId -ceq 'controlProbeFile') { $Fixture.controlDir } else { $Fixture.protectedDir }; if (-not (& $Backend.DirectoryExists $parent) -or (& $Backend.Exists $path)) { return $failure } }
    elseif (-not (& $Backend.Exists $path)) { return $failure }
    $root=if ($Fixture.ContainsKey('root')) { $Fixture.root } else { '' }
    $raw=& $Backend.Probe $Token $ExpectedSid $Operation $path $root
    if ($raw -isnot [hashtable] -or $raw.sid -cne $ExpectedSid -or $raw.operation -cne $Operation -or $raw.attempted -isnot [bool] -or -not $raw.attempted -or $raw.allowed -isnot [bool] -or $raw.error -isnot [int] -or $raw.handlesClosed -isnot [bool] -or -not $raw.handlesClosed) { return $failure }
    $processEvidence=($raw.ContainsKey('execution') -and $raw.execution -ceq 'PROCESS')
    if($processEvidence) {if($Operation -cne 'Read' -or $raw.processVerified -isnot [bool] -or -not $raw.processVerified -or $raw.terminated -isnot [bool] -or -not $raw.terminated){return $failure}}
    elseif($raw.impersonated -isnot [bool] -or -not $raw.impersonated -or $raw.reverted -isnot [bool] -or -not $raw.reverted){return $failure}
    if($EvidenceClass -ceq 'LIVE' -and $Operation -ceq 'Read' -and -not $processEvidence){return $failure}
    $outcome=if ($raw.allowed -and $raw.error -eq 0) {'ALLOWED'} elseif (-not $raw.allowed -and $raw.error -eq 5) {'ACCESS_DENIED'} elseif (-not $raw.allowed -and $raw.error -in @(2,3,6,32,87,123)) { return @{status='UNVERIFIED';reason='NATIVE_ERROR';evidence=$EvidenceClass;operation=$Operation;target=$TargetId;nativeError=$raw.error} } else { return $failure }
    $result=@{status='OBSERVED';reason='NONE';evidence=$EvidenceClass;sid=$raw.sid;operation=$Operation;target=$TargetId;outcome=$outcome;nativeError=$raw.error;handlesClosed=$raw.handlesClosed}; if($processEvidence){$result.execution='PROCESS';$result.processVerified=$raw.processVerified;$result.terminated=$raw.terminated;$result.pid=$raw.pid;$result.createdAt=$raw.createdAt;$result.pipeClientPid=$raw.pipeClientPid;$result.nonce=$raw.nonce}else{$result.reverted=$raw.reverted};return $result
  } catch { $code=$_.Exception.GetBaseException().Message; if ($code -ceq 'STAGE2_CHILD_UNCONFIRMED') { throw 'STAGE2_CHILD_UNCONFIRMED' }; if($code -cin @('WITNESS_TIMEOUT','WITNESS_CLEANUP_FAILED')) {return @{status='UNVERIFIED';reason=$code;evidence=$EvidenceClass}}; return $failure }
}
function Invoke-PhaseATrackedDeniedOperation($Account,$Token,[hashtable]$ActorBackend,[hashtable]$FixtureBackend,$Fixture,[hashtable]$Journal,[string]$Control,[string]$Operation,[string]$Target,[string]$TargetId) {
  $entry=@{control=$Control;operation=$Operation;target=$TargetId;accountSid=$Account.sid;tokenSid=$Token.sid;beforeExists=$null;parentExists=$null;beforeInventory=$null;beforeDigest=$null;afterExists=$null;afterInventory=$null;observation=$null;witness=$null}
  $Journal[$Control]=$entry
  $entry.beforeExists=& $FixtureBackend.Exists $Target
  if ($FixtureBackend.ContainsKey('DirectoryExists') -and $Fixture.ContainsKey('protectedDir')) { $entry.parentExists=& $FixtureBackend.DirectoryExists $Fixture.protectedDir }
  $entry.beforeInventory=& $FixtureBackend.Inventory $Fixture
  if ($Operation -ceq 'Read' -and $entry.beforeExists -ceq $true) { $entry.beforeDigest=& $FixtureBackend.Digest $Target }
  $original=$ActorBackend.Run
  $capture={param($a,$t,$op,$path) $value=& $original $a $t $op $path; if($value -is [hashtable]){$entry.observation=$value}; return $value}.GetNewClosure()
  try {
    $value=Invoke-PhaseAActorOperation $Account $Token @{Run=$capture} $Operation $Target 'denied'
    if ($FixtureBackend.ContainsKey('Probe')) {
      $class=if ($FixtureBackend.ContainsKey('WitnessEvidence') -and $FixtureBackend.WitnessEvidence -ceq 'LIVE') {'LIVE'} else {'INJECTED'}
      $entry.witness=Invoke-PhaseATrustedAccess $FixtureBackend $Fixture $Token $Account.sid $Operation $TargetId $class
      if ($entry.witness.status -cne 'OBSERVED' -or $entry.witness.outcome -cne 'ACCESS_DENIED') { throw 'STAGE3_WITNESS_UNVERIFIED' }
    }
    return $value
  }
  finally {
    try { $entry.afterExists=& $FixtureBackend.Exists $Target; $entry.afterInventory=& $FixtureBackend.Inventory $Fixture } catch { }
  }
}
function Invoke-PhaseAStage3($Accounts,$Tokens,[hashtable]$FixtureBackend,[hashtable]$ActorBackend) {
  $cases=@{acl=$false;authorizedRead=$false;authorizedCreate=$false;authorizedReadback=$false;
    unauthorizedRead=$false;unauthorizedWrite=$false;unauthorizedCreate=$false;proposedDelete=$false;proposedRename=$false;inventory=$false;insecureRejected=$false;fixtureCleanup=$false}
  $evidence=@{cleanupVerified=$false}; $fixture=$null; $status='STAGE3_SETUP_FAILED'; $unconfirmed=$false
  try {
    $fixture=& $FixtureBackend.Setup $Accounts
    if ($null -eq $fixture -or ($fixture.aclInspected -isnot [bool] -or -not $fixture.aclInspected)) { throw 'STAGE3_ACL_REJECTED' }
    if ($fixture -is [hashtable] -and $fixture.ContainsKey('aclEvidence')) { $evidence['aclInspection']=$fixture.aclEvidence }
    $cases.acl=$true; $status='STAGE3_CASE_FAILED'
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile) -or -not (& $FixtureBackend.Exists $fixture.controlFile) -or
        (& $FixtureBackend.Exists $fixture.newFile)) { throw 'fixture paths invalid' }
    if ((& $FixtureBackend.Digest $fixture.protectedFile) -cne $fixture.initialDigest) { throw 'initial digest mismatch' }
    if ($FixtureBackend.ContainsKey('Probe')) {
      $class=if ($FixtureBackend.ContainsKey('WitnessEvidence') -and $FixtureBackend.WitnessEvidence -ceq 'LIVE') {'LIVE'} else {'INJECTED'}
      $controls=@{}; $evidence['witnessControls']=$controls
      foreach ($spec in @(@('authorizedRead',0,'Read','protectedFile'),@('permissiveRead',1,'Read','controlFile'),@('authorizedWrite',0,'Overwrite','protectedFile'),@('permissiveWrite',1,'Overwrite','controlFile'),@('authorizedCreate',0,'Create','authorizedProbeFile'),@('permissiveCreate',1,'Create','controlProbeFile'))) {
        $name=$spec[0];$index=[int]$spec[1];$op=$spec[2];$targetId=$spec[3]
        $control=Invoke-PhaseATrustedAccess $FixtureBackend $fixture $Tokens[$index] $Accounts[$index].sid $op $targetId $class
        $controls[$name]=$control
        if ($control.status -cne 'OBSERVED' -or $control.outcome -cne 'ALLOWED') { throw 'STAGE3_WITNESS_UNVERIFIED' }
        if ($op -ceq 'Create') {
          if (-not $FixtureBackend.ContainsKey('RemoveProbe')) { throw 'STAGE3_WITNESS_UNVERIFIED' }
          $null=& $FixtureBackend.RemoveProbe $fixture $targetId
          if (& $FixtureBackend.Exists $fixture[$targetId]) { throw 'STAGE3_WITNESS_UNVERIFIED' }
          $control['removed']=$true
        }
      }
    }
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
    $null=Invoke-PhaseATrackedDeniedOperation $Accounts[1] $Tokens[1] $ActorBackend $FixtureBackend $fixture $evidence 'unauthorizedRead' 'Read' $fixture.protectedFile 'protectedFile'; $cases.unauthorizedRead=$true
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile)) { throw 'protected file missing' }
    $null=Invoke-PhaseATrackedDeniedOperation $Accounts[1] $Tokens[1] $ActorBackend $FixtureBackend $fixture $evidence 'unauthorizedWrite' 'Overwrite' $fixture.protectedFile 'protectedFile'; $cases.unauthorizedWrite=$true
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after write' }
    $deniedPath=$fixture.deniedFile
    if ([string]::IsNullOrWhiteSpace([string]$deniedPath) -or (& $FixtureBackend.Exists $deniedPath)) { throw 'create control invalid' }
    $null=Invoke-PhaseATrackedDeniedOperation $Accounts[1] $Tokens[1] $ActorBackend $FixtureBackend $fixture $evidence 'unauthorizedCreate' 'Create' $deniedPath 'deniedFile'; $cases.unauthorizedCreate=$true
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after create' }; $cases.inventory=$true
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile) -or (& $FixtureBackend.Exists ($fixture.protectedFile+'.renamed'))) { throw 'rename fixture invalid' }
    $null=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Rename' $fixture.protectedFile 'denied'
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after rename' }; $cases.proposedRename=$true
    if (-not (& $FixtureBackend.Exists $fixture.protectedFile)) { throw 'delete fixture invalid' }
    $null=Invoke-PhaseAActorOperation $Accounts[1] $Tokens[1] $ActorBackend 'Delete' $fixture.protectedFile 'denied'
    if ((& $FixtureBackend.Inventory $fixture) -cne $before) { throw 'inventory changed after delete' }; $cases.proposedDelete=$true
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
      try { $null=& $FixtureBackend.Cleanup $fixture; $cases.fixtureCleanup=$true; if ($FixtureBackend.ContainsKey('CleanupVerified')) { $evidence.cleanupVerified=(& $FixtureBackend.CleanupVerified $fixture) -ceq $true } } catch { $status='STAGE3_CLEANUP_FAILED' }
    }
  }
  if ($unconfirmed) { throw 'STAGE2_CHILD_UNCONFIRMED' }
  if ($status -ceq 'STAGE3_COMPLETE' -and @($cases.Values | Where-Object { $_ -isnot [bool] -or -not $_ }).Count -ne 0) { $status='STAGE3_CASE_FAILED' }
  return @{status=$status;cases=$cases;evidence=$evidence}
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
  $actualSddl=$actual.GetSecurityDescriptorSddlForm($section); $expectedSddl=$acl.GetSecurityDescriptorSddlForm($section)
  if (-not $actual.AreAccessRulesProtected -or $actualSddl -cne $expectedSddl) { throw 'STAGE3_ACL_REJECTED' }
  return @{expected=$expectedSddl;actual=$actualSddl;protected=[bool]$actual.AreAccessRulesProtected}
}
function Remove-PhaseAFixture($Fixture) {
  $root=[IO.Path]::GetFullPath($Fixture.root); $parent=[IO.Path]::GetFullPath($Fixture.parent).TrimEnd('\')
  if (-not $root.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($root).StartsWith('ether-phase-a-store-')) { throw 'fixture cleanup path rejected' }
  if (-not [IO.Directory]::Exists($root)) { return }
  foreach ($dir in @($root,$Fixture.protectedDir,$Fixture.controlDir)) {
    if ([IO.Directory]::Exists($dir) -and ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fixture reparse point rejected' }
  }
  foreach ($file in @($Fixture.protectedFile,$Fixture.newFile,$Fixture.deniedFile,($Fixture.protectedFile+'.renamed'),$Fixture.controlFile,$Fixture.authorizedProbeFile,$Fixture.controlProbeFile)) {
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
        deniedFile=(Join-Path $protectedDir 'rejected.bin');controlFile=(Join-Path $controlDir 'original.bin');authorizedProbeFile=(Join-Path $protectedDir 'witness-authorized.bin');controlProbeFile=(Join-Path $controlDir 'witness-permissive.bin');aclInspected=$false}
      $created=$false
      try {
        $manager=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if ($accounts[0].sid -ceq $accounts[1].sid -or $accounts[0].sid -ceq $manager -or $accounts[1].sid -ceq $manager -or
            $accounts[0].sid -ceq 'S-1-5-18' -or $accounts[1].sid -ceq 'S-1-5-18') { throw 'identity overlap' }
        $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
        if ($drive.DriveFormat -cne 'NTFS') { throw 'NTFS required' }
        $null=New-Item -ItemType Directory -Path $root -ErrorAction Stop; $created=$true
        if (((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fixture reparse point rejected' }
        try { $null=Set-PhaseAFixtureAcl $root @($manager,'S-1-5-18') @($accounts[0].sid,$accounts[1].sid) } catch { throw 'STAGE3_ACL_REJECTED' }
        $null=New-Item -ItemType Directory -Path $protectedDir -ErrorAction Stop
        $null=New-Item -ItemType Directory -Path $controlDir -ErrorAction Stop
        try {
          $protectedAcl=Set-PhaseAFixtureAcl $protectedDir @($manager,'S-1-5-18',$accounts[0].sid) @()
          $null=Set-PhaseAFixtureAcl $controlDir @($manager,'S-1-5-18',$accounts[0].sid,$accounts[1].sid) @()
        } catch { throw 'STAGE3_ACL_REJECTED' }
        [IO.File]::WriteAllText($f.protectedFile,'ether-phase-a-synthetic',[Text.Encoding]::ASCII)
        [IO.File]::WriteAllText($f.controlFile,'ether-phase-a-control',[Text.Encoding]::ASCII)
        $sha=[Security.Cryptography.SHA256]::Create()
        try {
          $f.initialDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes('ether-phase-a-synthetic'))).Replace('-','').ToLowerInvariant()
          $f.writeDigest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes('A'))).Replace('-','').ToLowerInvariant()
        } finally { $sha.Dispose() }
        $f.aclEvidence=$protectedAcl; $f.aclInspected=$true; return $f
      } catch {
        if ($created) { try { Remove-PhaseAFixture $f } catch { throw 'STAGE3_CLEANUP_FAILED' } }
        throw
      }
    }
    Exists={ param($path) [IO.File]::Exists($path) }
    DirectoryExists={ param($path) [IO.Directory]::Exists($path) }
    RemoveProbe={ param($f,$id)
      if ($id -cnotin @('authorizedProbeFile','controlProbeFile')) { throw 'probe id rejected' }
      $path=$f[$id]; if (Test-Path -LiteralPath $path) {
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (($item.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw 'probe entry rejected' }
        [IO.File]::Delete($path)
      }
    }
    WitnessEvidence='LIVE'
    Probe={ param($token,$sid,$operation,$path,$root)
      if($operation -ceq 'Read') { $targetId=if([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($path)) -ceq 'protected'){'protectedFile'}else{'controlFile'};return Invoke-PhaseAReadPipeProcess $token $sid $path $targetId $root }
      $r=[EtherPhaseAAccessWitness]::Probe($token.handle.DangerousGetHandle(),$sid,$operation,$path,$root)
      return @{impersonated=$r.impersonated;sid=$r.sid;operation=$r.operation;attempted=$r.attempted;allowed=$r.allowed;error=$r.error;reverted=$r.reverted;handlesClosed=$r.handlesClosed}
    }
    CleanupVerified={ param($f) -not (Test-Path -LiteralPath $f.root -ErrorAction Stop) }
    Digest={ param($path) (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    Inventory={ param($f) Get-PhaseAInventory $f.protectedDir }
    Cleanup={ param($f) Remove-PhaseAFixture $f }
  }
}
