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
function Get-PhaseAVerdict($Record,[scriptblock]$Verify) {
  $unverified=@{status='UNVERIFIED';reason='MISSING_OR_UNTRUSTED_EVIDENCE'}
  if ($Record -isnot [Collections.IDictionary] -or $null -eq $Verify -or $Record.Count -ne 5) { return $unverified }
  foreach ($key in @('schema','policy','commit','runId','cases')) { if (-not $Record.Contains($key)) { return $unverified } }
  foreach ($key in @('schema','policy','commit','runId')) { if ($Record[$key] -isnot [string]) { return $unverified } }
  if ($Record.schema -cne 'ether.t3.phase-a.verdict-input.v1' -or $Record.policy -cne 'phase-a-core-provisional-v1' -or
      $Record.commit -cnotmatch '^[0-9a-f]{40}$' -or $Record.runId -cnotmatch '^[1-9][0-9]{0,19}$' -or
      $Record.cases -isnot [Collections.IDictionary]) { return $unverified }
  $policy=@(Get-PhaseAVerdictPolicy)
  if ($Record.cases.Count -ne $policy.Count) { return $unverified }
  foreach ($key in $policy) {
    if (-not $Record.cases.Contains($key)) { return $unverified }
    $entry=$Record.cases[$key]
    if ($entry -isnot [Collections.IDictionary] -or $entry.Count -ne 4) { return $unverified }
    foreach ($field in @('state','evidence','reason','proof')) { if (-not $entry.Contains($field)) { return $unverified } }
    foreach ($field in @('state','evidence','reason','proof')) { if ($entry[$field] -isnot [string]) { return $unverified } }
    if ($entry.state -cnotin @('PASS','FAIL','NOT_RUN') -or $entry.evidence -cnotin @('LIVE_OBSERVED','SIMULATED_PASS','SAME_IDENTITY_PASS','NOT_RUN')) { return $unverified }
    if ($entry.state -ceq 'NOT_RUN') {
      if ($entry.evidence -cne 'NOT_RUN' -or $entry.reason -cne 'NOT_RUN' -or $entry.proof -cne '') { return $unverified }
    } elseif ($entry.proof -cnotmatch '^[0-9a-f]{64}$' -or $entry.evidence -ceq 'NOT_RUN' -or
      ($entry.state -ceq 'PASS' -and $entry.reason -cne 'NONE') -or
      ($entry.state -ceq 'FAIL' -and $entry.reason -cnotin @('VIOLATION','CONTROL_FAILED','SETUP_FAILED','CLEANUP_UNCONFIRMED'))) { return $unverified }
  }
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
