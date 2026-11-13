import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { runPrivateT3Admission } from "../src/persistence/productionOperations.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";
import type { MutationId } from "../src/types/persistence.js";

describe("B24-T3 active retry source disappearance", () => {
  it("fails closed if the observed active WAL vanishes before retry synchronization", async () => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-vanish-")),directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok) throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip;if(!snapshot.ok||!tip.ok)throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const request={directory,io:backend,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-vanish" as MutationId,
        command:{kind:"note.put" as const,input:{content:"must not recreate",status:"active" as const}}};
      const first=await runPrivateT3Admission(request);expect(first.ok).toBe(true);
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`);let reads=0,removed=false;
      const io={...backend,async kind(p:string){if(p===wal && ++reads===2){await fs.unlink(wal);removed=true;} return backend.kind(p);}};
      const retry=await runPrivateT3Admission({...request,io}); const after=await backend.kind(wal);
      console.log("B24T3VANISH",JSON.stringify({removed,reads,retry,after}));
      expect(removed).toBe(true);expect(retry.ok).toBe(false);expect(after).toBe("missing");
    } finally {await opened.value.close();}
  },120_000);
});
