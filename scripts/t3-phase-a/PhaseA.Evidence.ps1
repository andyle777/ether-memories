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
function New-PhaseAEvidenceVerifier($Journal,$BoundRecord,[string]$RunAttempt,[bool]$ProvenanceVerified,[bool]$LiveAuthorized,[string]$EvidenceClass) {
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
      if ($kind -cnotin @('identityDistinct','brokerNonAdmin','legacyNonAdmin','brokerActorBinding','legacyActorBinding','actorPidBinding','actorCreationTimeBinding','actorSidBinding')) { return $false }
      $fresh=New-PhaseAManagerVerdictInput $candidate.commit $candidate.runId
      Add-PhaseAActorEvidence $fresh $items $EvidenceClass
      $expected=$fresh.cases[$kind]
      return ($entry -is [Collections.IDictionary] -and $entry.state -ceq 'PASS' -and $entry.evidence -ceq $EvidenceClass -and $entry.reason -ceq 'NONE' -and $expected.state -ceq 'PASS' -and $entry.proof -ceq $expected.proof)
    } catch { return $false }
  }.GetNewClosure()
}
