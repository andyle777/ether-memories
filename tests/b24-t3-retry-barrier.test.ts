import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { runPrivateT3Admission } from "../src/persistence/productionOperations.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";
import type { MutationId } from "../src/types/persistence.js";

describe("B24-T3 active retry acknowledgment", () => {
  it("re-synchronizes the actual WAL file before acknowledging an exact retry", async () => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-ack-")), directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip; if(!snapshot.ok||!tip.ok) throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const request={directory,io:backend,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-retry-barrier" as MutationId,
        command:{kind:"note.put" as const,input:{content:"retry barrier",status:"active" as const}}};
      const first=await runPrivateT3Admission(request); expect(first.ok).toBe(true);
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`);
      const digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex"),before=digest(await fs.readFile(wal));
      const events:string[]=[], open=nodeWalIO.open.bind(nodeWalIO);
      const spy=vi.spyOn(nodeWalIO,"open").mockImplementation(async(p,create)=>{
        const file=await open(p,create); if(p!==wal) return file;
        return {...file,async sync(){events.push("wal-file-sync");await file.sync();}};
      });
      try {
        const io={...backend,async syncDirectory(p:string){if(p===path.join(directory,"wal")) events.push("wal-directory-sync");return backend.syncDirectory(p);}};
        const retry=await runPrivateT3Admission({...request,io}); const after=digest(await fs.readFile(wal));
        console.log("B24T3ACK",JSON.stringify({retry,events,before,after}));
        expect(retry.ok).toBe(true); expect(before).toBe(after);
        const fileIndex=events.lastIndexOf("wal-file-sync");
        expect(fileIndex).toBeGreaterThanOrEqual(0);
        expect(events.findIndex((event,i)=>i>fileIndex && event==="wal-directory-sync")).toBeGreaterThan(fileIndex);
      } finally {spy.mockRestore();}
    } finally {await opened.value.close();}
  },120_000);
});
