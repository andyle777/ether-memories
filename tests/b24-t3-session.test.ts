import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsWalStore, commitUnderRecoveryAuthority, type CommitRequest } from "../src/persistence/FsWalStore.js";
import { productionRegistry } from "../src/persistence/productionOperations.js";
import { withRecoveryAuthority, type RecoveryAuthority } from "../src/persistence/recoveryAuthority.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";
import { ok } from "../src/utils/result.js";

describe("B24-T3 session authenticity", () => {
  it("refuses forged and expired sessions before a WAL request is accepted", async () => {
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),"b24-t3-session-")); const directory=path.join(temp,"store");
    await fs.cp(path.join(import.meta.dirname,"fixtures","b24-t3-v070","store"),directory,{recursive:true,force:false,errorOnExist:true});
    const io=process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
    const store=new FsWalStore({directory,registry:productionRegistry},io);
    let captured: RecoveryAuthority | undefined;
    const acquired=await withRecoveryAuthority(directory,io,async authority=>{captured=authority;return ok(undefined);});
    expect(acquired.ok).toBe(true); expect(captured).toBeDefined();
    const fake={...captured!,verify:async()=>undefined} as RecoveryAuthority;
    const request={} as CommitRequest;
    await expect(commitUnderRecoveryAuthority(store,fake,request)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    await expect(commitUnderRecoveryAuthority(store,captured!,request)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
  },120_000);
});
