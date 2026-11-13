import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { runPrivateT3Admission } from "../src/persistence/productionOperations.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";
import type { MutationId } from "../src/types/persistence.js";

describe("B24-T3 outstanding write authority", () => {
  it("retains exclusion while an issued WAL write has not settled to the coordinator", async () => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-write-")), directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    let finish!:()=>void, markIssued!:()=>void;
    const gate=new Promise<void>(resolve=>{finish=resolve;}), issued=new Promise<void>(resolve=>{markIssued=resolve;});
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`), open=nodeWalIO.open.bind(nodeWalIO);
      let releases=0;
      const io={...backend,async removeOwnedFile(p:string){if(p.endsWith("writer.lock")) releases++;return backend.removeOwnedFile(p);}};
      const spy=vi.spyOn(nodeWalIO,"open").mockImplementation(async(p,create)=>{
        const file=await open(p,create); if(p!==wal || !create) return file;
        return {...file,async write(bytes,offset){const pending=file.write(bytes,offset); pending.catch(()=>undefined); markIssued(); await gate; return pending;}};
      });
      try {
        const request={directory,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-pending-write" as MutationId,
          command:{kind:"note.put" as const,input:{content:"pending write",status:"active" as const}}};
        const first=runPrivateT3Admission({...request,io});
        try {
          expect(await Promise.race([issued.then(()=>true),first.then(()=>false)])).toBe(true);
          expect(await backend.kind(path.join(directory,"writer.lock"))).toBe("file"); expect(releases).toBe(0);
          const second=await runPrivateT3Admission({...request,io:backend});
          console.log("B24T3PENDING",JSON.stringify({second,releases}));
          expect(second.ok).toBe(false); if(!second.ok) expect(second.error.code).toBe("WRITER_BUSY"); expect(releases).toBe(0);
        } finally {finish();}
        const result=await first; expect(result.ok,JSON.stringify(result)).toBe(true); expect(releases).toBe(1);
      } finally {spy.mockRestore();}
    } finally {finish();await opened.value.close();}
  },120_000);
});
