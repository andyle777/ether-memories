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

describe("B24-T3 object and WAL failure boundaries", () => {
  it.each(["object", "partial-wal"] as const)("fails closed after injected %s failure", async fault => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-walfault-")),directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok)throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip;if(!snapshot.ok||!tip.ok)throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const headBytes=await fs.readFile(path.join(directory,"HEAD")),headHash=createHash("sha256").update(headBytes).digest("hex");
      const head=JSON.parse(headBytes.toString()) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`), open=nodeWalIO.open.bind(nodeWalIO);
      let injected=false;
      const spy=vi.spyOn(nodeWalIO,"open").mockImplementation(async(p,create)=>{
        const file=await open(p,create);if(fault!=="partial-wal" || p!==wal || !create)return file;
        return {...file,async write(bytes,offset){injected=true;await file.write(bytes.subarray(0,16),offset);throw Error("injected partial append");}};
      });
      try {
        const io={...backend,async activateFile(a:string,b:string){if(fault==="object" && b.includes(`${path.sep}objects${path.sep}`)){injected=true;throw Error("injected object activation failure");}return backend.activateFile(a,b);}};
        const request={directory,io,base:tip.value,snapshot:snapshot.value,mutationId:`a-b24-${fault}` as MutationId,
          command:{kind:"note.put" as const,input:{content:fault==="object"?"F".repeat(100000):"partial WAL",status:"active" as const}}};
        const result=await runPrivateT3Admission(request);
        const headAfter=createHash("sha256").update(await fs.readFile(path.join(directory,"HEAD"))).digest("hex");
        const walKind=await backend.kind(wal),walSize=walKind==="file"?(await fs.stat(wal)).size:0;
        console.log("B24T3WALFAULT",JSON.stringify({fault,injected,ok:result.ok,error:result.ok?undefined:result.error,headHash,headAfter,walKind,walSize}));
        expect(injected).toBe(true);expect(result.ok).toBe(false);expect(headAfter).toBe(headHash);
        if(fault==="object")expect(walKind).toBe("missing");
        else {
          expect(walKind).toBe("file");expect(walSize).toBe(16);
          if(!result.ok)expect(result.error.code).toBe("RECOVERY_REQUIRED");
        }
      } finally {spy.mockRestore();}
    } finally {await opened.value.close();}
  },120_000);
});
