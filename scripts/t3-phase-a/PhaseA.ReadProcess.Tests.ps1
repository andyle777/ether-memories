$ErrorActionPreference='Stop'
. "$PSScriptRoot/PhaseA.Stage3.ps1"
. "$PSScriptRoot/PhaseA.ReadProcess.ps1"
$path=Join-Path ([IO.Path]::GetTempPath()) ('ether-read-process-test-'+[Guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($path,'synthetic')
try {
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $read=Invoke-PhaseAReadPipeProcess $null $sid $path 'protectedFile' '' $true
 if(-not $read.allowed -or $read.error -ne 0 -or -not $read.processVerified -or -not $read.terminated){throw 'current identity read failed'}
 Write-Output "PASS actual read process pid=$($read.pid) pipePid=$($read.pipeClientPid) created=$($read.createdAt)"
 $backend=@{Exists={param($p) [IO.File]::Exists($p)};DirectoryExists={param($p) [IO.Directory]::Exists($p)};Probe={param($token,$expected,$operation,$target,$root) Invoke-PhaseAReadPipeProcess $null $expected $target 'protectedFile' '' $true}}
 $fixture=@{protectedFile=$path;protectedDir=[IO.Path]::GetDirectoryName($path)};$token=@{sid=$sid}
 $mapped=Invoke-PhaseATrustedAccess $backend $fixture $token $sid 'Read' 'protectedFile' 'INJECTED'
 if($mapped.status -cne 'OBSERVED' -or $mapped.execution -cne 'PROCESS' -or $mapped.outcome -cne 'ALLOWED'){throw 'manager adapter did not use process evidence'}
 $badIdentity=$false;try{$null=Invoke-PhaseAReadPipeProcess $null 'S-1-5-21-999' $path 'protectedFile' '' $true}catch{$badIdentity=$_.Exception.GetBaseException().Message -ceq 'WITNESS_IDENTITY_REJECTED'}
 if(-not $badIdentity){throw 'wrong identity accepted'}
 $missing=Invoke-PhaseAReadPipeProcess $null $sid ($path+'.missing') 'protectedFile' '' $true
 if($missing.allowed -or $missing.error -ne 2){throw 'missing file not classified'}
 $caught=$false;try{$null=Invoke-PhaseAReadPipeProcess $null $sid $path 'protectedFile' '' $true $true}catch{$caught=$_.Exception.GetBaseException().Message -ceq 'WITNESS_TIMEOUT'}
 if(-not $caught){throw 'bounded stall was not rejected'}
 Write-Output 'PASS process manager adapter, read, missing, wrong SID and stalled termination'
} finally {if([IO.File]::Exists($path)){[IO.File]::Delete($path)}}
$never=New-Object PSObject
$never | Add-Member ScriptMethod Wait {param($ms) return $false}
$never | Add-Member ScriptMethod Terminate {return}
$unconfirmed=$false;try{Confirm-PhaseAReadChildTermination $never}catch{$unconfirmed=$_.Exception.GetBaseException().Message -ceq 'STAGE2_CHILD_UNCONFIRMED'}
if(-not $unconfirmed){throw 'surviving witness child accepted'}
Write-Output 'PASS injected surviving helper rejects cleanup'
