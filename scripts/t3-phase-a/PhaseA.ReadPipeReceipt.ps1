function Test-PhaseAReadPipeReceipt($Parts,[string]$Nonce,[int]$ExpectedPid,[uint32]$ClientPid,[string]$Sid,[string]$CreatedAt,[string]$Target,[bool]$CompletedBeforeDeadline,[string]$Operation='Read') {
 try {
  if(-not $CompletedBeforeDeadline -or $Parts -isnot [array] -or $Parts.Count -ne 8 -or $ExpectedPid -le 0 -or $ClientPid -ne $ExpectedPid -or $Parts[0] -cne $Nonce -or $Nonce -cnotmatch '^[0-9a-f]{32}$' -or [int]$Parts[1] -ne $ExpectedPid -or $Parts[3] -cne $Sid -or $Parts[4] -cne $Operation -or $Parts[5] -cne $Target -or (($Operation -cin @('Read','Overwrite') -and $Target -cnotin @('protectedFile','controlFile')) -or ($Operation -ceq 'Create' -and $Target -cnotin @('deniedFile','authorizedProbeFile','controlProbeFile')) -or $Operation -cnotin @('Read','Overwrite','Create'))) {return $false}
  if([DateTimeOffset]::Parse($Parts[2]) -ne [DateTimeOffset]::Parse($CreatedAt)){return $false}
  if(($Parts[6] -ceq 'ALLOWED' -and $Parts[7] -ceq '0') -or ($Parts[6] -ceq 'ERROR' -and $Parts[7] -cmatch '^[1-9][0-9]{0,4}$' -and [int]$Parts[7] -le 65535)){return $true}
  return $false
 } catch {return $false}
}
