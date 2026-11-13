import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDurableEtherMemories, openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { nodeDirectoryIO, windowsRecoverableDirectoryIO } from "../src/persistence/directoryIO.js";

const fixture = path.join(import.meta.dirname, "fixtures", "b24-t3-v070", "store");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function inventory(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const name = path.join(dir, item.name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) entries.push(`${path.relative(root, name)}:${sha(await fs.readFile(name))}`);
      else throw new Error("unexpected file type");
    }
  }
  for (const part of ["HEAD", "checkpoints", "receipts", "objects", "wal"]) {
    const target = path.join(root, part);
    if ((await fs.stat(target)).isDirectory()) await walk(target);
    else entries.push(`${part}:${sha(await fs.readFile(target))}`);
  }
  return entries.sort();
}

describe("Phase 1 public receipt integrity", () => {
  it.each(["earlier-missing", "historical-retry"] as const)("rejects corrupted later history before %s", async which => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "b24-p1-")), "store");
    await fs.cp(fixture, dir, { recursive: true });
    const opened = await openDurableEtherMemories({ userId: "b24-fixture-user", directory: dir, openMode: "existing", durabilityGuarantee: "recoverable" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw Error("startup failed");
    try {
      const head = JSON.parse(await fs.readFile(path.join(dir, "HEAD"), "utf8")) as { checkpoint: { checkpointId: string } };
      const ledger = path.join(dir, "receipts", `receipts-${head.checkpoint.checkpointId}.bin`);
      const bytes = await fs.readFile(ledger);
      const lines = bytes.toString("utf8").split("\n");
      const offset = Buffer.byteLength(lines[0]! + "\n" + lines[1]! + "\n");
      const mutated = Buffer.from(bytes); mutated[offset] = 33;
      await fs.writeFile(ledger, mutated);
      const before = await inventory(dir);
      const result = which === "earlier-missing"
        ? await opened.value.addMemory({ content: "phase1 probe", status: "active" }, "a-phase1")
        : await opened.value.addMemory({ content: "b24-large-" + "x".repeat(400000), tags: ["b24fixture"], status: "active" }, "b24-fixture-rotated-reclaimed");
      const after = await inventory(dir);
      console.log("PHASE1_RECEIPT", JSON.stringify({ which, result: result.ok ? "ok" : result.error.code, before, after }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
      expect(after).toEqual(before);
    } finally { await opened.value.close(); }
  }, 120_000);

  it.each([false, true])("reconciles historical retry with conflicting intent=%s without changing files", async conflict => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "b24-p1-retry-")), "store");
    await fs.cp(fixture, dir, { recursive: true });
    const opened = await openDurableEtherMemories({ userId: "b24-fixture-user", directory: dir, openMode: "existing", durabilityGuarantee: "recoverable" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw Error("startup failed");
    try {
      const before = await inventory(dir);
      const result = await opened.value.addMemory({ content: conflict ? "different intent" : "second receipt", status: "active" }, "z-b24-second");
      expect(result.ok).toBe(!conflict);
      if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
      expect(await inventory(dir)).toEqual(before);
    } finally { await opened.value.close(); }
  }, 120_000);

  it("rejects receipt corruption introduced while a competing writer is excluded", async () => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "b24-p1-concurrent-")), "store");
    await fs.cp(fixture, dir, { recursive: true });
    const backend = process.platform === "win32" ? windowsRecoverableDirectoryIO : nodeDirectoryIO;
    let enabled = false, paused = false;
    let signal!: () => void, resume!: () => void;
    const acquired = new Promise<void>(resolve => { signal = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const io = { ...backend, async readBounded(p: string, n: number) {
      const result = await backend.readBounded(p, n);
      if (enabled && !paused && p.endsWith("writer.lock")) { paused = true; signal(); await gate; }
      return result;
    } };
    const options = { userId: "b24-fixture-user", directory: dir, openMode: "existing" as const, durabilityGuarantee: "recoverable" as const };
    const first = await openDurableEtherMemoriesInternal(options, { io });
    const second = await openDurableEtherMemories(options);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw Error("startup failed");
    try {
      enabled = true;
      const pending = first.value.addMemory({ content: "first", status: "active" }, "a-phase1-concurrent");
      await acquired;
      const head = JSON.parse(await fs.readFile(path.join(dir, "HEAD"), "utf8")) as { checkpoint: { checkpointId: string } };
      const ledger = path.join(dir, "receipts", `receipts-${head.checkpoint.checkpointId}.bin`);
      const bytes = await fs.readFile(ledger), lines = bytes.toString("utf8").split("\n");
      const offset = Buffer.byteLength(lines[0]! + "\n" + lines[1]! + "\n");
      const corrupted = Buffer.from(bytes); corrupted[offset] = 33; await fs.writeFile(ledger, corrupted);
      const before = await inventory(dir);
      const competing = await second.value.addMemory({ content: "second", status: "active" }, "a-phase1-competing");
      expect(competing.ok).toBe(false);
      if (!competing.ok) expect(competing.error.code).toBe("WRITER_BUSY");
      resume();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
      expect(await inventory(dir)).toEqual(before);
    } finally { resume(); await first.value.close(); await second.value.close(); }
  }, 120_000);
});
