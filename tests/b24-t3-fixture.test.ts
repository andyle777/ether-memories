import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";

const fixture = path.join(import.meta.dirname, "fixtures", "b24-t3-v070");
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("B24-T3 authentic v0.7 fixture", () => {
  it("verifies the producer inventory and opens a disposable copy", async () => {
    const manifestBytes = await fs.readFile(path.join(fixture, "manifest.json"));
    expect(digest(manifestBytes)).toBe("bec818bb859b1ab41b6ca68dbd5ad532b2aeaa3c6b0f22cc8d5e99de8f0b836c");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      archiveSha256: string; userId: string; files: {path:string;size:number;sha256:string}[];
    };
    expect(manifest.archiveSha256).toBe("aa9d978e97d0fdbe68d7f79d9d430d91009ba5a98f09be753e32e1107f3a89e4");
    expect(manifest.files.length).toBe(6);
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(fixture, "store", ...file.path.split("/")));
      expect({size:bytes.length,sha256:digest(bytes)}, file.path).toEqual({size:file.size,sha256:file.sha256});
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "b24-t3-fixture-"));
    const directory = path.join(temp, "store");
    await fs.cp(path.join(fixture, "store"), directory, {recursive:true,force:false,errorOnExist:true});
    const opened = await openDurableEtherMemories({userId:manifest.userId,directory,openMode:"existing",durabilityGuarantee:"recoverable"});
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error("fixture startup failed");
    try {
      const result = opened.value.queryMemories("second receipt");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.some(n => n.content === "second receipt")).toBe(true);
    } finally { await opened.value.close(); }
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(fixture, "store", ...file.path.split("/")));
      expect({size:bytes.length,sha256:digest(bytes)}, file.path).toEqual({size:file.size,sha256:file.sha256});
    }
  }, 120_000);
});
