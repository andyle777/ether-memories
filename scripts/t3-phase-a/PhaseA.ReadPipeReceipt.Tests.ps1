$ErrorActionPreference='Stop'
. "$PSScriptRoot/PhaseA.ReadPipeReceipt.ps1"
$n='a'*32;$t='2026-01-01T00:00:00Z';$record=@($n,'123',$t,'S-1-5-21-2','Read','protectedFile','ERROR','5')
if(-not (Test-PhaseAReadPipeReceipt $record $n 123 123 'S-1-5-21-2' $t 'protectedFile' $true)){throw 'positive receipt failed'}
foreach($case in @('clientPid','processPid','sid','nonce','time','operation','target','result','late','missing')) {
 $r=$record.Clone();$cp=123;$completed=$true
 switch($case){'clientPid'{$cp=124};'processPid'{$r[1]='124'};'sid'{$r[3]='S-1-5-21-3'};'nonce'{$r[0]='b'*32};'time'{$r[2]='2025-01-01T00:00:00Z'};'operation'{$r[4]='Create'};'target'{$r[5]='controlFile'};'result'{$r[7]='0'};'late'{$completed=$false};'missing'{$r=@()}}
 if(Test-PhaseAReadPipeReceipt $r $n 123 $cp 'S-1-5-21-2' $t 'protectedFile' $completed){throw "accepted $case"}
}
Write-Output 'PASS pipe receipt positive and ten injected rejection controls'
foreach($spec in @(@('Overwrite','protectedFile'),@('Create','deniedFile'))) {
 $r=@($n,'123',$t,'S-1-5-21-2',$spec[0],$spec[1],'ERROR','5')
 if(-not (Test-PhaseAReadPipeReceipt $r $n 123 123 'S-1-5-21-2' $t $spec[1] $true $spec[0])){throw 'valid access receipt rejected'}
 foreach($field in @('operation','target','nonce','client','late')) {
  $bad=$r.Clone();$pidClient=123;$deadline=$true
  switch($field){'operation' {$bad[4]='Read'} 'target' {$bad[5]='controlFile'} 'nonce' {$bad[0]='b'*32} 'client' {$pidClient=124} 'late' {$deadline=$false}}
  if(Test-PhaseAReadPipeReceipt $bad $n 123 $pidClient 'S-1-5-21-2' $t $spec[1] $deadline $spec[0]){throw "invalid $field receipt accepted"}
 }
}
Write-Output 'PASS write/create receipt positive and 10 rejection controls'
