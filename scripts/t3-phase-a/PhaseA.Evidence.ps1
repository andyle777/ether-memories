Set-StrictMode -Version Latest
# A journal item is recorded only after the real Stage 2 backend has returned.
# Raw identity data remains in manager memory and is not written to the report.
function Add-PhaseAActorEvidence($VerdictInput,$Journal,[string]$EvidenceClass) {
  if ($EvidenceClass -cnotin @('LIVE_OBSERVED','SIMULATED_PASS') -or $VerdictInput -isnot [Collections.IDictionary] -or $VerdictInput.cases -isnot [Collections.IDictionary]) { return }
  $events=@($Journal)
  if ($events.Count -notin @(9,11)) { return }
  $sequence=@(@('broker','probe','allowed'),@('legacy','probe','allowed'),@('broker','Read','allowed'),@('broker','Create','allowed'),@('broker','Read','allowed'),@('legacy','Read','denied'),@('legacy','Overwrite','denied'),@('legacy','Create','denied'))
  if ($events.Count -eq 11) { $sequence+=@(@('legacy','Rename','denied'),@('legacy','Delete','denied')) }
  $sequence+=,@('legacy','Read','allowed')
  $roleSids=@{}; $canonical=New-Object 'System.Collections.Generic.List[object]'
  for ($i=0; $i -lt $sequence.Count; $i++) {
    $item=$events[$i]; $expected=$sequence[$i]
    if ($item -isnot [hashtable] -or $item.Count -ne 5) { return }
    foreach ($key in @('role','operation','accountSid','tokenSid','observation')) { if (-not $item.ContainsKey($key)) { return } }
    if ($item.role -cne $expected[0] -or $item.operation -cne $expected[1] -or $item.accountSid -isnot [string] -or
        [string]::IsNullOrWhiteSpace($item.accountSid) -or $item.tokenSid -cne $item.accountSid -or $item.observation -isnot [hashtable]) { return }
    if ($roleSids.ContainsKey($item.role) -and $roleSids[$item.role] -cne $item.accountSid) { return }; $roleSids[$item.role]=$item.accountSid
    $o=$item.observation
    if (-not $o.ContainsKey('expectedSid') -or $o.expectedSid -cne $item.accountSid -or
        -not $o.ContainsKey('contained') -or $o.contained -isnot [bool] -or -not $o.contained -or
        -not $o.ContainsKey('terminated') -or $o.terminated -isnot [bool] -or -not $o.terminated -or
        -not (Test-ActorObservation $o $item.role $expected[2])) { return }
    $canonical.Add([ordered]@{role=$item.role;operation=$item.operation;accountSid=$item.accountSid;tokenSid=$item.tokenSid;
      expectedSid=$o.expectedSid;observedSid=$o.observedSid;reportedSid=$o.reportedSid;expectedPid=$o.expectedPid;reportedPid=$o.reportedPid;
      createdAt=$o.createdAt;observedCreatedAt=$o.observedCreatedAt;expectedNonce=$o.expectedNonce;reportedNonce=$o.reportedNonce;
      tokenNonAdmin=$o.tokenNonAdmin;tokenObserved=$o.tokenObserved;outcome=$o.outcome;exitCode=$o.exitCode;contained=$o.contained;terminated=$o.terminated})
  }
  if (-not (Test-DistinctActorSids $roleSids.broker $roleSids.legacy)) { return }
  $controls=@('identityDistinct','brokerNonAdmin','legacyNonAdmin','brokerActorBinding','legacyActorBinding','actorPidBinding','actorCreationTimeBinding','actorSidBinding')
  foreach ($key in $controls) { if (-not $VerdictInput.cases.Contains($key) -or $VerdictInput.cases[$key].state -cne 'NOT_RUN') { return } }
  $json=ConvertTo-Json -InputObject @($canonical.ToArray()) -Compress -Depth 5
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    foreach ($key in $controls) {
      $bytes=[Text.Encoding]::UTF8.GetBytes($key+"`n"+$json)
      $proof=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
      $VerdictInput.cases[$key]=@{state='PASS';evidence=$EvidenceClass;reason='NONE';proof=$proof}
    }
  } finally { $sha.Dispose() }
}
function New-PhaseAActorJournalBackend([hashtable]$Backend,[Collections.Generic.List[object]]$Journal) {
  if (-not $Backend.ContainsKey('Run') -or $Backend.Run -isnot [scriptblock] -or $null -eq $Journal) { throw 'ACTOR_JOURNAL_INVALID' }
  $run=$Backend.Run
  $wrapped={
    param($account,$token,$operation,$target)
    $value=& $run $account $token $operation $target
    if ($value -is [hashtable]) {
      $kind=if ([string]::IsNullOrEmpty($operation)) {'probe'} else {$operation}
      $Journal.Add(@{role=$account.role;operation=$kind;accountSid=$account.sid;tokenSid=$token.sid;observation=$value})
    }
    return $value
  }.GetNewClosure()
  return @{Run=$wrapped}
}
function New-PhaseAEvidenceVerifier($Journal,$BoundRecord,[string]$RunAttempt,[bool]$ProvenanceVerified,[bool]$LiveAuthorized,[string]$EvidenceClass,$TokenJournal=@(),$HostedJournal=@{},$FilesystemJournal=@{}) {
  $boundAudience=Get-PhaseAEvidenceAudience $BoundRecord $RunAttempt
  $items=@($Journal)
  return {
    param($kind,$entry,$context)
    try {
      if ($context -isnot [Collections.IDictionary]) { return $false }
      if ($context.schema -ceq 'ether.t3.phase-a.final.v1') {
        if ($context.repository -cne 'andyle777/Ether-Memories' -or $context.workflowRef -cne 'andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run' -or $context.ref -cne 'refs/heads/test/t3-windows-enforcement-run' -or $context.event -cne 'push' -or $context.runner -cne 'github-hosted' -or $context.runAttempt -cne $RunAttempt) { return $false }
        $candidate=@{schema='ether.t3.phase-a.verdict-input.v1';policy=$context.policy;commit=$context.commit;runId=$context.runId;cases=$context.cases}
      } else { $candidate=$context }
      if ([string]::IsNullOrEmpty($boundAudience) -or (Get-PhaseAEvidenceAudience $candidate $RunAttempt) -cne $boundAudience) { return $false }
      if ($kind -ceq 'authorization') { return ($ProvenanceVerified -and $LiveAuthorized) }
      if ($kind -ceq 'workflow_provenance') { return $ProvenanceVerified }
      if ($kind -cnotin @('identityDistinct','brokerNonAdmin','legacyNonAdmin','brokerActorBinding','legacyActorBinding','actorPidBinding','actorCreationTimeBinding','actorSidBinding','brokerPrimaryToken','legacyPrimaryToken','jobContainment','jobClosure','aclInspection','unauthorizedRead','unauthorizedWrite','unauthorizedCreate')) { return $false }
      $fresh=New-PhaseAManagerVerdictInput $candidate.commit $candidate.runId
      Add-PhaseAActorEvidence $fresh $items $EvidenceClass
      Add-PhaseAPrimaryTokenEvidence $fresh $TokenJournal $items $EvidenceClass
      Add-PhaseAInnerJobEvidence $fresh $HostedJournal $items $EvidenceClass
      Add-PhaseAStage3Evidence $fresh $FilesystemJournal $EvidenceClass $items
      $expected=$fresh.cases[$kind]
      return ($entry -is [Collections.IDictionary] -and $expected.state -cin @('PASS','FAIL') -and $entry.state -ceq $expected.state -and $entry.evidence -ceq $EvidenceClass -and $entry.reason -ceq $expected.reason -and $entry.proof -ceq $expected.proof)
    } catch { return $false }
  }.GetNewClosure()
}
function Add-PhaseAPrimaryTokenEvidence($VerdictInput,$TokenJournal,$ActorJournal,[string]$EvidenceClass) {
  if ($EvidenceClass -cnotin @('LIVE_OBSERVED','SIMULATED_PASS')) { return }
  $items=@($TokenJournal); if ($items.Count -ne 2) { return }
  $actor=New-PhaseAManagerVerdictInput $VerdictInput.commit $VerdictInput.runId
  Add-PhaseAActorEvidence $actor $ActorJournal $EvidenceClass
  if ($actor.cases.actorSidBinding.state -cne 'PASS') { return }
  $canonical=New-Object 'System.Collections.Generic.List[object]'
  foreach ($i in 0,1) {
    $item=$items[$i]; $role=@('broker','legacy')[$i]
    if ($item -isnot [hashtable]) { return }
    foreach ($key in @('role','accountSid','first','second','closed')) { if (-not $item.ContainsKey($key)) { return } }
    if ($item.role -cne $role -or $item.closed -isnot [bool] -or -not $item.closed -or $item.first -isnot [hashtable] -or $item.second -isnot [hashtable]) { return }
    $first=$item.first; $second=$item.second
    foreach ($sample in @($first,$second)) { foreach ($key in @('sid','primary','admin','elevated','standard')) { if (-not $sample.ContainsKey($key)) { return } } }
    if (-not $second.ContainsKey('handleOpen')) { return }
    if ($item.accountSid -isnot [string] -or [string]::IsNullOrWhiteSpace($item.accountSid) -or $first.sid -cne $item.accountSid -or $second.sid -cne $item.accountSid -or $second.handleOpen -isnot [bool] -or -not $second.handleOpen) { return }
    foreach ($sample in @($first,$second)) {
      if ($sample.primary -isnot [bool] -or -not $sample.primary -or $sample.admin -isnot [bool] -or $sample.admin -or $sample.elevated -isnot [bool] -or $sample.elevated -or $sample.standard -isnot [bool] -or -not $sample.standard) { return }
    }
    $probe=@($ActorJournal | Where-Object { $_.role -ceq $role -and $_.operation -ceq 'probe' })
    if ($probe.Count -ne 1 -or $probe[0].accountSid -cne $item.accountSid) { return }
    $canonical.Add([ordered]@{role=$role;sid=$item.accountSid;primary=$second.primary;admin=$second.admin;elevated=$second.elevated;standard=$second.standard;handleOpen=$second.handleOpen;closed=$item.closed;actorProof=$actor.cases.actorSidBinding.proof})
  }
  $json=ConvertTo-Json -InputObject @($canonical.ToArray()) -Compress -Depth 5
  $sha=[Security.Cryptography.SHA256]::Create()
  try { foreach ($name in @('brokerPrimaryToken','legacyPrimaryToken')) {
    if ($VerdictInput.cases[$name].state -cne 'NOT_RUN') { return }
    $proof=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($name+"`n"+$json))).Replace('-','').ToLowerInvariant()
    $VerdictInput.cases[$name]=@{state='PASS';evidence=$EvidenceClass;reason='NONE';proof=$proof}
  } } finally { $sha.Dispose() }
}
function New-PhaseATokenJournalBackend([hashtable]$Backend,[Collections.Generic.List[object]]$Journal,[scriptblock]$Inspect) {
  if ($null -eq $Inspect -or $null -eq $Journal) { throw 'TOKEN_JOURNAL_INVALID' }
  $wrapped=$Backend.Clone(); $authenticate=$Backend.Authenticate; $close=$Backend.Close
  $wrapped.Authenticate={ param($account)
    $token=& $authenticate $account
    try {
      $first=@{sid=[string]$token.sid;primary=[bool]$token.primary;admin=[bool]$token.admin;elevated=[bool]$token.elevated;standard=[bool]$token.standard}
      $observation=& $Inspect $token
      if ($observation -isnot [hashtable]) { throw 'TOKEN_INSPECTION_FAILED' }
      $Journal.Add(@{role=$account.role;accountSid=$account.sid;first=$first;second=$observation;closed=$false})
      return $token
    } catch { try { $null=& $close $token } catch { throw 'ACCOUNT_CLEANUP_FAILED' }; throw }
  }.GetNewClosure()
  $wrapped.Close={ param($token)
    $null=& $close $token
    $matches=@($Journal | Where-Object { $_.accountSid -ceq $token.sid })
    if ($matches.Count -ne 1) { throw 'ACCOUNT_CLEANUP_FAILED' }
    $matches[0].closed=$true
  }.GetNewClosure()
  return $wrapped
}
function Test-PhaseACloseReceipt($Receipt,$Expected) {
  try {
    $fields=@('schema','mode','attempt','supervisorPid','supervisorCreatedAt','childPid','childCreatedAt','attempted','succeeded','error')
    if ($Receipt -isnot [Collections.IDictionary] -or $Expected -isnot [Collections.IDictionary] -or $Receipt.Count -ne $fields.Count) { return $false }
    foreach ($field in $fields) { if (-not (@($Receipt.Keys) -ccontains $field)) { return $false } }
    if ($Receipt.schema -cne 'ether.phase-a.close-receipt.v1' -or $Receipt.mode -cne 'jobClosure' -or $Expected.mode -cne 'jobClosure' -or $Receipt.attempt -isnot [string] -or $Receipt.attempt -cnotmatch '^[0-9a-f]{32}$' -or $Receipt.attempt -cne $Expected.attempt -or $Receipt.attempted -isnot [bool] -or -not $Receipt.attempted -or $Receipt.succeeded -isnot [bool]) { return $false }
    foreach ($field in @('supervisorPid','childPid')) { if ($Receipt[$field] -isnot [int] -or $Receipt[$field] -le 0 -or $Receipt[$field] -ne $Expected[$field]) { return $false } }
    foreach ($field in @('supervisorCreatedAt','childCreatedAt')) { $a=[DateTimeOffset]::MinValue; $b=[DateTimeOffset]::MinValue; if (-not [DateTimeOffset]::TryParse([string]$Receipt[$field],[ref]$a) -or -not [DateTimeOffset]::TryParse([string]$Expected[$field],[ref]$b) -or $a -ne $b) { return $false } }
    if ($Receipt.succeeded) { return ($Receipt.error -ceq 'NONE') }
    return ($Receipt.error -cin @('WIN32_ACCESS_DENIED','WIN32_INVALID_HANDLE','WIN32_OTHER','NON_WIN32'))
  } catch { return $false }
}
function Add-PhaseAInnerJobEvidence($VerdictInput,$HostedJournal,$ActorJournal,[string]$EvidenceClass) {
  try {
    if ($EvidenceClass -cnotin @('LIVE_OBSERVED','SIMULATED_PASS') -or $HostedJournal -isnot [hashtable]) { return }
    $source=if ($EvidenceClass -ceq 'LIVE_OBSERVED') {'LIVE'} else {'INJECTED'}
    $probes=@($ActorJournal | Where-Object { $_.role -ceq 'broker' -and $_.operation -ceq 'probe' })
    if ($probes.Count -ne 1) { return }
    $probe=$probes[0]; $obs=$probe.observation
    if ($probe.accountSid -cne $probe.tokenSid -or $obs.expectedSid -cne $probe.accountSid -or $obs.contained -isnot [bool] -or -not $obs.contained -or $obs.terminated -isnot [bool] -or -not $obs.terminated -or -not (Test-ActorObservation $obs 'broker' 'allowed')) { return }
    foreach ($mode in @('supervisorDeath','jobClosure')) {
      if (-not $HostedJournal.ContainsKey($mode)) { continue }
      $record=$HostedJournal[$mode]
      if ($record -isnot [hashtable] -or $record.source -cne $source -or $record.mode -cne $mode -or $record.innerJobObservation -isnot [hashtable] -or $record.cleanupSucceeded -isnot [bool]) { continue }
      $inner=$record.innerJobObservation
      if ($record.supervisorSid -cne $probe.accountSid -or $record.supervisorPid -isnot [int] -or $record.supervisorPid -le 0 -or $record.childPid -isnot [int] -or $record.childPid -le 0 -or $record.supervisorPid -eq $record.childPid -or $record.childSid -cne $probe.accountSid -or $inner.pid -isnot [int] -or $inner.sid -isnot [string] -or $inner.createdAt -isnot [string]) { continue }
      $identityMismatch=($inner.pid -ne $record.childPid -or $inner.sid -cne $record.childSid -or $inner.createdAt -cne $record.childCreatedAt)
      $supervisorTime=[DateTimeOffset]::MinValue; if (-not [DateTimeOffset]::TryParse([string]$record.supervisorCreatedAt,[ref]$supervisorTime)) { continue }
      $outcome='NOT_RUN'; $reason='NOT_RUN'; $control=if ($mode -ceq 'supervisorDeath') {'jobContainment'} else {'jobClosure'}
      $limitsValid=(($inner.limitFlags -is [int] -or $inner.limitFlags -is [uint32]) -and (($inner.limitFlags -band 0x2000) -ne 0))
      $memberValid=($inner.member -is [bool] -and $inner.member -and $inner.supervisorMember -is [bool] -and -not $inner.supervisorMember)
      $released=($inner.released -is [bool] -and $inner.released)
      $innerValid=($inner.status -ceq 'OBSERVED' -and $inner.reason -ceq 'NONE' -and $limitsValid -and $memberValid -and $released)
      if ($mode -ceq 'supervisorDeath') {
        if ($identityMismatch) { $outcome='FAIL';$reason='SETUP_FAILED' }
        elseif ($innerValid) { $outcome='PASS';$reason='NONE' }
        elseif ($inner.status -ceq 'FAILED' -and $released -and (($inner.reason -ceq 'LIMIT_MISMATCH' -and -not $limitsValid -and ($inner.limitFlags -is [int] -or $inner.limitFlags -is [uint32])) -or ($inner.reason -ceq 'JOB_MISMATCH' -and $limitsValid -and $inner.member -is [bool] -and $inner.supervisorMember -is [bool] -and -not $memberValid))) { $outcome='FAIL';$reason='CONTROL_FAILED' }
        elseif ($inner.status -ceq 'FAILED' -and $inner.reason -cin @('INSPECTION_FAILED','INSPECTION_RELEASE_FAILED','PID_MISMATCH','TIME_MISMATCH','EARLY_EXIT')) { $outcome='FAIL';$reason='SETUP_FAILED' }
      } elseif (-not $identityMismatch -and $innerValid -and $record.childRunningBeforeAction -is [bool] -and $record.childRunningBeforeAction -and $record.action -ceq 'CLOSE_REQUESTED' -and $record.supervisorWaitSucceeded -is [bool] -and $record.supervisorWaitSucceeded -and $record.supervisorExitCode -is [int] -and (Test-PhaseACloseReceipt $record.closeReceipt $record)) {
        if (-not $record.closeReceipt.succeeded) { $outcome='FAIL';$reason='SETUP_FAILED' }
        elseif ($record.childWaitOutcome -ceq 'SIGNALED' -and $record.supervisorExitCode -eq 0 -and $record.childAliveAfterWait -is [bool] -and -not $record.childAliveAfterWait -and $record.childExitCode -is [int] -and $record.childExitCode -ne 259) { $outcome='PASS';$reason='NONE' }
        elseif ($record.childWaitOutcome -ceq 'TIMEOUT' -and $record.childAliveAfterWait -is [bool] -and $record.childAliveAfterWait -and $null -eq $record.childExitCode) { $outcome='FAIL';$reason='CONTROL_FAILED' }
        elseif ($record.childWaitOutcome -ceq 'FAILED') { $outcome='FAIL';$reason='SETUP_FAILED' }
      }
      if ($outcome -ceq 'NOT_RUN') { continue }
      if (-not $record.cleanupSucceeded -and $outcome -ceq 'PASS') { $outcome='FAIL';$reason='CLEANUP_UNCONFIRMED' }
      if ($VerdictInput.cases[$control].state -cne 'NOT_RUN') { continue }
      $canonical=[ordered]@{control=$control;mode=$mode;state=$outcome;reason=$reason;supervisorPid=$record.supervisorPid;supervisorSid=$record.supervisorSid;supervisorCreatedAt=$record.supervisorCreatedAt;reportedChildPid=$record.childPid;reportedChildSid=$record.childSid;reportedChildCreatedAt=$record.childCreatedAt;pid=$inner.pid;sid=$inner.sid;createdAt=$inner.createdAt;innerStatus=$inner.status;innerReason=$inner.reason;limitFlags=$inner.limitFlags;member=$inner.member;supervisorMember=$inner.supervisorMember;released=$inner.released;cleanup=$record.cleanupSucceeded;actorPid=$obs.expectedPid;actorCreatedAt=$obs.observedCreatedAt}
      if ($mode -ceq 'jobClosure') {
        foreach ($key in @('childRunningBeforeAction','action','supervisorWaitSucceeded','supervisorExitCode','childWaitOutcome','childExitCode','childAliveAfterWait','attempt')) { $canonical[$key]=$record[$key] }
        $r=$record.closeReceipt; $canonical['closeReceipt']=[ordered]@{schema=$r.schema;mode=$r.mode;attempt=$r.attempt;supervisorPid=$r.supervisorPid;supervisorCreatedAt=$r.supervisorCreatedAt;childPid=$r.childPid;childCreatedAt=$r.childCreatedAt;attempted=$r.attempted;succeeded=$r.succeeded;error=$r.error}
      }
      $sha=[Security.Cryptography.SHA256]::Create()
      try { $json=ConvertTo-Json -InputObject $canonical -Compress; $proof=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
      $VerdictInput.cases[$control]=@{state=$outcome;evidence=$EvidenceClass;reason=$reason;proof=$proof}
    }
  } catch { return }
}function Add-PhaseAStage3Evidence($VerdictInput,$Evidence,[string]$EvidenceClass,$ActorJournal=@()) {
  try {
    if ($EvidenceClass -cnotin @('LIVE_OBSERVED','SIMULATED_PASS') -or $Evidence -isnot [hashtable] -or $Evidence.cleanupVerified -isnot [bool]) { return }
    if ($Evidence.cleanupVerified -and $Evidence.ContainsKey('aclInspection')) {
      $acl=$Evidence.aclInspection
      if ($acl -is [hashtable] -and $acl.protected -is [bool] -and $acl.protected -and $acl.expected -is [string] -and $acl.expected.Length -gt 0 -and $acl.expected -ceq $acl.actual -and $VerdictInput.cases.aclInspection.state -ceq 'NOT_RUN') {
        $sha=[Security.Cryptography.SHA256]::Create();try {$json=ConvertTo-Json -Compress -InputObject ([ordered]@{control='aclInspection';expected=$acl.expected;actual=$acl.actual;protected=$acl.protected;cleanup=$true});$hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        $VerdictInput.cases.aclInspection=@{state='PASS';evidence=$EvidenceClass;reason='NONE';proof=$hash}
      }
    }
    $probes=@($ActorJournal | Where-Object { $_.role -ceq 'legacy' -and $_.operation -ceq 'probe' })
    if ($probes.Count -ne 1) { return }
    $probe=$probes[0]; $probeObs=$probe.observation
    if ($probe.accountSid -cne $probe.tokenSid -or $probeObs.expectedSid -cne $probe.accountSid -or $probeObs.contained -isnot [bool] -or -not $probeObs.contained -or $probeObs.terminated -isnot [bool] -or -not $probeObs.terminated -or -not (Test-ActorObservation $probeObs 'legacy' 'allowed')) { return }
    if ($Evidence.ContainsKey('unauthorizedRead') -and $Evidence.ContainsKey('witnessControls') -and $Evidence.ContainsKey('aclInspection')) {
      $entry=$Evidence.unauthorizedRead; $controls=$Evidence.witnessControls; $acl=$Evidence.aclInspection
      $brokers=@($ActorJournal | Where-Object { $_.role -ceq 'broker' -and $_.operation -ceq 'probe' })
      if ($entry -is [hashtable] -and $controls -is [hashtable] -and $acl -is [hashtable] -and $brokers.Count -eq 1) {
        $broker=$brokers[0]; $bo=$broker.observation; $o=$entry.observation; $w=$entry.witness
        $source=if ($EvidenceClass -ceq 'LIVE_OBSERVED') {'LIVE'} else {'INJECTED'}
        $validBroker=($broker.accountSid -ceq $broker.tokenSid -and $broker.accountSid -cne $probe.accountSid -and $bo.expectedSid -ceq $broker.accountSid -and $bo.contained -is [bool] -and $bo.contained -and $bo.terminated -is [bool] -and $bo.terminated -and (Test-ActorObservation $bo 'broker' 'allowed'))
        $validAcl=($acl.protected -is [bool] -and $acl.protected -and $acl.expected -is [string] -and $acl.expected.Length -gt 0 -and $acl.expected -ceq $acl.actual)
        $goodControls=$true
        foreach ($spec in @(@('authorizedRead',$broker.accountSid,'protectedFile'),@('permissiveRead',$probe.accountSid,'controlFile'))) {
          if (-not $controls.ContainsKey($spec[0])) { $goodControls=$false; break }
          $c=$controls[$spec[0]]
          if ($c -isnot [hashtable] -or $c.status -cne 'OBSERVED' -or $c.reason -cne 'NONE' -or $c.evidence -cne $source -or $c.sid -cne $spec[1] -or $c.operation -cne 'Read' -or $c.target -cne $spec[2] -or $c.outcome -cne 'ALLOWED' -or $c.nativeError -isnot [int] -or $c.nativeError -ne 0 -or $c.reverted -isnot [bool] -or -not $c.reverted -or $c.handlesClosed -isnot [bool] -or -not $c.handlesClosed) { $goodControls=$false; break }
        }
        $goodWitness=($w -is [hashtable] -and $w.status -ceq 'OBSERVED' -and $w.reason -ceq 'NONE' -and $w.evidence -ceq $source -and $w.sid -ceq $probe.accountSid -and $w.operation -ceq 'Read' -and $w.target -ceq 'protectedFile' -and $w.nativeError -is [int] -and (($w.outcome -ceq 'ACCESS_DENIED' -and $w.nativeError -eq 5) -or ($w.outcome -ceq 'ALLOWED' -and $w.nativeError -eq 0)) -and $w.reverted -is [bool] -and $w.reverted -and $w.handlesClosed -is [bool] -and $w.handlesClosed)
        $goodActor=($o -is [hashtable] -and $o.errorCategory -ceq 'ACCESS_DENIED' -and $o.errorCode -is [int] -and $o.errorCode -eq 5 -and $o.expectedSid -ceq $probe.accountSid -and $o.contained -is [bool] -and $o.contained -and $o.terminated -is [bool] -and $o.terminated -and (Test-ActorObservation $o 'legacy' 'denied'))
        $goodResource=($entry.control -ceq 'unauthorizedRead' -and $entry.operation -ceq 'Read' -and $entry.target -ceq 'protectedFile' -and $entry.accountSid -ceq $probe.accountSid -and $entry.tokenSid -ceq $probe.accountSid -and $entry.beforeExists -is [bool] -and $entry.beforeExists -and $entry.parentExists -is [bool] -and $entry.parentExists -and $entry.afterExists -is [bool] -and $entry.afterExists -and $entry.beforeInventory -cmatch '^[0-9a-f]{64}$' -and $entry.beforeInventory -ceq $entry.afterInventory -and $entry.beforeDigest -cmatch '^[0-9a-f]{64}$')
        if ($validBroker -and $validAcl -and $goodControls -and $goodWitness -and $goodActor -and $goodResource -and $VerdictInput.cases.unauthorizedRead.state -ceq 'NOT_RUN') {
          $state=if($w.outcome -ceq 'ALLOWED'){'FAIL'}elseif($Evidence.cleanupVerified){'PASS'}else{'NOT_RUN'}
          if ($state -cne 'NOT_RUN') {
            $reason=if($state -ceq 'FAIL'){'VIOLATION'}else{'NONE'}
            $canonical=[ordered]@{control='unauthorizedRead';brokerSid=$broker.accountSid;legacySid=$probe.accountSid;pid=$o.expectedPid;createdAt=$o.observedCreatedAt;nonce=$o.expectedNonce;actorOutcome=$o.outcome;actorError=$o.errorCode;witnessOutcome=$w.outcome;witnessError=$w.nativeError;authorized=$controls.authorizedRead.outcome;permissive=$controls.permissiveRead.outcome;inventory=$entry.beforeInventory;digest=$entry.beforeDigest;acl=$acl.actual;cleanup=$Evidence.cleanupVerified;state=$state}
            $sha=[Security.Cryptography.SHA256]::Create(); try {$json=ConvertTo-Json -Compress -InputObject $canonical;$hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
            $VerdictInput.cases.unauthorizedRead=@{state=$state;evidence=$EvidenceClass;reason=$reason;proof=$hash}
          }
        }
      }
    }
    if ($Evidence.ContainsKey('witnessControls') -and $Evidence.ContainsKey('aclInspection')) {
      $controls=$Evidence.witnessControls; $acl=$Evidence.aclInspection
      $brokers=@($ActorJournal | Where-Object { $_.role -ceq 'broker' -and $_.operation -ceq 'probe' })
      if ($controls -is [hashtable] -and $acl -is [hashtable] -and $brokers.Count -eq 1) {
        $broker=$brokers[0];$bo=$broker.observation;$source=if($EvidenceClass -ceq 'LIVE_OBSERVED'){'LIVE'}else{'INJECTED'}
        $baseOk=($acl.protected -is [bool] -and $acl.protected -and $acl.expected -is [string] -and $acl.expected.Length -gt 0 -and $acl.expected -ceq $acl.actual -and $broker.accountSid -ceq $broker.tokenSid -and $broker.accountSid -cne $probe.accountSid -and $bo.expectedSid -ceq $broker.accountSid -and $bo.contained -is [bool] -and $bo.contained -and $bo.terminated -is [bool] -and $bo.terminated -and (Test-ActorObservation $bo 'broker' 'allowed'))
        foreach($spec in @(@('unauthorizedWrite','Overwrite','protectedFile','authorizedWrite','permissiveWrite','protectedFile','controlFile'),@('unauthorizedCreate','Create','deniedFile','authorizedCreate','permissiveCreate','authorizedProbeFile','controlProbeFile'))) {
          $key=$spec[0];if(-not $baseOk -or -not $Evidence.ContainsKey($key) -or -not $controls.ContainsKey($spec[3]) -or -not $controls.ContainsKey($spec[4])){continue}
          $entry=$Evidence[$key];if($entry -isnot [hashtable] -or $entry.control -cne $key -or $entry.operation -cne $spec[1] -or $entry.target -cne $spec[2] -or $entry.accountSid -cne $probe.accountSid -or $entry.tokenSid -cne $probe.accountSid -or $entry.beforeExists -isnot [bool] -or $entry.parentExists -isnot [bool] -or -not $entry.parentExists -or $entry.afterExists -isnot [bool] -or $entry.beforeInventory -cnotmatch '^[0-9a-f]{64}$' -or $entry.afterInventory -cnotmatch '^[0-9a-f]{64}$'){continue}
          if (($key -ceq 'unauthorizedWrite' -and -not $entry.beforeExists) -or ($key -ceq 'unauthorizedCreate' -and $entry.beforeExists)){continue}
          $controlsOk=$true
          foreach($cs in @(@($spec[3],$broker.accountSid,$spec[5]),@($spec[4],$probe.accountSid,$spec[6]))) {
            $c=$controls[$cs[0]]
            if($c -isnot [hashtable] -or $c.status -cne 'OBSERVED' -or $c.reason -cne 'NONE' -or $c.evidence -cne $source -or $c.sid -cne $cs[1] -or $c.operation -cne $spec[1] -or $c.target -cne $cs[2] -or $c.outcome -cne 'ALLOWED' -or $c.nativeError -isnot [int] -or $c.nativeError -ne 0 -or $c.reverted -isnot [bool] -or -not $c.reverted -or $c.handlesClosed -isnot [bool] -or -not $c.handlesClosed -or ($spec[1] -ceq 'Create' -and ($c.removed -isnot [bool] -or -not $c.removed))) {$controlsOk=$false;break}
          }
          if(-not $controlsOk){continue}
          $o=$entry.observation;$w=$entry.witness
          if($o -isnot [hashtable] -or $o.expectedSid -cne $probe.accountSid -or $o.errorCategory -cne 'ACCESS_DENIED' -or $o.errorCode -isnot [int] -or $o.errorCode -ne 5 -or $o.contained -isnot [bool] -or -not $o.contained -or $o.terminated -isnot [bool] -or -not $o.terminated -or -not (Test-ActorObservation $o 'legacy' 'denied')){continue}
          if($w -isnot [hashtable] -or $w.status -cne 'OBSERVED' -or $w.reason -cne 'NONE' -or $w.evidence -cne $source -or $w.sid -cne $probe.accountSid -or $w.operation -cne $spec[1] -or $w.target -cne $spec[2] -or $w.reverted -isnot [bool] -or -not $w.reverted -or $w.handlesClosed -isnot [bool] -or -not $w.handlesClosed -or $w.nativeError -isnot [int]){continue}
          $state='NOT_RUN';$reason='NOT_RUN'
          if($w.outcome -ceq 'ACCESS_DENIED' -and $w.nativeError -eq 5 -and $Evidence.cleanupVerified -and $entry.beforeInventory -ceq $entry.afterInventory -and $entry.afterExists -eq $entry.beforeExists){$state='PASS';$reason='NONE'}
          elseif($w.outcome -ceq 'ALLOWED' -and $w.nativeError -eq 0 -and ($key -cne 'unauthorizedCreate' -or ($entry.afterExists -and $entry.beforeInventory -cne $entry.afterInventory))){$state='FAIL';$reason='VIOLATION'}
          if($state -ceq 'NOT_RUN' -or $VerdictInput.cases[$key].state -cne 'NOT_RUN'){continue}
          $canonical=[ordered]@{control=$key;operation=$entry.operation;target=$entry.target;brokerSid=$broker.accountSid;legacySid=$probe.accountSid;pid=$o.expectedPid;createdAt=$o.observedCreatedAt;nonce=$o.expectedNonce;actorOutcome=$o.outcome;actorError=$o.errorCode;witnessOutcome=$w.outcome;witnessError=$w.nativeError;beforeExists=$entry.beforeExists;afterExists=$entry.afterExists;beforeInventory=$entry.beforeInventory;afterInventory=$entry.afterInventory;acl=$acl.actual;cleanup=$Evidence.cleanupVerified;state=$state}
          $sha=[Security.Cryptography.SHA256]::Create();try{$json=ConvertTo-Json -Compress -InputObject $canonical;$hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
          $VerdictInput.cases[$key]=@{state=$state;evidence=$EvidenceClass;reason=$reason;proof=$hash}
        }
      }
    }
    foreach($spec in @(@('unauthorizedWrite','Overwrite','protectedFile'),@('unauthorizedCreate','Create','deniedFile'))) {
      $key=$spec[0];if(-not $Evidence.ContainsKey($key)){continue};$entry=$Evidence[$key];if($entry -isnot [hashtable] -or $entry.control -cne $key -or $entry.operation -cne $spec[1] -or $entry.target -cne $spec[2] -or $entry.accountSid -cne $entry.tokenSid -or $entry.accountSid -cne $probe.accountSid -or $entry.parentExists -isnot [bool] -or -not $entry.parentExists -or $entry.beforeExists -isnot [bool] -or $entry.afterExists -isnot [bool] -or -not $entry.afterExists -or $entry.beforeInventory -cnotmatch '^[0-9a-f]{64}$' -or $entry.afterInventory -cnotmatch '^[0-9a-f]{64}$' -or $entry.beforeInventory -ceq $entry.afterInventory){continue}
      if (($key -ceq 'unauthorizedWrite' -and -not $entry.beforeExists) -or ($key -ceq 'unauthorizedCreate' -and $entry.beforeExists)){continue}
      $o=$entry.observation;if($o -isnot [hashtable] -or -not $o.ContainsKey('errorCategory') -or $o.errorCategory -cne 'NONE' -or -not $o.ContainsKey('errorCode') -or $o.errorCode -isnot [int] -or $o.errorCode -ne 0 -or $o.expectedSid -cne $entry.accountSid -or $o.contained -isnot [bool] -or -not $o.contained -or $o.terminated -isnot [bool] -or -not $o.terminated -or -not (Test-ActorObservation $o 'legacy' 'allowed')){continue}
      if($VerdictInput.cases[$key].state -cne 'NOT_RUN'){continue}
      $canonical=[ordered]@{control=$key;operation=$entry.operation;target=$entry.target;accountSid=$entry.accountSid;beforeExists=$entry.beforeExists;parentExists=$entry.parentExists;beforeInventory=$entry.beforeInventory;afterExists=$entry.afterExists;afterInventory=$entry.afterInventory;pid=$o.expectedPid;sid=$o.observedSid;createdAt=$o.observedCreatedAt;nonce=$o.expectedNonce;result=$o.outcome;error=$o.errorCategory;errorCode=$o.errorCode;cleanup=$Evidence.cleanupVerified}
      $sha=[Security.Cryptography.SHA256]::Create();try {$json=ConvertTo-Json -Compress -InputObject $canonical;$hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
      $VerdictInput.cases[$key]=@{state='FAIL';evidence=$EvidenceClass;reason='VIOLATION';proof=$hash}
    }
  } catch { return }
}
