import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDurableEtherMemories as openCurrent } from "../src/core/DurableEtherMemories.js";
import { prepareProducer } from "../scripts/b24-producer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/b24-abs-v070");
const original = path.join(fixture, "store");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Item = { path: string; size: number; sha256: string };
let producer: Awaited<ReturnType<typeof prepareProducer>>;

async function verifyProvenance(): Promise<void> {
  const indexBytes = await fs.readFile(path.join(fixture, "manifest.json"));
  expect(sha(indexBytes)).toBe("f4970a75c79fc30492ba1530fe72a9404be308f751c1601083a48f1b37ad37a3");
  const manifest = JSON.parse(indexBytes.toString("utf8")) as {files: Item[]};
  expect(manifest.files).toHaveLength(6);
  for (const item of manifest.files) {
    const bytes = await fs.readFile(path.join(original, ...item.path.split("/")));
    expect({ size: bytes.length, sha256: sha(bytes) }, item.path).toEqual({ size: item.size, sha256: item.sha256 });
  }
  expect(sha(await fs.readFile(producer.archive))).toBe("aa9d978e97d0fdbe68d7f79d9d430d91009ba5a98f09be753e32e1107f3a89e4");
}

const globalProducer: typeof openCurrent = (...args) => producer.openProducer(...args);

async function inventory(directory: string): Promise<Item[]> {
  const items: Item[] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(directory, relative);
    let entries;
    try { entries = await fs.readdir(absolute, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) { const bytes = await fs.readFile(path.join(directory, child)); items.push({ path: child.replaceAll("\\", "/"), size: bytes.length, sha256: sha(bytes) }); }
      else throw new Error("Unexpected authoritative inventory entry: " + child);
    }
  }
  const head = await fs.readFile(path.join(directory, "HEAD"));
  items.push({ path: "HEAD", size: head.length, sha256: sha(head) });
  for (const name of ["checkpoints", "wal", "receipts", "objects"]) await visit(name);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

describe("B24-ABS-001 proposed complete-history admission", () => {
  beforeAll(async () => { producer = await prepareProducer(root); }, 60_000);
  afterAll(async () => { if (producer) await producer.cleanup(); });
  it.each([false, true])("corrupt suffix=%s: fail closed or commit uncorrupted control", async corrupt => {
    await verifyProvenance();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "b24-abs001-"));
    const directory = path.join(scratch, "store");
    await fs.cp(original, directory, { recursive: true, force: false, errorOnExist: true });
    const options = { userId: "b24-fixture-user", directory, openMode: "existing" as const, durabilityGuarantee: "recoverable" as const };
    const producer = await globalProducer(options);
    expect(producer.ok, JSON.stringify(producer)).toBe(true);
    if (!producer.ok) throw new Error("Producer open failed");
    expect((await producer.value.addMemory({ content: "second receipt", status: "active" }, "z-b24-second")).ok).toBe(true);
    expect((await producer.value.rotate()).ok).toBe(true);
    expect((await producer.value.close()).ok).toBe(true);

    const opened = await openCurrent(options);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error("Current startup failed");
    try {
      const head = JSON.parse(await fs.readFile(path.join(directory, "HEAD"), "utf8")) as { checkpoint: { checkpointId: string } };
      const ledger = path.join(directory, "receipts", `receipts-${head.checkpoint.checkpointId}.bin`);
      const bytes = await fs.readFile(ledger);
      expect(sha(bytes)).toBe(head.checkpoint.checkpointId);
      const lines = bytes.toString("utf8").split("\n");
      expect(lines.length).toBe(4);
      expect(JSON.parse(lines[1]!).mutationId).toBe("b24-fixture-rotated-reclaimed");
      expect(JSON.parse(lines[2]!).mutationId).toBe("z-b24-second");
      const mutationId = "a-b24-probe";
      expect(mutationId < JSON.parse(lines[1]!).mutationId).toBe(true);
      const offset = Buffer.byteLength(lines[0]! + "\n" + lines[1]! + "\n");
      const altered = Buffer.from(bytes);
      if (corrupt) { altered[offset] = "!".charCodeAt(0); await fs.writeFile(ledger, altered); }
      expect(altered.length).toBe(bytes.length);
      const before = await inventory(directory);
      const tipBefore = { ...opened.value.tip };
      const result = await opened.value.addMemory({ content: "B24 ABS probe", status: "active" }, mutationId);
      const tipAfter = { ...opened.value.tip };
      const after = await inventory(directory);
      console.log("B24ABS001", JSON.stringify({ corrupt, directory, originalLedgerSha256: sha(bytes), injectedLedgerSha256: sha(altered), offset, before, after, tipBefore, tipAfter, result }));
      if (corrupt) {
        expect.soft(result.ok, "proposed admission must fail closed").toBe(false);
        expect.soft(tipAfter, "committed tip must not advance").toEqual(tipBefore);
        expect.soft(after, "authoritative file inventory must remain unchanged").toEqual(before);
      } else {
        expect(result.ok, "uncorrupted control must commit").toBe(true);
        expect(tipAfter).not.toEqual(tipBefore);
        expect(after).not.toEqual(before);
      }
    } finally { await opened.value.close(); }
  }, 120_000);
});
