import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { runPrivateT3Admission } from "../src/persistence/productionOperations.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { simulatedDirectoryIO } from "../tests/helpers/wal.js";
import type { MutationId } from "../src/types/persistence.js";

describe("B24-T3 historical retry strict acknowledgment", () => {
  it.each([{fail:true,large:false},{fail:false,large:true}])("strict barrier result: fail=$fail, referenced=$large", async ({fail,large}) => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-hist-sync-")),directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true);if(!opened.ok)throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip;if(!snapshot.ok||!tip.ok)throw Error("state");
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{checkpointId:string}};
      const ledger=path.join(directory,"receipts",`receipts-${head.checkpoint.checkpointId}.bin`),open=nodeWalIO.open.bind(nodeWalIO);
      let attempted=false; const events:string[]=[];
      const spy=vi.spyOn(nodeWalIO,"open").mockImplementation(async(p,create)=>{
        const file=await open(p,create);
        return {...file,async sync(){events.push(`file:${p}`);if(p===ledger){attempted=true;if(fail)throw Error("injected receipt sync failure");}await file.sync();}};
      });
      try {
        const backend=simulatedDirectoryIO();
        const io={...backend,async syncDirectory(p:string){events.push(`directory:${p}`);await backend.syncDirectory(p);}};
        const result=await runPrivateT3Admission({directory,io,base:tip.value,snapshot:snapshot.value,
          mutationId:(large?"b24-fixture-rotated-reclaimed":"z-b24-second") as MutationId,
          command:{kind:"note.put",input:large?{content:"b24-large-"+"x".repeat(400000),tags:["b24fixture"],status:"active"}:{content:"second receipt",status:"active"}}});
        console.log("B24T3HISTSTRICT",JSON.stringify({ok:result.ok,error:result.ok?undefined:result.error,attempted,events}));
        expect(attempted).toBe(true);
        if(fail) expect(result.ok).toBe(false);
        else {
          expect(result.ok,JSON.stringify(result.ok?undefined:result.error)).toBe(true);
          if(result.ok)expect(result.value.receipt).toMatchObject({status:"already-committed",durability:"confirmed"});
          expect(events.some(e=>e.startsWith(`file:${path.join(directory,"objects")}`))).toBe(true);
          const ledgerSync=events.indexOf(`file:${ledger}`);
          expect(events.indexOf(`directory:${path.join(directory,"receipts")}`)).toBeGreaterThan(ledgerSync);
          expect(events.indexOf(`directory:${path.join(directory,"objects")}`)).toBeGreaterThan(ledgerSync);
        }
      } finally {spy.mockRestore();}
    } finally {await opened.value.close();}
  },120_000);
});
