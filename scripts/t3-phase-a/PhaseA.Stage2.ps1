Set-StrictMode -Version Latest
. "$PSScriptRoot/PhaseA.Core.ps1"
. "$PSScriptRoot/PhaseA.Native.ps1"
. "$PSScriptRoot/PhaseA.Atomic.ps1"
function Invoke-PhaseAStage2($Accounts, $Tokens, [hashtable]$Backend) {
  if ($Accounts.Count -ne 2 -or $Tokens.Count -ne 2) { return 'STAGE2_OBSERVATION_REJECTED' }
  foreach ($i in 0,1) {
    $account=$Accounts[$i]; $token=$Tokens[$i]
    try {
      if ($token.sid -cne $account.sid) { return 'STAGE2_OBSERVATION_REJECTED' }
      $obs=& $Backend.Run $account $token
      if ($obs -isnot [hashtable] -or -not $obs.ContainsKey('terminated') -or
          $obs.terminated -isnot [bool] -or -not $obs.terminated) { throw 'STAGE2_CHILD_UNCONFIRMED' }
      if ($obs.expectedSid -cne $account.sid -or
          $obs.contained -isnot [bool] -or -not $obs.contained -or
          -not (Test-ActorObservation $obs $account.role 'allowed')) { return 'STAGE2_OBSERVATION_REJECTED' }
    } catch {
      $reason=$_.Exception.GetBaseException().Message
      if ($reason -ceq 'STAGE2_CHILD_UNCONFIRMED') { throw 'STAGE2_CHILD_UNCONFIRMED' }
      if ($reason -in @('STAGE2_TIMEOUT','STAGE2_CLEANUP_FAILED','STAGE2_OBSERVATION_REJECTED')) { return $reason }
      return 'STAGE2_LAUNCH_FAILED'
    }
  }
  return 'STAGE2_COMPLETE'
}
function Invoke-PhaseAStages([bool]$AccountEnabled, [bool]$ActorEnabled, [hashtable]$AccountBackend, [hashtable]$ActorBackend) {
  if ($ActorEnabled -and -not $AccountEnabled) { return 'STAGE2_GUARD_REJECTED' }
  if (-not $AccountEnabled) { return 'LIVE_DISABLED' }
  $state=@{reason='IMPLEMENTATION_INCOMPLETE';enabled=$ActorEnabled;backend=$ActorBackend}
  $callback={
    param($accounts,$tokens)
    if ($state.enabled) {
      $state.reason=Invoke-PhaseAStage2 $accounts $tokens $state.backend
      if ($state.reason -cne 'STAGE2_COMPLETE') { throw 'stage 2 failed' }
    }
  }.GetNewClosure()
  $stage=Invoke-PhaseAAccountGate $true $AccountBackend $callback
  if ($stage -ceq 'STAGE1_COMPLETE') { if ($ActorEnabled) { return 'STAGE2_COMPLETE' }; return 'STAGE1_COMPLETE' }
  if ($stage -ceq 'ACCOUNT_CONSUMER_FAILED') { return $state.reason }
  return $stage
}
function New-PhaseAStage2Backend {
  return @{ Run={ param($account,$token)
    $common=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($common)) { throw 'stage directory unavailable' }
    $parent=[IO.Path]::GetFullPath($common).TrimEnd('\')
    $root=Join-Path $parent ('ether-phase-a-actor-'+[Guid]::NewGuid().ToString('N'))
    $actor=Join-Path $root 'Actor.ps1'; $ready=Join-Path $root 'ready.json'; $gate=Join-Path $root 'gate'
    $result=Join-Path $root 'result.json'; $target=Join-Path $root 'probe.bin'
    $job=[IntPtr]::Zero; $child=$null; $process=$null; $safeToRemove=$true; $cleanupFailed=$false; $createdRoot=$false
    try {
      $null=New-Item -ItemType Directory -Path $root -ErrorAction Stop; $createdRoot=$true
      $item=Get-Item -LiteralPath $root -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point rejected' }
      $acl=New-Object Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true,$false)
      foreach ($sidText in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18',$account.sid)) {
        $sid=New-Object Security.Principal.SecurityIdentifier($sidText)
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $root -AclObject $acl -ErrorAction Stop
      Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Actor.ps1') -Destination $actor -ErrorAction Stop
      $nonce=[Guid]::NewGuid().ToString('N'); $exe=Join-Path $PSHOME 'powershell.exe'
      foreach ($path in @($actor,$ready,$gate,$result,$target,$exe,$root)) { if ($path.Contains('"')) { throw 'unsafe path' } }
      $cmd='"'+$exe+'" -NoProfile -NonInteractive -File "'+$actor+'" -Operation Create -Target "'+$target+'" -Ready "'+$ready+'" -Gate "'+$gate+'" -Result "'+$result+'" -Nonce '+$nonce
      $job=[EtherPhaseAJob]::Create()
      $child=[EtherPhaseAAtomic]::CreateWithTokenInDirectory($token.handle.DangerousGetHandle(),$job,$exe,$cmd,$root)
      $safeToRemove=$false
      if (-not $child.InJob() -or $child.Exited()) { throw 'child not contained or already exited' }
      $process=Get-Process -Id $child.Pid -ErrorAction Stop
      $observed=Get-PhaseAProcessToken $process
      if ($observed.pid -ne $child.Pid -or $observed.sid -cne $account.sid -or $observed.admin -or $observed.elevated -or -not $observed.standard) { throw 'STAGE2_OBSERVATION_REJECTED' }
      $child.Resume()
      $deadline=[DateTime]::UtcNow.AddSeconds(20)
      while (-not [IO.File]::Exists($ready)) {
        if ($child.Exited()) { throw 'actor exited before readiness' }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'STAGE2_TIMEOUT' }
        Start-Sleep -Milliseconds 50
      }
      if ($child.Exited() -or -not $child.InJob() -or (Get-Item -LiteralPath $ready).Length -gt 4096) { throw 'invalid actor readiness' }
      $record=Get-Content -LiteralPath $ready -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $t1=[DateTimeOffset]::MinValue; $t2=[DateTimeOffset]::MinValue
      if ($record.pid -ne $child.Pid -or $record.sid -cne $observed.sid -or $record.nonce -cne $nonce -or
          -not [DateTimeOffset]::TryParse([string]$record.createdAt,[ref]$t1) -or
          -not [DateTimeOffset]::TryParse([string]$observed.createdAt,[ref]$t2) -or $t1 -ne $t2) { throw 'STAGE2_OBSERVATION_REJECTED' }
      [IO.File]::WriteAllText($gate,'go')
      if (-not $child.Wait(20000)) { throw 'STAGE2_TIMEOUT' }
      $safeToRemove=$true; $code=$child.ExitCode()
      if (-not [IO.File]::Exists($result) -or (Get-Item -LiteralPath $result).Length -gt 4096) { throw 'actor result missing' }
      $final=Get-Content -LiteralPath $result -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      return @{ role=$account.role; expectedSid=$account.sid; observedSid=$observed.sid; reportedSid=$final.sid;
        expectedPid=$child.Pid; reportedPid=$final.pid; tokenNonAdmin=$true; tokenObserved=$true;
        createdAt=$final.createdAt; observedCreatedAt=$observed.createdAt; expectedNonce=$nonce;
        reportedNonce=$final.nonce; exitCode=$code; outcome=$final.outcome; contained=$true; terminated=$true }
    } finally {
      if ($job -ne [IntPtr]::Zero) { try { [EtherPhaseAJob]::Close($job) } catch { $cleanupFailed=$true } }
      if ($child) {
        try {
          if (-not $child.Wait(5000)) { $child.Terminate(); if (-not $child.Wait(5000)) { throw 'termination not confirmed' } }
          $safeToRemove=$true
        } catch { $safeToRemove=$false }
        if ($safeToRemove) { try { $child.Dispose() } catch { $cleanupFailed=$true } }
      }
      if ($process) { try { $process.Dispose() } catch { $cleanupFailed=$true } }
      if (-not $safeToRemove) { throw 'STAGE2_CHILD_UNCONFIRMED' }
      if ($createdRoot -and [IO.Directory]::Exists($root)) {
        $resolved=[IO.Path]::GetFullPath($root)
        if (-not $resolved.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($resolved).StartsWith('ether-phase-a-actor-')) { throw 'STAGE2_CLEANUP_FAILED' }
        try {
          $rootItem=Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
          if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point rejected' }
          foreach ($path in @($target,$result,$gate,$ready,$actor)) {
            if (Test-Path -LiteralPath $path) {
              $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop
              if (($entry.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { throw 'unexpected entry' }
              [IO.File]::Delete($path)
            }
          }
          [IO.Directory]::Delete($resolved,$false)
        } catch { $cleanupFailed=$true }
      }
      if ($cleanupFailed) { throw 'STAGE2_CLEANUP_FAILED' }
    }
  } }
}
