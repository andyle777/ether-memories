import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EtherMemoriesCore, FsDurableStore, PERSISTENCE_LIMITS, encodeCheckpoint, encodeStoreHead } from "../src/index.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../src/persistence/directoryIO.js";
import { fixture, value } from "./helpers/persistence.js";

// State-machine tests simulate directory barriers and atomic activation; not platform guarantees.
function simulatedIO(): DirectoryIO {
  return { ...nodeDirectoryIO, syncDirectory: async () => {},
    activateFile: async (candidate, destination) => { await fs.rename(candidate, destination); return "atomic"; } };
}
const recovery = { ok: false, error: { code: "RECOVERY_REQUIRED" } };
const unavailable = { ok: false, error: { code: "DURABILITY_UNAVAILABLE" } };
const injectedFailure = () => { throw new Error("injected failure"); };

describe("explicit durable-store directory foundation", () => {
  let parent: string;
  let directory: string;
  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-af1-"));
    directory = join(parent, "store");
  });
  afterEach(async () => {
    if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-af1-")) throw new Error("Unsafe test cleanup path");
    await fs.rm(parent, { recursive: true, force: true });
  });
  const checkpointPath = (root: string) => join(root, "checkpoints", "checkpoint-checkpoint-a.bin");

  it("bootstraps only an absent directory and inspects metadata without claiming recovered memory state", async () => {
    const data = fixture();
    const store = new FsDurableStore({ directory }, simulatedIO());
    expect(await store.inspect()).toEqual({ ok: true, value: { state: "missing" } });
    expect(await store.initialize(data)).toEqual({ ok: true, value: { head: data.head, activation: "atomic", durability: "confirmed" } });
    expect(await new FsDurableStore({ directory }).inspect()).toEqual({ ok: true, value: { state: "active", head: data.head, recovery: "required" } });
    expect((await fs.readdir(directory)).sort()).toEqual([".private", "HEAD", "checkpoints", "wal"]);
    expect(await fs.readFile(checkpointPath(directory))).toEqual(Buffer.from(data.checkpointBytes));
    expect(await fs.readdir(join(directory, "wal"))).toEqual([]);
    expect(await fs.readdir(join(directory, ".private"))).toEqual([]);
    const before = await fs.readFile(join(directory, "HEAD"));
    expect(await store.initialize(fixture("2"))).toMatchObject(recovery);
    expect(await fs.readFile(join(directory, "HEAD"))).toEqual(before);
    expect("load" in store).toBe(false);
    expect("durable" in store).toBe(false);
  });

  it("orders candidate persistence, barrier, verification, atomic activation and final barriers", async () => {
    const events: string[] = [];
    const base = simulatedIO();
    const io: DirectoryIO = { ...base,
      writeExclusive: async (path, bytes) => { await base.writeExclusive(path, bytes); events.push("persist:" + basename(path)); },
      readBounded: async (path, limit) => { const bytes = await base.readBounded(path, limit); events.push("verify:" + basename(path)); return bytes; },
      syncDirectory: async path => { events.push("barrier:" + basename(path)); },
      activateFile: async (from, to) => { const result = await base.activateFile(from, to); events.push("activate"); return result; },
      removeOwnedFile: async path => { await base.removeOwnedFile(path); events.push("release"); }
    };
    expect((await new FsDurableStore({ directory }, io).initialize(fixture())).ok).toBe(true);
    const start = events.indexOf("persist:HEAD.candidate");
    expect(events.slice(start)).toEqual(["persist:HEAD.candidate", "barrier:.private", "verify:HEAD.candidate",
      "verify:checkpoint-checkpoint-a.bin", "activate", "barrier:.private", "barrier:store", "release", "barrier:store"]);
  });

  it("reports the real native platform barrier outcome without pretending simulated tests prove durability", async () => {
    const result = await new FsDurableStore({ directory }).initialize(fixture());
    if (process.platform === "win32") {
      expect(result).toMatchObject(unavailable);
      expect(result).toMatchObject({ error: { details: { phase: "preflight", activation: "not-attempted", durability: "unconfirmed" } } });
      expect(await nodeDirectoryIO.kind(directory)).toBe("missing");
    } else if (result.ok) {
      expect(result.value).toMatchObject({ activation: "atomic", durability: "confirmed" });
      expect(value(await new FsDurableStore({ directory }).inspect()).state).toBe("active");
    } else expect(result).toMatchObject(unavailable);
  });

  it("fails before any mutation when the backend directory barrier is unavailable", async () => {
    const io = { ...simulatedIO(), syncDirectory: async () => { throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "unsupported"); } };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(unavailable);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it.each(["before-candidate", "partial-candidate", "unactivated-candidate", "verified-activation-failure"])("fails closed after %s and never promotes a candidate on reopen", async point => {
    const base = simulatedIO();
    let candidateWritten = false;
    let candidateVerified = false;
    const io: DirectoryIO = { ...base,
      writeExclusive: async (path, bytes) => {
        if (basename(path) === "HEAD.candidate") {
          if (point === "before-candidate") injectedFailure();
          if (point === "partial-candidate") { await fs.writeFile(path, bytes.subarray(0, 20), { flag: "wx" }); injectedFailure(); }
          await base.writeExclusive(path, bytes);
          candidateWritten = true;
        } else await base.writeExclusive(path, bytes);
      },
      syncDirectory: async path => {
        if (point === "unactivated-candidate" && candidateWritten && basename(path) === ".private") {
          throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected candidate barrier failure");
        }
      },
      readBounded: async (path, limit) => { const bytes = await base.readBounded(path, limit); if (basename(path) === "HEAD.candidate") candidateVerified = true; return bytes; },
      activateFile: async () => { expect(candidateVerified).toBe(true); return injectedFailure(); }
    };
    const store = new FsDurableStore({ directory }, io);
    expect(await store.initialize(fixture())).toMatchObject(point === "unactivated-candidate" ? unavailable : recovery);
    expect(await nodeDirectoryIO.kind(join(directory, "HEAD"))).toBe("missing");
    const candidate = join(directory, ".private", "HEAD.candidate");
    const before = await nodeDirectoryIO.kind(candidate) === "file" ? await fs.readFile(candidate) : null;
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject(recovery);
    expect(await new FsDurableStore({ directory }, simulatedIO()).initialize(fixture())).toMatchObject(recovery);
    if (before) expect(await fs.readFile(candidate)).toEqual(before);
    else expect(await nodeDirectoryIO.kind(candidate)).toBe("missing");
  });

  it("rejects candidate verification failure without invoking activation", async () => {
    const base = simulatedIO();
    let activated = false;
    const io: DirectoryIO = { ...base,
      readBounded: async (path, limit) => basename(path) === "HEAD.candidate" ? Buffer.from("{}") : base.readBounded(path, limit),
      activateFile: async (from, to) => { activated = true; return base.activateFile(from, to); }
    };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(recovery);
    expect(activated).toBe(false);
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject(recovery);
  });

  it("rechecks persisted checkpoint bytes before activation", async () => {
    const base = simulatedIO();
    const io: DirectoryIO = { ...base, readBounded: async (path, limit) => {
      if (basename(path) === "HEAD.candidate") await fs.writeFile(checkpointPath(directory), "corrupted");
      return base.readBounded(path, limit);
    } };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(recovery);
    expect(await nodeDirectoryIO.kind(join(directory, "HEAD"))).toBe("missing");
  });

  it.each(["activation-barrier", "authority-release-barrier"])("does not report strong success when %s fails after visible activation", async point => {
    const base = simulatedIO();
    let activated = false;
    let released = false;
    const io: DirectoryIO = { ...base,
      activateFile: async (from, to) => { const result = await base.activateFile(from, to); activated = true; return result; },
      removeOwnedFile: async path => { await base.removeOwnedFile(path); released = true; },
      syncDirectory: async () => {
        if (activated && (point === "activation-barrier" || released)) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected final barrier failure");
      }
    };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject({ ...unavailable,
      error: { code: "DURABILITY_UNAVAILABLE", details: { activation: "atomic-visible", durability: "unconfirmed" } } });
    expect(await nodeDirectoryIO.kind(join(directory, "HEAD"))).toBe("file");
    // Inspection can establish visible metadata, not retroactively confirm the failed durability result.
    expect(value(await new FsDurableStore({ directory }).inspect()).state).toBe("active");
  });

  it("requires the backend's atomic activation result, not just a successful operation", async () => {
    const base = simulatedIO();
    const io: DirectoryIO = { ...base, activateFile: async (from, to) => { await fs.rename(from, to); return undefined as unknown as "atomic"; } };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(unavailable);
  });

  it("uses only active HEAD and leaves orphan candidates and newer-looking checkpoints untouched", async () => {
    const data = fixture();
    const store = new FsDurableStore({ directory }, simulatedIO());
    value(await store.initialize(data));
    const orphan = join(directory, ".private", "HEAD.candidate");
    const newer = join(directory, "checkpoints", "checkpoint-newest.bin");
    await fs.writeFile(orphan, value(encodeStoreHead(fixture("999999").head)));
    await fs.writeFile(newer, "not a checkpoint");
    await fs.writeFile(join(directory, ".private", "unexpected.tmp"), "untouched");
    const before = await fs.readFile(orphan);
    expect(value(await store.inspect())).toEqual({ state: "active", head: data.head, recovery: "required" });
    expect(await fs.readFile(orphan)).toEqual(before);
    expect(await fs.readFile(newer, "utf8")).toBe("not a checkpoint");
    expect(await fs.readFile(join(directory, ".private", "unexpected.tmp"), "utf8")).toBe("untouched");
    await fs.writeFile(join(directory, "HEAD"), "corrupt");
    expect(await store.inspect()).toMatchObject(recovery);
    expect(await fs.readFile(join(directory, "HEAD"), "utf8")).toBe("corrupt");
    expect(await fs.readFile(orphan)).toEqual(before);
  });

  it.each(["missing-checkpoint", "wrong-digest", "wrong-identity", "unsupported-head", "unsupported-checkpoint", "oversized-head"])("rejects active authority with %s", async defect => {
    const data = fixture();
    const store = new FsDurableStore({ directory }, simulatedIO());
    value(await store.initialize(data));
    if (defect === "missing-checkpoint") await fs.unlink(checkpointPath(directory));
    if (defect === "wrong-digest") {
      const bytes = Buffer.from(data.checkpointBytes);
      bytes[bytes.length - 1] = 32;
      await fs.writeFile(checkpointPath(directory), bytes);
    }
    if (defect === "wrong-identity") {
      const other = value(encodeCheckpoint({ storeId: "store-b", checkpointId: data.head.checkpoint.checkpointId, tip: data.head.checkpoint.tip }, data.payload));
      await fs.writeFile(checkpointPath(directory), other.bytes);
      await fs.writeFile(join(directory, "HEAD"), value(encodeStoreHead({ ...data.head, checkpoint: other.identity })));
    }
    if (defect === "unsupported-head") await fs.writeFile(join(directory, "HEAD"), JSON.stringify({ ...data.head, version: "2" }));
    if (defect === "unsupported-checkpoint") await fs.writeFile(checkpointPath(directory), Buffer.from(data.checkpointBytes).toString().replace('"version":"1"', '"version":"2"'));
    if (defect === "oversized-head") await fs.writeFile(join(directory, "HEAD"), Buffer.alloc(PERSISTENCE_LIMITS.headBytes + 1));
    expect(await store.inspect()).toMatchObject(defect.startsWith("unsupported") ? { ok: false, error: { code: "UNSUPPORTED_PERSISTENCE_FORMAT" } } : recovery);
  });

  it("rejects arbitrary existing directories and files without cleanup or initialization", async () => {
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, "keep"), "untouched");
    const store = new FsDurableStore({ directory }, simulatedIO());
    expect(await store.inspect()).toMatchObject(recovery);
    expect(await store.initialize(fixture())).toMatchObject(recovery);
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    const file = join(parent, "arbitrary.json");
    await fs.writeFile(file, "{}");
    expect(await new FsDurableStore({ directory: file }).inspect()).toMatchObject(recovery);
  });

  it("never breaks an existing or ambiguously created writer artifact", async () => {
    const store = new FsDurableStore({ directory }, simulatedIO());
    value(await store.initialize(fixture()));
    const lock = join(directory, "writer.lock");
    await fs.writeFile(lock, "unknown writer");
    expect(await store.inspect()).toMatchObject({ ok: false, error: { code: "WRITER_BUSY" } });
    expect(await store.initialize(fixture())).toMatchObject({ ok: false, error: { code: "WRITER_BUSY" } });
    expect(await fs.readFile(lock, "utf8")).toBe("unknown writer");
  });

  it.each(["before-lock", "partial-lock"])("does not accept interrupted bootstrap at %s", async point => {
    const base = simulatedIO();
    const io: DirectoryIO = { ...base, writeExclusive: async (path, bytes) => {
      if (basename(path) === "writer.lock") {
        if (point === "partial-lock") await fs.writeFile(path, "partial", { flag: "wx" });
        return injectedFailure();
      }
      await base.writeExclusive(path, bytes);
    } };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(recovery);
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject(point === "before-lock" ? recovery : { ok: false, error: { code: "WRITER_BUSY" } });
    if (point === "partial-lock") expect(await fs.readFile(join(directory, "writer.lock"), "utf8")).toBe("partial");
    expect(await nodeDirectoryIO.kind(join(directory, "HEAD"))).toBe("missing");
  });

  it("fails closed if owned writer-authority release fails", async () => {
    const io: DirectoryIO = { ...simulatedIO(), removeOwnedFile: async () => injectedFailure() };
    expect(await new FsDurableStore({ directory }, io).initialize(fixture())).toMatchObject(recovery);
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject({ ok: false, error: { code: "WRITER_BUSY" } });
    expect(await nodeDirectoryIO.kind(join(directory, "writer.lock"))).toBe("file");
  });

  it("rejects invalid initialization metadata before creating any artifact", async () => {
    const data = fixture();
    const store = new FsDurableStore({ directory }, simulatedIO());
    expect(await store.initialize({ ...data, head: { ...data.head, storeId: "../escape" } })).toMatchObject({ ok: false, error: { code: "PERSISTENCE_CORRUPTION" } });
    data.checkpointBytes[data.checkpointBytes.length - 1] = 32;
    expect(await store.initialize(data)).toMatchObject({ ok: false, error: { code: "PERSISTENCE_CORRUPTION" } });
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("does not conflate read-only access failures with corrupt recovery", async () => {
    const io: DirectoryIO = { ...simulatedIO(), kind: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    expect(await new FsDurableStore({ directory }, io).inspect()).toMatchObject({ ok: false, error: { code: "READ_ONLY_LOCKED" } });
  });

  it("rejects symlink/junction roots, ancestors and layout directories without following or deleting them", async () => {
    const target = join(parent, "target");
    await fs.mkdir(target);
    await fs.writeFile(join(target, "keep"), "untouched");
    await fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject(recovery);
    expect(await new FsDurableStore({ directory: join(directory, "child") }, simulatedIO()).initialize(fixture())).toMatchObject(recovery);
    const other = join(parent, "other");
    value(await new FsDurableStore({ directory: other }, simulatedIO()).initialize(fixture()));
    await fs.rmdir(join(other, "wal"));
    await fs.symlink(target, join(other, "wal"), process.platform === "win32" ? "junction" : "dir");
    expect(await new FsDurableStore({ directory: other }).inspect()).toMatchObject(recovery);
    expect(await fs.readFile(join(target, "keep"), "utf8")).toBe("untouched");
  });

  it("rejects hard-linked authority files", async () => {
    value(await new FsDurableStore({ directory }, simulatedIO()).initialize(fixture()));
    await fs.link(join(directory, "HEAD"), join(parent, "head-alias"));
    expect(await new FsDurableStore({ directory }).inspect()).toMatchObject(recovery);
  });

  it("owns input bytes before asynchronous filesystem work", async () => {
    const data = fixture();
    const expectedHead = structuredClone(data.head);
    const pending = new FsDurableStore({ directory }, simulatedIO()).initialize(data);
    data.checkpointBytes.fill(0);
    Object.assign(data.head, { storeId: "changed" });
    expect(value(await pending).head).toEqual(expectedHead);
    expect(value(await new FsDurableStore({ directory }).inspect())).toMatchObject({ state: "active", head: expectedHead });
  });

  it("allows only one racing initializer to activate an absent store", async () => {
    const results = await Promise.all([new FsDurableStore({ directory }, simulatedIO()).initialize(fixture()),
      new FsDurableStore({ directory }, simulatedIO()).initialize(fixture("2"))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    for (const result of results) if (!result.ok) expect(["WRITER_BUSY", "RECOVERY_REQUIRED"]).toContain(result.error.code);
    expect(value(await new FsDurableStore({ directory }).inspect()).state).toBe("active");
  });

  it("preserves storagePath single-file behavior and recognizes legacy format without converting it", async () => {
    const path = join(parent, "legacy-without-extension");
    const source = new EtherMemoriesCore({ userId: "legacy-directory-test", storagePath: path });
    expect(source.addMemory({ content: "Still a single JSON snapshot" }).ok).toBe(true);
    expect((await source.save()).ok).toBe(true);
    expect((await fs.stat(path)).isFile()).toBe(true);
    const before = await fs.readFile(path);
    expect(await new FsDurableStore({ directory: path }).inspect()).toEqual({ ok: true, value: { state: "legacy-json" } });
    expect(await new FsDurableStore({ directory: path }, simulatedIO()).initialize(fixture())).toMatchObject(recovery);
    expect(await fs.readFile(path)).toEqual(before);
    const target = new EtherMemoriesCore({ userId: "legacy-directory-test", storagePath: path });
    expect((await target.load()).ok).toBe(true);
    expect(target.exportData()).toEqual(source.exportData());
  });
});
