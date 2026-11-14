Set-StrictMode -Version Latest
function Get-PhaseAInnerJobInspection([Diagnostics.Process]$Supervisor,[Diagnostics.Process]$Child,[long]$Handle,[int]$ExpectedPid,[string]$ExpectedTime) {
  $r=@{status='FAILED';reason='INSPECTION_FAILED';pid=$null;sid=$null;createdAt=$null;limitFlags=$null;member=$null;supervisorMember=$null;released=$false}
  $inspection=[IntPtr]::Zero
  try {
    if ($null -eq $Supervisor -or $null -eq $Child -or $Supervisor.HasExited -or $Child.HasExited) { $r.reason='EARLY_EXIT'; return $r }
    if ($Child.Id -ne $ExpectedPid) { $r.reason='PID_MISMATCH'; return $r }
    $observed=Get-PhaseAProcessToken $Child
    $r.pid=$observed.pid; $r.sid=$observed.sid; $r.createdAt=$observed.createdAt
    $a=[DateTimeOffset]::MinValue; $b=[DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($ExpectedTime,[ref]$a) -or -not [DateTimeOffset]::TryParse([string]$observed.createdAt,[ref]$b) -or $a -ne $b) { $r.reason='TIME_MISMATCH'; return $r }
    $inspection=[EtherPhaseAJob]::DuplicateQueryFromProcess($Supervisor.Id,$Handle)
    $r.limitFlags=[EtherPhaseAJob]::QueryLimitFlags($inspection)
    $r.member=[EtherPhaseAJob]::Contains($inspection,$Child.Handle)
    $r.supervisorMember=[EtherPhaseAJob]::Contains($inspection,$Supervisor.Handle)
    if (($r.limitFlags -band 0x2000) -eq 0) { $r.reason='LIMIT_MISMATCH' }
    elseif (-not $r.member -or $r.supervisorMember) { $r.reason='JOB_MISMATCH' }
    elseif ($Supervisor.HasExited -or $Child.HasExited) { $r.reason='EARLY_EXIT' }
    else { $r.status='OBSERVED'; $r.reason='NONE' }
  } catch { $r.status='FAILED'; $r.reason='INSPECTION_FAILED' }
  finally {
    if ($inspection -ne [IntPtr]::Zero) {
      try { [EtherPhaseAJob]::Close($inspection); $r.released=$true }
      catch { $r.status='FAILED'; $r.reason='INSPECTION_RELEASE_FAILED' }
    }
  }
  return $r
}
function Invoke-PhaseAHostedSupervision($Account,$Token,[hashtable]$Backend,[string]$Evidence,[hashtable]$Sink=@{}) {
  $modes=@('supervisorDeath','jobClosure','timeout')
  $cases=@{}; foreach ($mode in $modes) { $cases[$mode]=@{status='NOT_RUN';evidence=$Evidence;reason='NOT_RUN'} }
  $Sink['cases']=$cases
  $Sink['processLifetime']=@{}
  if ($Evidence -cnotin @('INJECTED','LIVE') -or $Account.sid -cne $Token.sid) { return @{status='FAIL';cases=$cases} }
  foreach ($mode in $modes) {
    $reason='NONE'; $o=$null
    try { $o=& $Backend.Run $Account $Token $mode }
    catch { if ($_.Exception.GetBaseException().Message -ceq 'STAGE2_CHILD_UNCONFIRMED') { $cases[$mode]=@{status='FAIL';evidence=$Evidence;reason='CHILD_UNCONFIRMED'}; $Sink.processLifetime[$mode]=@{mode=$mode;source=$Evidence;error='CHILD_UNCONFIRMED';lastHandleVerified=$false;cleanupSucceeded=$false}; throw 'STAGE2_CHILD_UNCONFIRMED' }; $reason='BACKEND_FAILURE' }
    if ($o -is [hashtable] -and $o.ContainsKey('processLifetime') -and $o.processLifetime -is [hashtable]) {
      $copy=@{}; foreach ($key in @('mode','jobLimitFlags','handleCountBeforeClose','lastHandleVerified','supervisorPid','supervisorSid','supervisorCreatedAt','childPid','childSid','childCreatedAt','membership','childRunningBeforeAction','childWaitSucceeded','outerJobClosed','cleanupSucceeded','innerJobObservation','action','supervisorWaitSucceeded','error')) { if ($o.processLifetime.ContainsKey($key)) { $copy[$key]=$o.processLifetime[$key] } }; $copy['source']=$Evidence; $Sink.processLifetime[$mode]=$copy
    }
    if ($reason -ceq 'NONE') {
      if ($o -isnot [hashtable]) { $reason='MISSING_OBSERVATION' }
      elseif ($o.ContainsKey('outcome') -and $o.outcome -ceq 'FAILED' -and $o.ContainsKey('reason') -and $o.reason -cin @('SETUP_FAILED','LAUNCH_FAILED','SUPERVISOR_IDENTITY_MISMATCH','READINESS_MISSING','EARLY_EXIT','PID_MISMATCH','TIME_MISMATCH','JOB_MISMATCH','INNER_JOB_INSPECTION_FAILED','INSPECTION_RELEASE_FAILED','LIMIT_MISMATCH','TERMINATION_FAILED','CLEANUP_FAILED')) { $reason=$o.reason }
      elseif (-not $o.ContainsKey('outcome') -or $o.outcome -cne 'OBSERVED') { $reason='MISSING_OBSERVATION' }
      else {
        foreach ($test in @(@('identity','IDENTITY_MISMATCH'),@('pid','PID_MISMATCH'),@('creationTime','TIME_MISMATCH'),@('membership','JOB_MISMATCH'),@('supervisorTerminated','SUPERVISOR_SURVIVED'),@('childTerminated','CHILD_SURVIVED'),@('cleanup','CLEANUP_FAILED'))) {
          if (-not $o.ContainsKey($test[0]) -or $o[$test[0]] -isnot [bool] -or -not $o[$test[0]]) { $reason=$test[1]; break }
        }
        if ($reason -ceq 'NONE' -and $mode -ceq 'timeout' -and (-not $o.ContainsKey('timeoutObserved') -or $o.timeoutObserved -isnot [bool] -or -not $o.timeoutObserved)) { $reason='TIMEOUT_NOT_OBSERVED' }
      }
    }
    if ($reason -cne 'NONE') { $cases[$mode]=@{status='FAIL';evidence=$Evidence;reason=$reason}; return @{status='FAIL';cases=$cases} }
    $label=if ($Evidence -ceq 'INJECTED') {'SIMULATED_PASS'} else {'LIVE_OBSERVED'}
    $cases[$mode]=@{status=$label;evidence=$Evidence;reason='NONE'}
  }
  $status=if ($Evidence -ceq 'INJECTED') {'SIMULATED_PASS'} else {'LIVE_OBSERVED'}
  return @{status=$status;cases=$cases}
}
function New-PhaseAHostedSupervisorBackend {
  return @{Run={ param($account,$token,$mode)
    if ($mode -cnotin @('supervisorDeath','jobClosure','timeout') -or $account.sid -cne $token.sid) { throw 'invalid control' }
    $common=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($common)) { throw 'directory unavailable' }
    $parent=[IO.Path]::GetFullPath($common).TrimEnd('\')
    $root=Join-Path $parent ('ether-phase-a-supervisor-'+[Guid]::NewGuid().ToString('N'))
    $ready=Join-Path $root 'ready.json'; $gate=Join-Path $root 'gate'; $script=Join-Path $root 'PhaseA.HostedSupervisor.ps1'
    $lifetime=@{mode=$mode;jobLimitFlags=$null;handleCountBeforeClose=$null;lastHandleVerified=$false;supervisorPid=$null;supervisorSid=$null;supervisorCreatedAt=$null;childPid=$null;childSid=$null;childCreatedAt=$null;membership=$null;childRunningBeforeAction=$null;childWaitSucceeded=$null;outerJobClosed=$false;cleanupSucceeded=$false;innerJobObservation=$null;action='NOT_RUN';supervisorWaitSucceeded=$null;error='NOT_RUN'}
    $job=[IntPtr]::Zero; $supervisor=$null; $supProcess=$null; $child=$null; $created=$false; $resumed=$false; $identified=$false; $cleanupFailed=$false; $observed=$null; $failureReason='SETUP_FAILED'
    try {
      $null=New-Item -ItemType Directory -Path $root -ErrorAction Stop; $created=$true
      if (((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
      $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false)
      foreach ($sidText in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18',$account.sid)) {
        $sid=New-Object Security.Principal.SecurityIdentifier($sidText)
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $root -AclObject $acl -ErrorAction Stop
      foreach ($name in @('PhaseA.HostedSupervisor.ps1','PhaseA.Native.ps1','PhaseA.Atomic.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name) -ErrorAction Stop }
      $exe=Join-Path $PSHOME 'powershell.exe'
      foreach ($path in @($root,$script,$ready,$gate,$exe)) { if ($path.Contains('"')) { throw 'invalid path' } }
      $command='"'+$exe+'" -NoProfile -NonInteractive -File "'+$script+'" -Ready "'+$ready+'" -Gate "'+$gate+'" -Mode '+$mode
      $failureReason='LAUNCH_FAILED'
      $job=[EtherPhaseAJob]::Create()
      try { $lifetime.jobLimitFlags=[EtherPhaseAJob]::QueryLimitFlags($job) } catch { $lifetime.error='JOB_QUERY_FAILED' }
      $supervisor=[EtherPhaseAAtomic]::CreateWithTokenInDirectory($token.handle.DangerousGetHandle(),$job,$exe,$command,$root)
      if (-not $supervisor.InJob() -or $supervisor.Exited()) { throw 'supervisor job missing' }
      $failureReason='SUPERVISOR_IDENTITY_MISMATCH'
      $supProcess=Get-Process -Id $supervisor.Pid -ErrorAction Stop; $supToken=Get-PhaseAProcessToken $supProcess
      $lifetime.supervisorPid=$supToken.pid; $lifetime.supervisorSid=$supToken.sid; $lifetime.supervisorCreatedAt=$supToken.createdAt
      if ($supToken.sid -cne $account.sid -or $supToken.pid -ne $supervisor.Pid -or $supToken.admin -or $supToken.elevated -or -not $supToken.standard) { throw 'supervisor identity rejected' }
      $failureReason='READINESS_MISSING'
      $supervisor.Resume(); $resumed=$true; $deadline=[DateTime]::UtcNow.AddSeconds(30)
      while (-not [IO.File]::Exists($ready)) {
        if ($supervisor.Exited() -or [DateTime]::UtcNow -ge $deadline) { throw 'supervisor readiness failed' }
        Start-Sleep -Milliseconds 50
      }
      if ((Get-Item -LiteralPath $ready -ErrorAction Stop).Length -gt 4096) { throw 'invalid readiness' }
      $record=Get-Content -LiteralPath $ready -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $failureReason='PID_MISMATCH'
      $pidValue=0; if (-not [int]::TryParse([string]$record.pid,[ref]$pidValue) -or $pidValue -le 0) { throw 'invalid child pid' }
      $child=Get-Process -Id $pidValue -ErrorAction Stop; $identified=$true
      $processInfo=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$pidValue) -ErrorAction Stop
      $parentOk=($null -ne $processInfo -and $pidValue -ne $supervisor.Pid -and [int]$processInfo.ParentProcessId -eq $supervisor.Pid)
      $childToken=Get-PhaseAProcessToken $child
      $lifetime.childPid=$childToken.pid; $lifetime.childSid=$childToken.sid; $lifetime.childCreatedAt=$childToken.createdAt
      $failureReason='TIME_MISMATCH'
      $actualTime=[DateTimeOffset]::MinValue; $reportedTime=[DateTimeOffset]::MinValue
      $timeOk=[DateTimeOffset]::TryParse([string]$childToken.createdAt,[ref]$actualTime) -and [DateTimeOffset]::TryParse([string]$record.createdAt,[ref]$reportedTime) -and $actualTime -eq $reportedTime
      $identityOk=($childToken.sid -ceq $account.sid -and -not $childToken.admin -and -not $childToken.elevated -and $childToken.standard)
      $failureReason='JOB_MISMATCH'
      $member=[EtherPhaseAJob]::Contains($job,$child.Handle); $lifetime.membership=[bool]$member
      $observed=@{outcome='OBSERVED';identity=[bool]$identityOk;pid=[bool]($childToken.pid -eq $pidValue -and $parentOk);creationTime=[bool]$timeOk;membership=[bool]$member;timeoutObserved=$false;supervisorTerminated=$false;childTerminated=$false;cleanup=$false}
      if (-not $identityOk -or -not $timeOk -or -not $member -or $childToken.pid -ne $pidValue -or -not $parentOk) { return $observed }
      $failureReason='INNER_JOB_INSPECTION_FAILED'
      $handleValue=0L
      if (-not [long]::TryParse([string]$record.innerJobHandle,[ref]$handleValue) -or $handleValue -le 0) { throw 'inner job handle unavailable' }
      $inner=Get-PhaseAInnerJobInspection $supProcess $child $handleValue $pidValue ([string]$record.createdAt)
      $lifetime.innerJobObservation=$inner
      if ($inner.status -cne 'OBSERVED' -or -not $inner.released -or $inner.sid -cne $account.sid) {
        if ($inner.reason -cin @('INSPECTION_RELEASE_FAILED','LIMIT_MISMATCH','JOB_MISMATCH','PID_MISMATCH','TIME_MISMATCH')) { $failureReason=$inner.reason }
        throw 'inner job inspection rejected'
      }
      $failureReason='EARLY_EXIT'
      $lifetime.childRunningBeforeAction= -not $child.HasExited
      if (-not $lifetime.childRunningBeforeAction -or $supervisor.Exited()) { throw 'process exited before control' }
      $failureReason='TERMINATION_FAILED'
      if ($mode -ceq 'timeout') { $observed.timeoutObserved= -not $child.WaitForExit(250) }
      if ($mode -ceq 'jobClosure') { [IO.File]::WriteAllText($gate,'go'); $lifetime.action='CLOSE_REQUESTED' } else { $supervisor.Terminate(); $lifetime.action='SUPERVISOR_TERMINATED' }
      $observed.supervisorTerminated=[bool]$supervisor.Wait(10000); $lifetime.supervisorWaitSucceeded=$observed.supervisorTerminated
      $observed.childTerminated=[bool]$child.WaitForExit(10000); $lifetime.childWaitSucceeded=$observed.childTerminated
      if ($mode -ceq 'jobClosure' -and $observed.supervisorTerminated -and $supervisor.ExitCode() -ne 0) { $observed.supervisorTerminated=$false }
    } catch { $observed=@{outcome='FAILED';reason=$failureReason} }
    finally {
      if ($job -ne [IntPtr]::Zero) { try { try { $lifetime.handleCountBeforeClose=[EtherPhaseAJob]::QueryHandleCount($job) } catch { $lifetime.error='HANDLE_COUNT_UNAVAILABLE' }; [EtherPhaseAJob]::Close($job); $lifetime.outerJobClosed=$true } catch { $cleanupFailed=$true; $lifetime.error='JOB_CLOSE_FAILED' } }
      $supervisorConfirmed=($null -eq $supervisor)
      if ($supervisor) { try { if (-not $supervisor.Wait(5000)) { $supervisor.Terminate(); if (-not $supervisor.Wait(5000)) { throw 'unconfirmed' } }; $supervisorConfirmed=$true } catch { $supervisorConfirmed=$false } }
      $childConfirmed=$false
      if ($child) { try { $childConfirmed=[bool]$child.WaitForExit(5000) } catch { $childConfirmed=$false } }
      if (-not $supervisorConfirmed -or ($resumed -and (-not $identified -or -not $childConfirmed))) { throw 'STAGE2_CHILD_UNCONFIRMED' }
      if ($supervisor) { try { $supervisor.Dispose() } catch { $cleanupFailed=$true } }
      if ($supProcess) { try { $supProcess.Dispose() } catch { $cleanupFailed=$true } }
      if ($child) { try { $child.Dispose() } catch { $cleanupFailed=$true } }
      if ($created) {
        try {
          if (((Get-Item -LiteralPath $root -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
          foreach ($name in @('ready.json','gate','PhaseA.HostedSupervisor.ps1','PhaseA.Native.ps1','PhaseA.Atomic.ps1')) {
            $path=Join-Path $root $name
            if (Test-Path -LiteralPath $path) { $entry=Get-Item -LiteralPath $path -Force -ErrorAction Stop; if (($entry.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw 'unexpected entry' }; [IO.File]::Delete($path) }
          }
          [IO.Directory]::Delete($root,$false)
        } catch { $cleanupFailed=$true }
      }
      $lifetime.cleanupSucceeded= -not $cleanupFailed
      if ($null -ne $observed -and $observed.outcome -ceq 'OBSERVED') { $observed.cleanup= -not $cleanupFailed; if ($lifetime.error -ceq 'NOT_RUN') { $lifetime.error='NONE' }; $observed['processLifetime']=$lifetime }
      elseif ($cleanupFailed) { $observed=@{outcome='FAILED';reason='CLEANUP_FAILED';processLifetime=$lifetime} }
      elseif ($observed) { $lifetime.error=$failureReason; $observed['processLifetime']=$lifetime }
    }
    return $observed
  }}
}
