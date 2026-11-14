$ErrorActionPreference='Stop'
. "$PSScriptRoot/PhaseA.Stage3.ps1"
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$dir=Join-Path ([IO.Path]::GetTempPath()) ('ether-access-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($dir)|Out-Null
$file=Join-Path $dir 'source.bin';$new=Join-Path $dir 'new.bin';[IO.File]::WriteAllText($file,'synthetic')
try {
 $before=(Get-FileHash -LiteralPath $file).Hash
 $w=Invoke-PhaseAReadPipeProcess $null $sid $file 'protectedFile' '' $true $false 'Overwrite'
 if(-not $w.allowed -or $w.operation -cne 'Overwrite' -or (Get-FileHash -LiteralPath $file).Hash -cne $before){throw 'write-access probe failed or changed file'}
 $c=Invoke-PhaseAReadPipeProcess $null $sid $new 'deniedFile' '' $true $false 'Create'
 if(-not $c.allowed -or $c.operation -cne 'Create' -or -not [IO.File]::Exists($new)){throw 'create-new probe failed'}
 $missing=Invoke-PhaseAReadPipeProcess $null $sid ($file+'.missing') 'protectedFile' '' $true $false 'Overwrite'
 if($missing.allowed -or $missing.error -ne 2){throw 'missing write target misclassified'}
 $exists=Invoke-PhaseAReadPipeProcess $null $sid $new 'deniedFile' '' $true $false 'Create'
 if($exists.allowed -or $exists.error -ne 80){throw 'create-new replaced existing file'}
 [IO.File]::Delete($new)
 $backend=@{Exists={param($p) [IO.File]::Exists($p)};DirectoryExists={param($p) [IO.Directory]::Exists($p)};Probe={param($token,$expected,$operation,$target,$root) $id=if($operation -ceq 'Create'){'deniedFile'}else{'protectedFile'};Invoke-PhaseAReadPipeProcess $null $expected $target $id '' $true $false $operation}}
 $fixture=@{protectedFile=$file;protectedDir=$dir;deniedFile=$new};$token=@{sid=$sid}
 foreach($spec in @(@('Overwrite','protectedFile'),@('Create','deniedFile'))) {
  $result=Invoke-PhaseATrustedAccess $backend $fixture $token $sid $spec[0] $spec[1] 'INJECTED'
  if($result.status -cne 'OBSERVED' -or $result.execution -cne 'PROCESS' -or $result.outcome -cne 'ALLOWED'){throw 'manager access adapter failed'}
 }
 [IO.File]::Delete($new)
 foreach($op in @('Overwrite','Create')) {
  $timedOut=$false;$p=if($op -ceq 'Create'){Join-Path $dir 'stall-new.bin'}else{$file};$id=if($op -ceq 'Create'){'deniedFile'}else{'protectedFile'}
  try{$null=Invoke-PhaseAReadPipeProcess $null $sid $p $id '' $true $true $op}catch{$timedOut=$_.Exception.GetBaseException().Message -ceq 'WITNESS_TIMEOUT'}
  if(-not $timedOut -or ($op -ceq 'Create' -and [IO.File]::Exists($p))){throw "timeout or cleanup failed: $op"}
 }
 Write-Output 'PASS bounded write-access and create-new, native errors and two actual stalled terminations'
} finally {if([IO.File]::Exists($new)){[IO.File]::Delete($new)};if([IO.File]::Exists($file)){[IO.File]::Delete($file)};[IO.Directory]::Delete($dir,$false)}
