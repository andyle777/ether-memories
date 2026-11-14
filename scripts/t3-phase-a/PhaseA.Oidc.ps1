Set-StrictMode -Version Latest
function ConvertFrom-PhaseABase64Url([string]$Value) {
  if ([string]::IsNullOrEmpty($Value) -or $Value -cnotmatch '^[A-Za-z0-9_-]+$' -or ($Value.Length % 4) -eq 1) { throw 'invalid encoding' }
  $padded=$Value.Replace('-','+').Replace('_','/')
  switch ($padded.Length % 4) { 2 { $padded+='==' } 3 { $padded+='=' } }
  return ,([Convert]::FromBase64String($padded))
}
function Test-PhaseAOidcToken($Token,$Keys,$Expected,[long]$Now) {
  try {
    if ($Token -isnot [string] -or $Token.Length -gt 16384 -or $Expected -isnot [hashtable] -or $null -eq $Keys) { return $false }
    $parts=$Token.Split('.'); if ($parts.Count -ne 3) { return $false }
    $utf8=New-Object Text.UTF8Encoding($false,$true)
    $header=$utf8.GetString((ConvertFrom-PhaseABase64Url $parts[0])) | ConvertFrom-Json -ErrorAction Stop
    $claims=$utf8.GetString((ConvertFrom-PhaseABase64Url $parts[1])) | ConvertFrom-Json -ErrorAction Stop
    if ($header.alg -cne 'RS256' -or $header.kid -isnot [string] -or [string]::IsNullOrWhiteSpace($header.kid) -or $header.kid.Length -gt 128) { return $false }
    $matches=@($Keys | Where-Object { $_.kid -ceq $header.kid -and $_.kty -ceq 'RSA' -and $_.alg -ceq 'RS256' -and $_.use -ceq 'sig' })
    if ($matches.Count -ne 1) { return $false }
    $params=New-Object Security.Cryptography.RSAParameters
    $params.Modulus=ConvertFrom-PhaseABase64Url $matches[0].n; $params.Exponent=ConvertFrom-PhaseABase64Url $matches[0].e
    if ($params.Modulus.Length -lt 256 -or $params.Modulus.Length -gt 512 -or $params.Exponent.Length -lt 1 -or $params.Exponent.Length -gt 8) { return $false }
    $rsa=New-Object Security.Cryptography.RSACryptoServiceProvider
    try {
      $rsa.ImportParameters($params)
      $data=[Text.Encoding]::ASCII.GetBytes($parts[0]+'.'+$parts[1]); $signature=ConvertFrom-PhaseABase64Url $parts[2]
      if (-not $rsa.VerifyData($data,[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'),$signature)) { return $false }
    } finally { $rsa.Dispose() }
    $expectedKeys=@('audience','repository','repositoryId','workflowRef','ref','event','runner','sha','runId','runAttempt')
    if ($Expected.Count -ne $expectedKeys.Count) { return $false }
    foreach ($key in $expectedKeys) { if (-not $Expected.ContainsKey($key) -or $Expected[$key] -isnot [string] -or [string]::IsNullOrWhiteSpace($Expected[$key])) { return $false } }
    $map=@{aud='audience';repository='repository';repository_id='repositoryId';workflow_ref='workflowRef';ref='ref';event_name='event';runner_environment='runner';sha='sha';workflow_sha='sha';run_id='runId';run_attempt='runAttempt'}
    if ($claims.iss -cne 'https://token.actions.githubusercontent.com') { return $false }
    foreach ($claim in $map.Keys) { $v=$claims.PSObject.Properties[$claim]; if ($null -eq $v -or $v.Value -isnot [string] -or $v.Value -cne $Expected[$map[$claim]]) { return $false } }
    if ($claims.jti -isnot [string] -or [string]::IsNullOrWhiteSpace($claims.jti) -or $claims.jti.Length -gt 128) { return $false }
    $iat=0L; $nbf=0L; $exp=0L
    if (-not [long]::TryParse([string]$claims.iat,[ref]$iat) -or -not [long]::TryParse([string]$claims.nbf,[ref]$nbf) -or -not [long]::TryParse([string]$claims.exp,[ref]$exp)) { return $false }
    if ($iat -gt ($Now+30) -or $nbf -gt ($Now+30) -or $exp -le $Now -or $exp -le $iat -or $nbf -gt $exp -or ($exp-$iat) -gt 900) { return $false }
    return $true
  } catch { return $false }
}
function Get-PhaseAEvidenceAudience($Record,[string]$RunAttempt) {
  if (-not (Test-PhaseAVerdictInputShape $Record) -or $RunAttempt -cnotmatch '^[1-9][0-9]{0,9}$') { return $null }
  $builder=New-Object Text.StringBuilder
  $null=$builder.Append($Record.schema).Append("`n").Append($Record.policy).Append("`n").Append($Record.commit).Append("`n").Append($Record.runId).Append("`n").Append($RunAttempt).Append("`n")
  foreach ($key in @(Get-PhaseAVerdictPolicy)) {
    $entry=$Record.cases[$key]
    $null=$builder.Append($key).Append('|').Append($entry.state).Append('|').Append($entry.evidence).Append('|').Append($entry.reason).Append('|').Append($entry.proof).Append("`n")
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $digest=$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString())); return 'urn:ether:phase-a:'+([BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() }
}
function Test-PhaseAOidcEvidenceBinding($Record,[string]$RunAttempt,[string]$ExpectedAudience) {
  $recomputed=Get-PhaseAEvidenceAudience $Record $RunAttempt
  return (-not [string]::IsNullOrEmpty($recomputed) -and $recomputed -ceq $ExpectedAudience)
}
function Test-PhaseAGitHubOidcProvenance($Record,[string]$RunAttempt) {
  $handler=$null; $client=$null; $request=$null; $response=$null; $jwksResponse=$null; $token=$null; $secret=$null
  try {
    $audience=Get-PhaseAEvidenceAudience $Record $RunAttempt
    if ([string]::IsNullOrEmpty($audience)) { return $false }
    $rawUrl=[Environment]::GetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_URL','Process')
    $secret=[Environment]::GetEnvironmentVariable('ACTIONS_ID_TOKEN_REQUEST_TOKEN','Process')
    if ([string]::IsNullOrWhiteSpace($rawUrl) -or $rawUrl.Length -gt 8192 -or [string]::IsNullOrWhiteSpace($secret) -or $secret.Length -gt 8192) { return $false }
    $uri=[Uri]$rawUrl
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or $uri.Host -cnotmatch '^pipelines[a-z0-9-]*\.actions\.githubusercontent\.com$' -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.Query -match '(?i)(?:[?&])audience=') { return $false }
    $builder=New-Object UriBuilder($uri)
    $query=$builder.Query.TrimStart('?'); if ($query.Length -gt 0) { $query+='&' }; $builder.Query=$query+'audience='+[Uri]::EscapeDataString($audience)
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    $handler=New-Object Net.Http.HttpClientHandler; $handler.AllowAutoRedirect=$false; $handler.UseProxy=$false
    $client=New-Object Net.Http.HttpClient($handler); $client.Timeout=[TimeSpan]::FromSeconds(10)
    $request=New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get,$builder.Uri)
    $request.Headers.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$secret)
    $response=$client.SendAsync($request).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode -or ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt 65536)) { return $false }
    $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult(); if ($body.Length -gt 65536) { return $false }
    $payload=$body | ConvertFrom-Json -ErrorAction Stop; $token=$payload.value
    if ($token -isnot [string] -or $token.Length -gt 16384) { return $false }
    $jwksResponse=$client.GetAsync('https://token.actions.githubusercontent.com/.well-known/jwks').GetAwaiter().GetResult()
    if (-not $jwksResponse.IsSuccessStatusCode -or ($jwksResponse.Content.Headers.ContentLength -and $jwksResponse.Content.Headers.ContentLength -gt 262144)) { return $false }
    $keyBody=$jwksResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult(); if ($keyBody.Length -gt 262144) { return $false }
    $jwks=$keyBody | ConvertFrom-Json -ErrorAction Stop; $keys=@($jwks.keys)
    if ($keys.Count -lt 1 -or $keys.Count -gt 100) { return $false }
    $expected=@{audience=$audience;repository='andyle777/Ether-Memories';repositoryId='1345912571';workflowRef='andyle777/Ether-Memories/.github/workflows/t3-windows-phase-a.yml@refs/heads/test/t3-windows-enforcement-run';ref='refs/heads/test/t3-windows-enforcement-run';event='push';runner='github-hosted';sha=$Record.commit;runId=$Record.runId;runAttempt=$RunAttempt}
    if (-not (Test-PhaseAOidcToken $token $keys $expected ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()))) { return $false }
    return (Test-PhaseAOidcEvidenceBinding $Record $RunAttempt $audience)
  } catch { return $false }
  finally {
    $token=$null; $secret=$null; $body=$null; $payload=$null
    if ($jwksResponse) { $jwksResponse.Dispose() }; if ($response) { $response.Dispose() }; if ($request) { $request.Dispose() }; if ($client) { $client.Dispose() }; if ($handler) { $handler.Dispose() }
  }
}
