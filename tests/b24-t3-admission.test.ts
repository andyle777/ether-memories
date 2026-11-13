import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as internal from "../src/persistence/productionOperations.js";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { windowsRecoverableDirectoryIO, nodeDirectoryIO } from "../src/persistence/directoryIO.js";
import type { MutationId } from "../src/types/persistence.js";
import { encodeWalFrame } from "../src/persistence/wal.js";
import { encodeEtherData, ETHER_DATA_PROFILE } from "../src/persistence/etherData.js";
import { parseTransactionSequenceId } from "../src/utils/durablePersistence.js";
import { semanticNote } from "./helpers/recovery.js";

const fixture = path.join(import.meta.dirname, "fixtures", "b24-t3-v070");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function inventory(directory: string) {
  const files: {path:string;sha256:string;size:number}[] = [];
  async function walk(relative: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(path.join(directory, relative), {withFileTypes:true}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const entry of entries) {
      const name=path.join(relative,entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) { const bytes=await fs.readFile(path.join(directory,name)); files.push({path:name.replaceAll("\\","/"),size:bytes.length,sha256:sha(bytes)}); }
      else throw new Error("unexpected entry " + name);
    }
  }
  const head=await fs.readFile(path.join(directory,"HEAD")); files.push({path:"HEAD",size:head.length,sha256:sha(head)});
  for (const name of ["checkpoints","wal","receipts","objects"]) await walk(name);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

describe("B24-T3 private admission boundary", () => {
  it("B24-T3-ABS-001: exposes the internal test seam without a package-root API", () => {
    expect((internal as Record<string, unknown>).runPrivateT3Admission).toBeTypeOf("function");
  });
  it.each([false,true])("B24-T3-ABS-001: corrupt=%s, admission proves absence before append", async corrupt => {
    const manifestBytes=await fs.readFile(path.join(fixture,"manifest.json"));
    expect(sha(manifestBytes)).toBe("bec818bb859b1ab41b6ca68dbd5ad532b2aeaa3c6b0f22cc8d5e99de8f0b836c");
    const manifest=JSON.parse(manifestBytes.toString()) as {userId:string;files:{path:string;size:number;sha256:string}[]};
    for (const f of manifest.files) { const bytes=await fs.readFile(path.join(fixture,"store",...f.path.split("/"))); expect({size:bytes.length,sha256:sha(bytes)}).toEqual({size:f.size,sha256:f.sha256}); }
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-admit-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:manifest.userId,directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok,JSON.stringify(opened)).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(), tip=opened.value.tip; expect(snapshot.ok && tip.ok).toBe(true);
      if(!snapshot.ok || !tip.ok) throw Error("state");
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{checkpointId:string}};
      const ledger=path.join(directory,"receipts",`receipts-${head.checkpoint.checkpointId}.bin`);
      const bytes=await fs.readFile(ledger); expect(sha(bytes)).toBe(head.checkpoint.checkpointId);
      const lines=bytes.toString("utf8").split("\n"); expect(lines.length).toBe(4);
      expect(JSON.parse(lines[1]!).mutationId).toBe("b24-fixture-rotated-reclaimed"); expect(JSON.parse(lines[2]!).mutationId).toBe("z-b24-second");
      if(corrupt) { const offset=Buffer.byteLength(lines[0]!+"\n"+lines[1]!+"\n"); const changed=Buffer.from(bytes); changed[offset]=33; await fs.writeFile(ledger,changed); expect(changed.length).toBe(bytes.length); }
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as ((input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>) | undefined;
      expect(candidate).toBeTypeOf("function"); if(!candidate) throw Error("missing private T3 candidate");
      const result=await candidate({directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-t3" as MutationId,command:{kind:"note.put",input:{content:"B24 T3 admission probe",status:"active"}}});
      const after=await inventory(directory);
      console.log("B24T3ABS",JSON.stringify({corrupt,before,after,ok:result.ok}));
      if(corrupt) { expect.soft(result.ok).toBe(false); expect.soft(result.error?.code).toBe("PERSISTENCE_CORRUPTION"); expect.soft(after).toEqual(before); }
      else { expect(result.ok).toBe(true); expect(after).not.toEqual(before); }
    } finally { await opened.value.close(); }
  },120_000);
  it.each([false,true])("B24-T3-RETRY-001: historical intent conflict=%s never appends", async conflict => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-retry-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(), tip=opened.value.tip; if(!snapshot.ok || !tip.ok) throw Error("state");
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;value?:{receipt:{status:string};effects:unknown[]};error?:{code:string}}>;
      const result=await candidate({directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"z-b24-second" as MutationId,
        command:{kind:"note.put",input:{content:conflict ? "different" : "second receipt",status:"active"}}});
      const after=await inventory(directory);
      console.log("B24T3RETRY",JSON.stringify({conflict,result,before,after}));
      if(conflict) { expect(result.ok).toBe(false); expect(result.error?.code).toBe("PERSISTENCE_CORRUPTION"); }
      else { expect(result.ok).toBe(true); expect(result.value?.receipt.status).toBe("already-committed"); expect(result.value?.effects.length).toBeGreaterThan(0); }
      expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-AUTH-001: one lock protects history and a referenced-object commit", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-auth-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(), tip=opened.value.tip; if(!snapshot.ok || !tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const events: {op:string;path:string;lock?:string}[]=[];
      const io={...backend,
        async writeExclusive(p:string,b:Uint8Array) { events.push({op:"write-exclusive",path:p,lock:p.endsWith("writer.lock")?Buffer.from(b).toString("utf8"):undefined}); return backend.writeExclusive(p,b); },
        async readBounded(p:string,n:number) { const b=await backend.readBounded(p,n); if(p.endsWith("writer.lock")) events.push({op:"read-lock",path:p,lock:Buffer.from(b).toString("utf8")}); return b; },
        async activateFile(a:string,b:string) { const lock=await backend.readBounded(path.join(directory,"writer.lock"),1024); events.push({op:"activate",path:b,lock:Buffer.from(lock).toString("utf8")}); return backend.activateFile(a,b); },
        async removeOwnedFile(p:string) { if(p.endsWith("writer.lock")) events.push({op:"release",path:p}); return backend.removeOwnedFile(p); }
      };
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:unknown}>;
      const result=await candidate({directory,io,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-auth" as MutationId,
        command:{kind:"note.put",input:{content:"T".repeat(100000),status:"active"}}});
      console.log("B24T3AUTH",JSON.stringify({ok:result.ok,error:result.error,events}));
      expect(result.ok,JSON.stringify(result)).toBe(true);
      const acquires=events.filter(e=>e.op==="write-exclusive" && e.path.endsWith("writer.lock"));
      const activation=events.filter(e=>e.op==="activate" && e.path.includes("objects"));
      expect(acquires).toHaveLength(1); expect(activation.length).toBeGreaterThan(0);
      expect(activation.every(e=>e.lock===acquires[0]?.lock)).toBe(true);
      expect(events.filter(e=>e.op==="release")).toHaveLength(1);
      expect(events.findIndex(e=>e.op==="release")).toBeGreaterThan(events.findIndex(e=>e.op==="activate"));
      expect(events.filter(e=>e.op==="read-lock").every(e=>e.lock===acquires[0]?.lock)).toBe(true);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-BASE-001 rejects a snapshot that does not match the selected base", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-base-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(), tip=opened.value.tip; if(!snapshot.ok || !tip.ok) throw Error("state");
      snapshot.value.memoryNotes.splice(0,1);
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean}>;
      const result=await candidate({directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-base" as MutationId,
        command:{kind:"note.put",input:{content:"must reject stale snapshot",status:"active"}}});
      const after=await inventory(directory);
      console.log("B24T3BASE",JSON.stringify({result,before,after}));
      expect.soft(result.ok).toBe(false); expect.soft(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-RETRY-002 reconciles an active-WAL retry without another append", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-active-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;value?:{receipt:{status:string;identity:unknown};effects:unknown[]};error?:unknown}>;
      const request={directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-active" as MutationId,command:{kind:"note.put",input:{content:"active retry",status:"active"}}};
      const first=await candidate(request); expect(first.ok,JSON.stringify(first)).toBe(true); if(!first.ok || !first.value) throw Error("first commit");
      const before=await inventory(directory), retry=await candidate(request), after=await inventory(directory);
      console.log("B24T3ACTIVE",JSON.stringify({firstOk:first.ok,firstReceipt:first.value?.receipt,retry,before,after}));
      expect(retry.ok,JSON.stringify(retry)).toBe(true); expect(retry.value?.receipt.status).toBe("already-committed");
      expect(retry.value?.receipt.identity).toEqual(first.value.receipt.identity); expect(retry.value?.effects).toEqual(first.value.effects);
      expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-FAIL-001 refuses missing selected history without appending", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-missing-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{checkpointId:string}};
      await fs.unlink(path.join(directory,"receipts",`receipts-${head.checkpoint.checkpointId}.bin`));
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>;
      const result=await candidate({directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-missing" as MutationId,command:{kind:"note.put",input:{content:"must not write",status:"active"}}});
      const after=await inventory(directory); console.log("B24T3MISSING",JSON.stringify({result,before,after}));
      expect(result.ok).toBe(false); expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-FAIL-002 detects foreign lock and never releases it", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-lock-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      let reads=0,releases=0;
      const io={...backend,async readBounded(p:string,n:number) { if(p.endsWith("writer.lock") && ++reads>=2) return Buffer.from("foreign"); return backend.readBounded(p,n); },
        async removeOwnedFile(p:string) { if(p.endsWith("writer.lock")) releases++; return backend.removeOwnedFile(p); }};
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>;
      const result=await candidate({directory,io,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-foreign" as MutationId,
        command:{kind:"note.put",input:{content:"must not write",status:"active"}}});
      const after=await inventory(directory); console.log("B24T3FOREIGN",JSON.stringify({result,reads,releases,before,after}));
      expect(result.ok).toBe(false); expect(result.error?.code).toBe("RECOVERY_REQUIRED"); expect(releases).toBe(0); expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-AUTH-002 keeps exclusion while an issued barrier is unresolved", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-deferred-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    let finish!:()=>void, started!:()=>void;
    const wait=new Promise<void>(resolve=>{finish=resolve;}), blocked=new Promise<void>(resolve=>{started=resolve;});
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      let held=false,paused=false,releases=0;
      const io={...backend,
        async writeExclusive(p:string,b:Uint8Array) { await backend.writeExclusive(p,b); if(p.endsWith("writer.lock")) held=true; },
        async syncDirectory(p:string) { if(held && !paused && p===directory) {paused=true;started();await wait;} return backend.syncDirectory(p); },
        async removeOwnedFile(p:string) { if(p.endsWith("writer.lock")) releases++; return backend.removeOwnedFile(p); }};
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>;
      const args={directory,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-deferred" as MutationId,
        command:{kind:"note.put",input:{content:"deferred barrier",status:"active"}}};
      const first=candidate({...args,io});
      try {
        const acquired=await Promise.race([blocked.then(()=>true),first.then(()=>false)]);
        expect(acquired).toBe(true);
        expect(releases).toBe(0); expect(await backend.kind(path.join(directory,"writer.lock"))).toBe("file");
        const second=await candidate({...args,io:backend});
        console.log("B24T3DEFER",JSON.stringify({second,releases}));
        expect(second.ok).toBe(false); expect(second.error?.code).toBe("WRITER_BUSY"); expect(releases).toBe(0);
      } finally { finish(); }
      const result=await first; expect(result.ok,JSON.stringify(result)).toBe(true); expect(releases).toBe(1);
    } finally { finish(); await opened.value.close(); }
  },120_000);
  it("B24-T3-RETRY-003 reconciles a lost post-append acknowledgment exactly once", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-lostack-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      let injected=false;
      const io={...backend,async syncDirectory(p:string) {
        if(!injected && p===path.join(directory,"wal") && (await fs.readdir(p)).some(n=>n.startsWith("wal-"))) {injected=true;throw Error("injected post-append barrier failure");}
        return backend.syncDirectory(p);
      }};
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;value?:{receipt:{status:string}};error?:{code:string}}>;
      const request={directory,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-lostack" as MutationId,
        command:{kind:"note.put",input:{content:"lost acknowledgment",status:"active"}}};
      const failed=await candidate({...request,io}); const before=await inventory(directory);
      const retry=await candidate({...request,io:backend}); const after=await inventory(directory);
      console.log("B24T3LOSTACK",JSON.stringify({injected,failed,retry,before,after}));
      expect(injected).toBe(true); expect(failed.ok).toBe(false); expect(failed.error?.code).toBe("RECOVERY_REQUIRED");
      expect(retry.ok,JSON.stringify(retry)).toBe(true); expect(retry.value?.receipt.status).toBe("already-committed"); expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-FAIL-003 rejects a mutation identity duplicated across receipt and active WAL", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-duplicate-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {storeId:string;checkpoint:{digest:string}};
      const next=parseTransactionSequenceId((BigInt(tip.value.txId)+1n).toString()); if(!next.ok) throw Error("next");
      const payload=encodeEtherData(semanticNote("forged duplicate")); if(!payload.ok) throw Error("payload");
      const frame=encodeWalFrame({storeId:head.storeId,format:{format:"ether.wal",version:"1"},expectedBase:tip.value,
        identity:{epochId:tip.value.epochId,txId:next.value},mutation:{mutationId:"z-b24-second" as MutationId,digest:"1".repeat(64)},
        operations:[{type:"ether.note.put",version:"1",payload:{encoding:ETHER_DATA_PROFILE,data:Buffer.from(payload.value).toString("utf8")}}],audit:null},internal.productionRegistry);
      if(!frame.ok) throw Error(JSON.stringify(frame));
      await fs.writeFile(path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`),frame.value.bytes,{flag:"wx"});
      const before=await inventory(directory);
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>;
      const result=await candidate({directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-duplicate" as MutationId,command:{kind:"note.put",input:{content:"must not write",status:"active"}}});
      const after=await inventory(directory); console.log("B24T3DUP",JSON.stringify({result,before,after}));
      expect(result.ok).toBe(false); expect(result.error?.code).toBe("PERSISTENCE_CORRUPTION"); expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
  it("B24-T3-FAIL-004 refuses an incomplete active WAL without another append", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-tail-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(fixture,"store"),directory,{recursive:true,force:false,errorOnExist:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const candidate=(internal as Record<string,unknown>).runPrivateT3Admission as (input:unknown)=>Promise<{ok:boolean;error?:{code:string}}>;
      const request={directory,io:process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO,
        base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-tail" as MutationId,command:{kind:"note.put",input:{content:"tail test",status:"active"}}};
      const first=await candidate(request); expect(first.ok,JSON.stringify(first)).toBe(true);
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`), size=(await fs.stat(wal)).size;
      await fs.truncate(wal,size-1); const before=await inventory(directory);
      const failed=await candidate({...request,mutationId:"a-b24-tail-next" as MutationId}); const after=await inventory(directory);
      console.log("B24T3TAIL",JSON.stringify({failed,before,after}));
      expect(failed.ok).toBe(false); expect(failed.error?.code).toBe("RECOVERY_REQUIRED"); expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  },120_000);
});
