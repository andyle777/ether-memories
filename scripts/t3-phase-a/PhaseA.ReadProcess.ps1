Set-StrictMode -Version Latest
. "$PSScriptRoot/PhaseA.ReadPipeNative.ps1"
. "$PSScriptRoot/PhaseA.ReadPipeReceipt.ps1"
function Confirm-PhaseAReadChildTermination($Child) {
 try { if(-not $Child.Wait(5000)){$Child.Terminate();if(-not $Child.Wait(5000)){throw 'unconfirmed'}} }
 catch {throw 'STAGE2_CHILD_UNCONFIRMED'}
}
function Invoke-PhaseAReadPipeProcess($Token,[string]$ExpectedSid,[string]$Target,[string]$TargetId,[string]$FixtureRoot,[bool]$TestCurrentIdentity=$false,[bool]$TestStall=$false,[string]$Operation='Read') {
 if($TestStall -and -not $TestCurrentIdentity){throw 'WITNESS_ARGUMENT_REJECTED'}
 $source=Join-Path $PSScriptRoot 'PhaseA.ReadPipeWitness.cs'
 $pin='c3adbdddada140db59b8a8283ec21ecbc60226ff50e6bf8520e9c30f03eded41'
 $sourceText=[IO.File]::ReadAllText($source).Replace("`r`n","`n")
 $sourceSha=[Security.Cryptography.SHA256]::Create();try{$sourceHash=[BitConverter]::ToString($sourceSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceText))).Replace('-','').ToLowerInvariant()}finally{$sourceSha.Dispose()}
 if($sourceHash -cne $pin){throw 'WITNESS_SOURCE_MISMATCH'}
 if((($Operation -cin @('Read','Overwrite') -and $TargetId -cnotin @('protectedFile','controlFile')) -or ($Operation -ceq 'Create' -and $TargetId -cnotin @('deniedFile','authorizedProbeFile','controlProbeFile')) -or $Operation -cnotin @('Read','Overwrite','Create')) -or [string]::IsNullOrWhiteSpace($ExpectedSid)){throw 'WITNESS_ARGUMENT_REJECTED'}
 if(-not $TestCurrentIdentity) {
  $root=[IO.Path]::GetFullPath($FixtureRoot);$dir=if($TargetId -cin @('controlFile','controlProbeFile')){'control'}else{'protected'};$filename=switch($TargetId){'protectedFile' {'original.bin'} 'controlFile' {'original.bin'} 'deniedFile' {'rejected.bin'} 'authorizedProbeFile' {'witness-authorized.bin'} 'controlProbeFile' {'witness-permissive.bin'}}
  if(-not [IO.Path]::GetFileName($root).StartsWith('ether-phase-a-store-') -or [IO.Path]::GetFullPath($Target) -cne [IO.Path]::Combine($root,$dir,$filename)){throw 'WITNESS_ARGUMENT_REJECTED'}
  if($Token.sid -cne $ExpectedSid -or $Token.handle.IsClosed -or $Token.handle.IsInvalid){throw 'WITNESS_IDENTITY_REJECTED'}
 }
 $common=if($TestCurrentIdentity){[IO.Path]::GetTempPath()}else{[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)}
 $parent=[IO.Path]::GetFullPath($common).TrimEnd('\');$scratch=Join-Path $parent ('ether-phase-a-read-'+[Guid]::NewGuid().ToString('N'))
 $exe=Join-Path $scratch 'witness.exe';$pipe=$null;$pending=$null;$read=$null;$pendingWait=$null;$readWait=$null;$job=[IntPtr]::Zero;$child=$null;$process=$null;$held=$null;$unconfirmed=$false;$cleanupFailed=$false;$created=$false
 try {
  [IO.Directory]::CreateDirectory($scratch)|Out-Null;$created=$true
  if(((Get-Item -LiteralPath $scratch -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'WITNESS_SETUP_FAILED'}
  if(-not $TestCurrentIdentity){$manager=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$null=Set-PhaseAFixtureAcl $scratch @($manager,'S-1-5-18') @($ExpectedSid)}
  Add-Type -TypeDefinition $sourceText -OutputAssembly $exe -OutputType ConsoleApplication -ErrorAction Stop
  $hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;$held=[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -cne $hash){throw 'WITNESS_BINARY_MISMATCH'}
  $id=[Guid]::NewGuid().ToString('N');$nonce=[Guid]::NewGuid().ToString('N');$name='ether-phase-a-read-'+$id
  $acl=New-Object IO.Pipes.PipeSecurity;$acl.SetAccessRuleProtection($true,$false);$network=New-Object Security.Principal.SecurityIdentifier('S-1-5-2');$deny=New-Object IO.Pipes.PipeAccessRule($network,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Deny);$acl.AddAccessRule($deny);$managerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $managerRule=New-Object IO.Pipes.PipeAccessRule($managerSid,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($managerRule)
  if($ExpectedSid -cne $managerSid.Value){$sid=New-Object Security.Principal.SecurityIdentifier($ExpectedSid);$rule=New-Object IO.Pipes.PipeAccessRule($sid,[IO.Pipes.PipeAccessRights]::Write,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule)}
  $pipe=New-Object IO.Pipes.NamedPipeServerStream($name,[IO.Pipes.PipeDirection]::In,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$acl)
  $pending=$pipe.BeginWaitForConnection($null,$null);$pendingWait=$pending.AsyncWaitHandle
  if($exe.Contains('"') -or $Target.Contains('"')){throw 'WITNESS_ARGUMENT_REJECTED'}
  $mode=switch($Operation){'Read'{'read'} 'Overwrite'{'write'} 'Create'{'create'}};if($TestStall){$mode='stall-'+$mode}; $cmd='"'+$exe+'" '+$mode+' "'+$Target+'" '+$name+' '+$nonce+' '+$TargetId
  $job=[EtherPhaseAJob]::Create()
  if($TestCurrentIdentity){$child=[EtherPhaseAAtomic]::CreateSelfInDirectory($job,$exe,$cmd,$scratch)}else{$child=[EtherPhaseAAtomic]::CreateWithTokenInDirectory($Token.handle.DangerousGetHandle(),$job,$exe,$cmd,$scratch)}
  if(-not $child.InJob() -or $child.Exited()){throw 'WITNESS_CONTAINMENT_FAILED'}
  $process=Get-Process -Id $child.Pid -ErrorAction Stop;$observed=Get-PhaseAProcessToken $process
  if($observed.pid -ne $child.Pid -or $observed.sid -cne $ExpectedSid -or [string]::IsNullOrWhiteSpace($observed.createdAt)){throw 'WITNESS_IDENTITY_REJECTED'}
  $clock=[Diagnostics.Stopwatch]::StartNew();$child.Resume()
  if(-not $pendingWait.WaitOne(8000)){throw 'WITNESS_TIMEOUT'}
  $pipe.EndWaitForConnection($pending);$clientPid=[PhaseAReadPipeNative]::ClientPid($pipe.SafePipeHandle)
  if($clientPid -ne $child.Pid){throw 'WITNESS_CLIENT_REJECTED'}
  $buffer=New-Object byte[] 4096;$read=$pipe.BeginRead($buffer,0,$buffer.Length,$null,$null);$readWait=$read.AsyncWaitHandle
  $remaining=[Math]::Max(0,10000-[int]$clock.ElapsedMilliseconds)
  if(-not $readWait.WaitOne($remaining)){throw 'WITNESS_TIMEOUT'}
  $count=$pipe.EndRead($read);$parts=[Text.Encoding]::UTF8.GetString($buffer,0,$count).Split('|')
  $remaining=[Math]::Max(0,10000-[int]$clock.ElapsedMilliseconds)
  if(-not $child.Wait([uint32]$remaining)){throw 'WITNESS_TIMEOUT'}
  if($child.ExitCode() -ne 0 -or -not (Test-PhaseAReadPipeReceipt $parts $nonce $child.Pid $clientPid $ExpectedSid $observed.createdAt $TargetId ($clock.ElapsedMilliseconds -le 10000) $Operation)){throw 'WITNESS_RECEIPT_REJECTED'}
  if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -cne $hash){throw 'WITNESS_BINARY_MISMATCH'}
  return @{execution='PROCESS';sid=$observed.sid;operation=$Operation;attempted=$true;allowed=($parts[6] -ceq 'ALLOWED');error=[int]$parts[7];processVerified=$true;terminated=$true;handlesClosed=$true;pid=$child.Pid;createdAt=$observed.createdAt;pipeClientPid=[int]$clientPid;nonce=$nonce}
 } finally {
  if($pipe){try{$pipe.Dispose()}catch{$cleanupFailed=$true}}
  foreach($waitHandle in @($pendingWait,$readWait)){if($waitHandle){try{if($waitHandle.WaitOne(5000)){$waitHandle.Dispose()}else{$cleanupFailed=$true;$script:PhaseAUnconfirmedPipeResources=@{connection=$pending;read=$read}}}catch [ObjectDisposedException] {} catch {$cleanupFailed=$true}}}
  if($job -ne [IntPtr]::Zero){try{[EtherPhaseAJob]::Close($job)}catch{$cleanupFailed=$true}}
  if($child){try{Confirm-PhaseAReadChildTermination $child}catch{$unconfirmed=$true};if(-not $unconfirmed){try{$child.Dispose()}catch{$cleanupFailed=$true}}}
  if($process){try{$process.Dispose()}catch{$cleanupFailed=$true}}
  if($unconfirmed){$script:PhaseAUnconfirmedWitnessResources=@{child=$child;binaryHandle=$held;scratch=$scratch}}
  if($held -and -not $unconfirmed){try{$held.Dispose()}catch{$cleanupFailed=$true}}
  if(-not $unconfirmed -and $created){try{if(-not [IO.Path]::GetFullPath($scratch).StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($scratch).StartsWith('ether-phase-a-read-')){throw 'path rejected'};if([IO.File]::Exists($exe)){[IO.File]::Delete($exe)};[IO.Directory]::Delete($scratch,$false)}catch{$cleanupFailed=$true}}
  if($unconfirmed){throw 'STAGE2_CHILD_UNCONFIRMED'}
  if($cleanupFailed){throw 'WITNESS_CLEANUP_FAILED'}
 }
}
