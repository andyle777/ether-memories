import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { LIBRARY_VERSION, STORE_SCHEMA_VERSION, MEMORY_CONTEXT_SCHEMA_VERSION,
  PORTABLE_RECORD_SCHEMA_VERSION } from "../src/version.js";
import { openDurableEtherMemoriesInternal, createMutationId } from "../src/core/DurableEtherMemories.js";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const readBytes = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("v0.6.0 release metadata consistency", () => {
  it("pins the library release version in source and package metadata", () => {
    expect(LIBRARY_VERSION).toBe("0.6.0");
    const pkg = JSON.parse(read("../package.json"));
    expect(pkg.version).toBe("0.6.0");
    expect(pkg.version).toBe(LIBRARY_VERSION);
  });

  it("keeps the persisted schema versions independent of the release version", () => {
    expect(STORE_SCHEMA_VERSION).toBe("ether.memory_store.v0.3");
    expect(MEMORY_CONTEXT_SCHEMA_VERSION).toBe("ether.memory_context.v1");
    expect(PORTABLE_RECORD_SCHEMA_VERSION).toBe("ether.portable_record.v1");
  });

  it("identifies the current release in CHANGELOG, README and RELEASE-MANIFEST", () => {
    expect(read("../CHANGELOG.md").match(/^## (\d+\.\d+\.\d+) —/m)?.[1]).toBe(LIBRARY_VERSION);
    const readme = read("../README.md");
    expect(readme.split("\n")[0]).toBe(`# Ether Memories v${LIBRARY_VERSION}`);
    expect(readme.match(/^## v(\d+\.\d+\.\d+) —/m)?.[1]).toBe(LIBRARY_VERSION);
    const manifest = read("../RELEASE-MANIFEST.md");
    expect(manifest.match(/^Version: (\d+\.\d+\.\d+)$/m)?.[1]).toBe(LIBRARY_VERSION);
    expect(manifest.match(/^Tag: v(\d+\.\d+\.\d+)$/m)?.[1]).toBe(LIBRARY_VERSION);
  });

  it("keeps the five frozen fixture files byte-identical to the frozen digests", () => {
    const pinned: Record<string, string> = {
      "persistence-wire-v1.json": "ecc0d9b2276c9569bec4a3a139fb0ea3da12186459330c292dfb9c04255524af",
      "portable-record-v1.json": "76cd743be21116d864a7e2cc7c040a7dc4bad96a1090851e7f9414f5508966d5",
      "retrieval-golden-v1.json": "d0d3dd009f496cac22a38f1e5945ed3600026cbd2ba4b6d56bccb4c8fa77a6d1",
      "store-v0.3.json": "f8d9947a800fb65c1d20385a2ec9090b0e384625cef65325bb4a00f7b358607c",
      "wal-wire-v1.json": "04c980368c39c9506bd40d314ee1ef1f590ab169a09cff022b0f4a115133050c"
    };
    for (const [name, digest] of Object.entries(pinned)) {
      expect(sha256(readBytes(`./fixtures/${name}`))).toBe(digest);
    }
  });

  it("does not leak the release version into frozen persistence wire bytes", () => {
    const wire = JSON.parse(read("./fixtures/persistence-wire-v1.json"));
    const headBytes = Buffer.from(wire.headBase64, "base64");
    const checkpointBytes = Buffer.from(wire.checkpointBase64, "base64");
    expect(sha256(headBytes)).toBe(wire.headSha256);
    expect(sha256(checkpointBytes)).toBe(wire.checkpointSha256);
    for (const bytes of [headBytes, checkpointBytes]) {
      expect(bytes.includes(Buffer.from(LIBRARY_VERSION, "utf8"))).toBe(false);
      expect(bytes.toString("utf8")).toContain(STORE_SCHEMA_VERSION);
    }
    const walWire = JSON.parse(read("./fixtures/wal-wire-v1.json"));
    const frameBytes = Buffer.from(walWire.frameBase64, "base64");
    expect(sha256(frameBytes)).toBe(walWire.frameSha256);
    expect(frameBytes.includes(Buffer.from(LIBRARY_VERSION, "utf8"))).toBe(false);
  });
});

describe("v0.6.0 durable release-integrity smoke", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
  });

  it("persists and exports the frozen store schema under release 0.6.0", async () => {
    const store = await bootstrap();
    cleanup.push(store.parent);
    const runtime = value(await openDurableEtherMemoriesInternal(
      { userId: store.snapshot.identity.userId, directory: store.directory, openMode: "existing" },
      { io: store.io }));
    const before = value(runtime.exportData());
    expect(before.schemaVersion).toBe("ether.memory_store.v0.3");
    value(await runtime.addMemory({ content: "release integrity note", tags: ["release"] }, createMutationId()));
    const after = value(runtime.exportData());
    expect(after.schemaVersion).toBe("ether.memory_store.v0.3");
    expect(after.memoryNotes.some(note => note.content === "release integrity note")).toBe(true);
    value(await runtime.close());
    // The durable artifacts carry the frozen store schema, never the release version.
    const checkpointBytes = await fs.readFile(join(store.directory, "checkpoints", "checkpoint-checkpoint-a.bin"));
    expect(checkpointBytes.includes(Buffer.from(STORE_SCHEMA_VERSION, "utf8"))).toBe(true);
    expect(checkpointBytes.includes(Buffer.from(LIBRARY_VERSION, "utf8"))).toBe(false);
    const walBytes = await fs.readFile(store.walPath);
    expect(walBytes.includes(Buffer.from(LIBRARY_VERSION, "utf8"))).toBe(false);
  });
});

describe("v0.6.0 release documentation integrity", { timeout: 120_000 }, () => {
  it("resolves every local link in the release README", () => {
    const readme = read("../README.md");
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1])
      .filter(target => !/^(https?:|#|mailto:)/.test(target));
    expect(links.length).toBeGreaterThan(0);
    for (const target of links) {
      const resolved = fileURLToPath(new URL(`../${target.replace(/^\.?\//, "")}`, import.meta.url));
      expect(existsSync(resolved), `README links to missing file: ${target}`).toBe(true);
    }
  });

  it("documents repairable incomplete tails as distinct from authoritative corruption", () => {
    const readme = read("../README.md");
    expect(readme).toContain("repairable incomplete final transaction tail");
    expect(readme).toContain("always fails closed");
    const manifest = read("../RELEASE-MANIFEST.md");
    expect(manifest).toContain("repairable incomplete final WAL tail");
    expect(manifest).toContain("always fails closed");
  });

  it("documents garbage-collection failure precedence accurately", () => {
    const readme = read("../README.md");
    expect(readme).toContain("maintenance failures alone leave the runtime ready");
    expect(readme).toContain("authority uncertainty and authoritative corruption retain precedence");
  });

  it("compiles the exact README durable quick-start example against the shipped declarations", async () => {
    const readme = read("../README.md");
    const blocks = [...readme.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map(match => match[1]);
    const durableExample = blocks.find(code => code.includes("openDurableEtherMemories"));
    if (durableExample === undefined) throw new Error("README durable quick-start example not found.");
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const findTsc = (): string => {
      let dir = repoRoot;
      for (;;) {
        const candidate = join(dir, "node_modules", "typescript", "lib", "tsc.js");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) throw new Error("TypeScript compiler not found in any ancestor node_modules.");
        dir = parent;
      }
    };
    const project = await fs.mkdtemp(join(tmpdir(), "ether-readme-example-"));
    try {
      await fs.mkdir(join(project, "node_modules"), { recursive: true });
      await fs.symlink(repoRoot, join(project, "node_modules", "ether-memories"),
        process.platform === "win32" ? "junction" : undefined);
      await fs.writeFile(join(project, "readme-example.mts"), durableExample);
      const compiled = spawnSync(process.execPath, [findTsc(),
        "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext",
        "--target", "es2022", "readme-example.mts"], { cwd: project, encoding: "utf8" });
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});
