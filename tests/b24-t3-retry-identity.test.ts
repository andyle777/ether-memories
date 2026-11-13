import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
import { productionRegistry, runPrivateT3Admission } from "../src/persistence/productionOperations.js";
import { decodeWalFrame, encodeWalFrame } from "../src/persistence/wal.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";
import { parseTransactionSequenceId } from "../src/utils/durablePersistence.js";
import type { MutationId } from "../src/types/persistence.js";

describe("B24-T3 active retry identity", () => {
  it("does not acknowledge a different transaction carrying the same intent and operations", async () => {
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-reidentity-")),directory=path.join(parent,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true});
    const opened=await openDurableEtherMemories({userId:"b24-fixture-user",directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok).toBe(true); if(!opened.ok)throw Error("startup");
    try {
      const snapshot=opened.value.exportData(),tip=opened.value.tip;if(!snapshot.ok||!tip.ok)throw Error("state");
      const backend=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
      const request={directory,io:backend,base:tip.value,snapshot:snapshot.value,mutationId:"a-b24-reidentity" as MutationId,
        command:{kind:"note.put" as const,input:{content:"identity remains exact",status:"active" as const}}};
      const first=await runPrivateT3Admission(request);expect(first.ok).toBe(true);
      const head=JSON.parse(await fs.readFile(path.join(directory,"HEAD"),"utf8")) as {checkpoint:{digest:string}};
      const wal=path.join(directory,"wal",`wal-${head.checkpoint.digest}.bin`);
      const original=decodeWalFrame(await fs.readFile(wal),productionRegistry);if(!original.ok)throw Error("decode");
      const tx=original.value;
      const prior=encodeWalFrame({...tx,mutation:{...tx.mutation,mutationId:"a-b24-prior" as MutationId},identity:{epochId:tx.identity.epochId,txId:tx.identity.txId}},productionRegistry);
      if(!prior.ok)throw Error("prior");
      const next=parseTransactionSequenceId((BigInt(prior.value.transaction.identity.txId)+1n).toString());if(!next.ok)throw Error("next");
      const moved=encodeWalFrame({...tx,expectedBase:prior.value.transaction.identity,identity:{epochId:tx.identity.epochId,txId:next.value}},productionRegistry);
      if(!moved.ok)throw Error("moved");
      const replacement=Buffer.concat([Buffer.from(prior.value.bytes),Buffer.from(moved.value.bytes)]);let reads=0,replaced=false;
      const io={...backend,async kind(p:string){if(p===wal && ++reads===2){await fs.writeFile(wal,replacement);replaced=true;}return backend.kind(p);}};
      const retry=await runPrivateT3Admission({...request,io});const after=await fs.readFile(wal);
      console.log("B24T3REIDENTITY",JSON.stringify({replaced,reads,retry,unchanged:after.equals(replacement)}));
      expect(replaced).toBe(true);expect(retry.ok).toBe(false);if(!retry.ok)expect(retry.error.code).toBe("RECOVERY_REQUIRED");expect(after.equals(replacement)).toBe(true);
    } finally {await opened.value.close();}
  },120_000);
});
