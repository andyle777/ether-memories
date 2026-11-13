import { describe,it,expect } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { bootstrap } from '../tests/helpers/recovery.js';
import { value } from '../tests/helpers/persistence.js';
import { rotateDurableStore } from '../src/persistence/checkpointRotation.js';
import { encodeSnapshotPayload } from '../src/persistence/snapshotPayload.js';
import { decodeEtherData } from '../src/persistence/etherData.js';
import { openDurableEtherMemories } from '../src/core/DurableEtherMemories.js';
import { runPrivateT3Admission } from '../src/persistence/productionOperations.js';
import { nodeDirectoryIO,windowsRecoverableDirectoryIO } from '../src/persistence/directoryIO.js';
import type { MutationId } from '../src/types/persistence.js';

async function inventory(root:string){
  const rows:{path:string,sha256:string,bytes:number}[]=[];
  async function walk(p:string){for(const e of await fs.readdir(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())await walk(q);else if(e.isFile()){const b=await fs.readFile(q);rows.push({path:path.relative(root,q),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}}}
  for(const name of ['HEAD','wal','checkpoints','receipts','objects']){const p=path.join(root,name),s=await fs.stat(p).catch(()=>undefined);if(s?.isDirectory())await walk(p);else if(s?.isFile()){const b=await fs.readFile(p);rows.push({path:name,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}}
  return rows.sort((a,b)=>a.path.localeCompare(b.path));
}

describe('rotation exact tip identity on intact stores',()=>{
  it.each(['exact-checkpoint','conflicting-digest'] as const)('%s',async which=>{
    const s=await bootstrap();expect(await fs.stat(s.walPath).then(()=>true,()=>false)).toBe(false);
    const before=await inventory(s.directory);
    const tip=which==='conflicting-digest'?{...s.tip,digest:'f'.repeat(64)}:s.tip;
    const result=await rotateDurableStore({directory:s.directory,io:s.io,generation:{tip,bytes:value(encodeSnapshotPayload(s.snapshot))}});
    const after=await inventory(s.directory);
    console.log('ROTATION_INTACT',JSON.stringify({which,walBefore:false,expectedTip:tip,selectedTip:s.tip,result,before,after}));
    if(which==='exact-checkpoint')expect(result.ok).toBe(true);
    else {expect.soft(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('RECOVERY_REQUIRED');expect.soft(after).toEqual(before);}
  },120_000);
  it('ordinary rotation retains committed history after a real append',async()=>{
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),'b24-ordinary-')),directory=path.join(parent,'store');
    await fs.cp(path.resolve('tests/fixtures/b24-t3-v070/store'),directory,{recursive:true});
    const r=await openDurableEtherMemories({userId:'b24-fixture-user',directory,openMode:'existing',durabilityGuarantee:'recoverable'});if(!r.ok)throw Error('open');
    const added=await r.value.addMemory({content:'ordinary rotation',status:'active'},'ordinary-rotation-control');expect(added.ok).toBe(true);
    const beforeTip=r.value.tip;if(!beforeTip.ok)throw Error('tip');const rotated=await r.value.rotate();expect(rotated.ok).toBe(true);
    await r.value.close();const re=await openDurableEtherMemories({userId:'b24-fixture-user',directory,openMode:'existing',durabilityGuarantee:'recoverable'});if(!re.ok)throw Error('reopen');
    expect(re.value.tip).toEqual(beforeTip);console.log('ROTATION_ORDINARY',JSON.stringify({tip:beforeTip.value,rotation:rotated,inventory:await inventory(directory)}));await re.value.close();
  },120_000);
});

describe('proposed T3 historical-retry base policy',()=>{
  it.each(['stale-same-epoch','foreign-epoch'] as const)('%s',async which=>{
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),'b24-retrybase-')),directory=path.join(parent,'store');
    await fs.cp(path.resolve('tests/fixtures/b24-t3-v070/store'),directory,{recursive:true});
    const r=await openDurableEtherMemories({userId:'b24-fixture-user',directory,openMode:'existing',durabilityGuarantee:'recoverable'});if(!r.ok)throw Error('open');
    const beforeTip=r.value.tip;if(!beforeTip.ok)throw Error('initial tip');
    const input={content:'captured retry identity',status:'active' as const},mutationId='retry-base-proven';
    const original=await r.value.addMemory(input,mutationId);expect(original.ok).toBe(true);
    const committedTip=r.value.tip;if(!committedTip.ok)throw Error('committed tip');expect(committedTip.value.txId).not.toBe(beforeTip.value.txId);
    expect((await r.value.rotate()).ok).toBe(true);
    const snapshot=r.value.exportData(),selected=r.value.tip;if(!snapshot.ok||!selected.ok)throw Error('selected');
    const head=JSON.parse(await fs.readFile(path.join(directory,'HEAD'),'utf8')) as {checkpoint:{checkpointId:string}};
    const lines=(await fs.readFile(path.join(directory,'receipts',`receipts-${head.checkpoint.checkpointId}.bin`),'utf8')).trimEnd().split('\n');
    const recorded=lines.slice(1).map(line=>JSON.parse(line) as {mutationId:string,txId:string,transactionDigest:string,operations:{type:string,version:string,payload:{encoding:string,data:string}}[]}).find(x=>x.mutationId===mutationId);
    if(!recorded)throw Error('receipt absent');expect(recorded.txId).toBe(committedTip.value.txId);expect(recorded.transactionDigest).toBe(committedTip.value.digest);
    const recordedEffects=recorded.operations.map(op=>{expect(op.payload.encoding).toBe('ether.data-json.v1');return {type:op.type,version:op.version,payload:value(decodeEtherData(Buffer.from(op.payload.data,'utf8')))};});
    const base=which==='stale-same-epoch'?beforeTip.value:{...beforeTip.value,epochId:'epoch-foreign'};
    const before=await inventory(directory);
    const result=await runPrivateT3Admission({directory,io:process.platform==='win32'?windowsRecoverableDirectoryIO:nodeDirectoryIO,base,snapshot:snapshot.value,
      mutationId:mutationId as MutationId,command:{kind:'note.put',input}});
    const after=await inventory(directory);
    console.log('RETRY_BASE_PROVEN',JSON.stringify({which,base,actualPrevious:beforeTip.value,originalTip:committedTip.value,selected:selected.value,original,result,before,after}));
    if(which==='stale-same-epoch'){
      expect(result.ok).toBe(true);if(result.ok){expect(result.value.receipt.status).toBe('already-committed');expect(result.value.receipt.identity).toEqual(committedTip.value);expect(result.value.effects).toEqual(recordedEffects);}
    }else {expect.soft(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('RECOVERY_REQUIRED');}
    expect.soft(after).toEqual(before);await r.value.close();
  },120_000);
});
