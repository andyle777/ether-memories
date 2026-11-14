Set-StrictMode -Version Latest
# The provisional policy does not adopt the proposed delete/rename addendum.
function Get-PhaseAVerdictPolicy {
  return @('identityDistinct','brokerNonAdmin','legacyNonAdmin','brokerPrimaryToken','legacyPrimaryToken',
    'brokerActorBinding','legacyActorBinding','actorPidBinding','actorCreationTimeBinding','actorSidBinding',
    'jobContainment','supervisorTermination','jobClosure','childTermination','alternateTimeout',
    'ntfsVolume','aclEstablishment','aclInspection','authorizedRead','authorizedCreate','authorizedReadback',
    'unauthorizedRead','unauthorizedWrite','unauthorizedCreate','protectedInventory','insecureAclControl',
    'processCleanup','fixtureCleanup','accountCleanup','experimentComplete')
}
function Test-PhaseAVerdictInputShape($Record) {
  if ($Record -isnot [Collections.IDictionary] -or $Record.Count -ne 5) { return $false }
  foreach ($key in @('schema','policy','commit','runId','cases')) { if (-not (@($Record.Keys) -ccontains $key)) { return $false } }
  foreach ($key in @('schema','policy','commit','runId')) { if ($Record[$key] -isnot [string]) { return $false } }
  if ($Record.schema -cne 'ether.t3.phase-a.verdict-input.v1' -or $Record.policy -cne 'phase-a-core-provisional-v1' -or
      $Record.commit -cnotmatch '^[0-9a-f]{40}$' -or $Record.runId -cnotmatch '^[1-9][0-9]{0,19}$' -or
      $Record.cases -isnot [Collections.IDictionary]) { return $false }
  $policy=@(Get-PhaseAVerdictPolicy)
  if ($Record.cases.Count -ne $policy.Count) { return $false }
  foreach ($key in $policy) {
    if (-not (@($Record.cases.Keys) -ccontains $key)) { return $false }
    $entry=$Record.cases[$key]
    if ($entry -isnot [Collections.IDictionary] -or $entry.Count -ne 4) { return $false }
    foreach ($field in @('state','evidence','reason','proof')) { if (-not (@($entry.Keys) -ccontains $field)) { return $false } }
    foreach ($field in @('state','evidence','reason','proof')) { if ($entry[$field] -isnot [string]) { return $false } }
    if ($entry.state -cnotin @('PASS','FAIL','NOT_RUN') -or $entry.evidence -cnotin @('LIVE_OBSERVED','SIMULATED_PASS','SAME_IDENTITY_PASS','NOT_RUN')) { return $false }
    if ($entry.state -ceq 'NOT_RUN') {
      if ($entry.evidence -cne 'NOT_RUN' -or $entry.reason -cne 'NOT_RUN' -or $entry.proof -cne '') { return $false }
    } elseif ($entry.proof -cnotmatch '^[0-9a-f]{64}$' -or $entry.evidence -ceq 'NOT_RUN' -or
      ($entry.state -ceq 'PASS' -and $entry.reason -cne 'NONE') -or
      ($entry.state -ceq 'FAIL' -and $entry.reason -cnotin @('VIOLATION','CONTROL_FAILED','SETUP_FAILED','CLEANUP_UNCONFIRMED'))) { return $false }
  }
  return $true
}
function Get-PhaseAVerdict($Record,[scriptblock]$Verify) {
  $unverified=@{status='UNVERIFIED';reason='MISSING_OR_UNTRUSTED_EVIDENCE'}
  if ($null -eq $Verify -or -not (Test-PhaseAVerdictInputShape $Record)) { return $unverified }
  $policy=@(Get-PhaseAVerdictPolicy)
  try {
    foreach ($kind in @('authorization','workflow_provenance')) {
      $ok=& $Verify $kind $null $Record
      if ($ok -isnot [bool] -or -not $ok) { return $unverified }
    }
    $verified=@{}
    foreach ($key in $policy) {
      $entry=$Record.cases[$key]
      if ($entry.state -ceq 'NOT_RUN' -or $entry.evidence -cne 'LIVE_OBSERVED') { $verified[$key]=$false; continue }
      $ok=& $Verify $key $entry $Record
      $verified[$key]=($ok -is [bool] -and $ok)
    }
    foreach ($key in $policy) {
      $entry=$Record.cases[$key]
      if (-not $verified[$key] -or ($entry.state -ceq 'FAIL' -and $entry.reason -cin @('SETUP_FAILED','CLEANUP_UNCONFIRMED'))) { return $unverified }
    }
    foreach ($key in @('processCleanup','fixtureCleanup','accountCleanup','experimentComplete')) {
      if (-not $verified[$key] -or $Record.cases[$key].state -cne 'PASS') { return $unverified }
    }
    foreach ($key in $policy) {
      $entry=$Record.cases[$key]
      if ($verified[$key] -and $entry.state -ceq 'FAIL' -and $entry.reason -cin @('VIOLATION','CONTROL_FAILED')) { return @{status='RED';reason='MANDATORY_CONTROL_FAILED'} }
    }
    foreach ($key in $policy) { if (-not $verified[$key] -or $Record.cases[$key].state -cne 'PASS') { return $unverified } }
    return @{status='GREEN';reason='ALL_MANDATORY_CONTROLS_VERIFIED'}
  } catch { return $unverified }
}
function New-PhaseAManagerVerdictInput([string]$Commit,[string]$RunId) {
  # Aggregate stage statuses do not carry the independent proof required by this policy.
  $cases=@{}
  foreach ($key in @(Get-PhaseAVerdictPolicy)) { $cases[$key]=@{state='NOT_RUN';evidence='NOT_RUN';reason='NOT_RUN';proof=''} }
  return @{schema='ether.t3.phase-a.verdict-input.v1';policy='phase-a-core-provisional-v1';commit=$Commit;runId=$RunId;cases=$cases}
}
function Test-PhaseAFinalReport($Report,[scriptblock]$Verify) {
  $fields=@('schema','policy','repository','workflowRef','ref','event','runner','commit','runId','runAttempt','status','reason','cleanup','provenance','cases')
  if ($Report -isnot [Collections.IDictionary] -or $null -eq $Verify -or $Report.Count -ne $fields.Count) { return $false }
  foreach ($field in $fields) { if (-not (@($Report.Keys) -ccontains $field)) { return $false } }
  foreach ($field in $fields | Where-Object { $_ -cne 'cases' }) { if ($Report[$field] -isnot [string]) { return $false } }
  if ($Report.schema -cne 'ether.t3.phase-a.final.v1' -or $Report.policy -cne 'phase-a-core-provisional-v1' -or $Report.status -cnotin @('GREEN','RED','UNVERIFIED') -or $Report.cleanup -cnotin @('COMPLETE','UNCONFIRMED','NOT_RUN') -or $Report.provenance -cnotin @('VERIFIED','UNVERIFIED')) { return $false }
  $metadata=@{repository='andyle777/Ether-Memories';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted'}
  foreach ($field in $metadata.Keys) { if ($Report[$field] -cne 'unknown' -and $Report[$field] -cne $metadata[$field]) { return $false } }
  $unknown=($Report.commit -ceq 'unknown' -or $Report.runId -ceq 'unknown' -or $Report.runAttempt -ceq 'unknown')
  if ($unknown -and $Report.status -cne 'UNVERIFIED') { return $false }
  $shapeCommit=if ($Report.commit -ceq 'unknown') { '0'*40 } else { $Report.commit }
  $shapeRun=if ($Report.runId -ceq 'unknown') { '1' } else { $Report.runId }
  $record=@{schema='ether.t3.phase-a.verdict-input.v1';policy=$Report.policy;commit=$shapeCommit;runId=$shapeRun;cases=$Report.cases}
  if (-not (Test-PhaseAVerdictInputShape $record)) { return $false }
  if ($Report.runAttempt -cne 'unknown' -and $Report.runAttempt -cnotmatch '^[1-9][0-9]{0,9}$') { return $false }
  if ($Report.cleanup -ceq 'COMPLETE') {
    foreach ($key in @('processCleanup','fixtureCleanup','accountCleanup')) {
      $entry=$Report.cases[$key]
      if ($entry.state -cne 'PASS' -or $entry.evidence -cne 'LIVE_OBSERVED') { return $false }
      try { $ok=& $Verify $key $entry $Report; if ($ok -isnot [bool] -or -not $ok) { return $false } } catch { return $false }
    }
  }
  if ($Report.status -ceq 'UNVERIFIED') {
    if ($Report.reason -cne 'MISSING_OR_UNTRUSTED_EVIDENCE') { return $false }
    if ($Report.provenance -ceq 'VERIFIED') { try { $ok=& $Verify 'workflow_provenance' $null $Report; return ($ok -is [bool] -and $ok) } catch { return $false } }
    return $true
  }
  if ($Report.provenance -cne 'VERIFIED') { return $false }
  if ($Report.repository -cne 'andyle777/Ether-Memories' -or $Report.workflowRef -cne 'andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run' -or $Report.ref -cne 'refs/heads/test/t3-windows-enforcement-run' -or $Report.event -cne 'push' -or $Report.runner -cne 'github-hosted' -or $Report.cleanup -cne 'COMPLETE') { return $false }
  $check={param($kind,$entry,$unused) & $Verify $kind $entry $Report}.GetNewClosure()
  $computed=Get-PhaseAVerdict $record $check
  return ($computed.status -ceq $Report.status -and $computed.reason -ceq $Report.reason)
}
