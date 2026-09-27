import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsDurableStore } from "../src/persistence/FsDurableStore.js";
import { FsWalStore } from "../src/persistence/FsWalStore.js";
import { WalFileScan, type WalScanSource } from "../src/persistence/walFileScan.js";
import { nodeWalIO, type WalIO } from "../src/persistence/walIO.js";
import { fixture, value } from "./helpers/persistence.js";
import { history, registry, request, simulatedDirectoryIO } from "./helpers/wal.js";

const recovery = { ok: false, error: { code: "RECOVERY_REQUIRED" } };
const busy = { ok: false, error: { code: "WRITER_BUSY" } };

describe("continuation source authority contract", () => {
  const data = fixture();
  let parent: string;
  let directory: string;
  let path: string;
  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-source4-"));
    directory = join(parent, "store");
    value(await new FsDurableStore({ directory }, simulatedDirectoryIO()).initialize(data));
    path = join(directory, "wal", `wal-${data.head.checkpoint.digest}.bin`);
  });
  afterEach(async () => {
    if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-source4-")) throw new Error("Unsafe cleanup");
    await fs.rm(parent, { recursive: true, force: true });
  });

  it.each(["commit", "readTip", "reconcile"])("holds uninterrupted authority and one handle throughout %s validation and barriers", async action => {
    const h = history(180);
    expect(h.bytes.length).toBeGreaterThan(65536);
    await fs.writeFile(path, h.bytes);
    let entered!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { resume = r; });
    const events: string[] = [];
    let opens = 0;
    let reads = 0;
    let lockBytes: Buffer | undefined;
    const check = async (event: string) => {
      const bytes = await fs.readFile(join(directory, "writer.lock"));
      lockBytes ??= bytes;
      expect(bytes).toEqual(lockBytes);
      events.push(event);
    };
    const io: WalIO = { ...nodeWalIO, open: async (p, create) => {
      await check("open");
      opens++;
      const file = await nodeWalIO.open(p, create);
      return { ...file,
        read: async (b, at) => {
          await check("read");
          const n = await file.read(b, at);
          if (++reads === 1) { entered(); await gate; await check("resume"); }
          return n;
        },
        write: async (b, at) => { await check("write"); return file.write(b, at); },
        sync: async () => { await check("sync"); await file.sync(); },
        close: async () => { await check("close"); await file.close(); }
      };
    } };
    const dir = simulatedDirectoryIO();
    const owner = new FsWalStore({ directory, registry }, { ...dir,
      removeOwnedFile: async p => { await check("release"); await dir.removeOwnedFile(p); }
    }, io);
    const pending = action === "readTip" ? owner.readTip()
      : owner.commit(action === "reconcile" ? request(undefined, "mutation-0") : request(h.tip, "ours"));
    await reached;
    try {
      const competitor = new FsWalStore({ directory, registry }, simulatedDirectoryIO());
      expect(await competitor.commit(request(h.tip, "competitor"))).toMatchObject(busy);
      expect(await competitor.readTip()).toMatchObject(busy);
      expect(await owner.commit(request(h.tip, "same-instance"))).toMatchObject(busy);
      expect(await fs.readFile(path)).toEqual(h.bytes);
    } finally { resume(); }
    const settled = await pending;
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error(JSON.stringify(settled.error));
    const result = settled.value;
    expect(opens).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect(events.indexOf("sync")).toBeGreaterThan(events.lastIndexOf("read"));
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("sync"));
    expect(events.indexOf("release")).toBeGreaterThan(events.indexOf("close"));
    if (action === "commit") expect(events.indexOf("write")).toBeGreaterThan(events.lastIndexOf("read"));
    else {
      expect(events).not.toContain("write");
      expect(await fs.readFile(path)).toEqual(h.bytes);
    }
    if (action === "readTip") expect(result).toEqual(h.tip);
    if (action === "reconcile") expect(result).toMatchObject({ status: "already-committed", identity: h.frames[0]!.transaction.identity });
    await expect(fs.stat(join(directory, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it.each(["authority", "growth"])("rejects %s loss during an authoritative scan before appending", async cause => {
    const h = history(180);
    await fs.writeFile(path, h.bytes);
    let changed = false;
    let writes = 0;
    const io: WalIO = { ...nodeWalIO, open: async (p, create) => {
      const file = await nodeWalIO.open(p, create);
      return { ...file,
        read: async (b, at) => {
          const n = await file.read(b, at);
          if (!changed) {
            changed = true;
            if (cause === "authority") await fs.writeFile(join(directory, "writer.lock"), "foreign authority");
            else await fs.appendFile(p, Buffer.from([1]));
          }
          return n;
        },
        write: async (b, at) => { writes++; return file.write(b, at); }
      };
    } };
    const result = await new FsWalStore({ directory, registry }, simulatedDirectoryIO(), io).commit(request(h.tip, "ours"));
    expect(result).toMatchObject(recovery);
    expect(writes).toBe(0);
    expect(await fs.readFile(path)).toEqual(cause === "authority" ? h.bytes : Buffer.concat([h.bytes, Buffer.from([1])]));
  });

  it("requires explicit scan semantics and an operational authority verifier", async () => {
    await fs.writeFile(path, history(3).bytes);
    const file = await nodeWalIO.open(path, false);
    try {
      // @ts-expect-error No implicit authoritative or advisory scan.
      expect(await WalFileScan.open(path, file, data.head, registry, nodeWalIO)).toMatchObject(recovery);
      // @ts-expect-error A mode flag alone does not establish authority.
      expect(await WalFileScan.open(path, file, data.head, registry, nodeWalIO, { mode: "authority-held" })).toMatchObject(recovery);
      expect(await WalFileScan.open(path, file, data.head, registry, nodeWalIO, {
        mode: "authority-held", verifyAuthority: async () => { throw new Error("not held"); }
      })).toMatchObject(recovery);
    } finally { await file.close(); }
  });

  it("does not upgrade advisory tokens for recovery and poisons continuations after authority loss", async () => {
    await fs.writeFile(path, history(3).bytes);
    const lock = join(directory, "writer.lock");
    const lockBytes = Buffer.from("test-owned-authority");
    await fs.writeFile(lock, lockBytes, { flag: "wx" });
    const source: WalScanSource = { mode: "authority-held", verifyAuthority: async () => {
      if (!(await fs.readFile(lock)).equals(lockBytes)) throw new Error("authority lost");
    } };
    const file = await nodeWalIO.open(path, false);
    try {
      const advisory = value(await WalFileScan.open(path, file, data.head, registry, nodeWalIO, { mode: "advisory" }, 50));
      const observed = value(await advisory.next(advisory.cursor())).continuation;
      const authoritative = value(await WalFileScan.open(path, file, data.head, registry, nodeWalIO, source, 50));
      expect(advisory.mode).toBe("advisory");
      expect(authoritative.mode).toBe("authority-held");
      expect(await authoritative.next(observed)).toMatchObject(recovery);
      const start = authoritative.cursor();
      expect(await authoritative.next({ ...start })).toMatchObject(recovery);
      expect(await authoritative.next({ ...start, offset: 100 })).toMatchObject(recovery);
      const next = value(await authoritative.next(start)).continuation;
      expect(await authoritative.next(start)).toMatchObject(recovery);
      await fs.writeFile(lock, "foreign");
      expect(await authoritative.next(next)).toMatchObject(recovery);
      await fs.writeFile(lock, lockBytes);
      expect(await authoritative.next(next)).toMatchObject(recovery);
    } finally { await file.close(); }
  });

  it("rejects cross-file continuations even for equal WAL bytes", async () => {
    const h = history(3);
    await fs.writeFile(path, h.bytes);
    const otherPath = join(parent, "other.bin");
    await fs.writeFile(otherPath, h.bytes);
    const a = await nodeWalIO.open(path, false);
    const b = await nodeWalIO.open(otherPath, false);
    try {
      const x = value(await WalFileScan.open(path, a, data.head, registry, nodeWalIO, { mode: "advisory" }, 50));
      const y = value(await WalFileScan.open(otherPath, b, data.head, registry, nodeWalIO, { mode: "advisory" }, 50));
      expect(await x.next(y.cursor())).toMatchObject(recovery);
    } finally { await a.close(); await b.close(); }
  });

  it.each(["before", "boundary", "after", "immediate", "delayed", "truncate-restore", "replacement", "append", "unchanged", "identical", "restored-mtime"])(
    "documents advisory behavior for %s external changes with colliding timestamps", async mode => {
      const h = history(3);
      await fs.writeFile(path, h.bytes);
      const initial = await nodeWalIO.stamp(path);
      // Reproduce the observed NTFS collision deterministically, keeping identity/size real.
      const frozenTimes = async (s: ReturnType<typeof nodeWalIO.stamp>) => ({ ...await s, mtime: initial.mtime, ctime: initial.ctime });
      const io: WalIO = { ...nodeWalIO, stamp: p => frozenTimes(nodeWalIO.stamp(p)) };
      const file = await nodeWalIO.open(path, false);
      const handle = { ...file, stat: () => frozenTimes(file.stat()) };
      try {
        const chunk = mode === "immediate" ? 50 : h.frames[0]!.bytes.length;
        const scan = value(await WalFileScan.open(path, handle, data.head, registry, io, { mode: "advisory" }, chunk));
        let cursor = value(await scan.next(scan.cursor())).continuation;
        const offset = mode === "boundary" ? cursor.offset : mode === "after" ? h.bytes.length - 10 : 100;
        const changed = Buffer.from(h.bytes);
        changed[offset] ^= 1;
        if (mode === "delayed") await new Promise(r => setTimeout(r, 25)); // Attack timing only, never a stability mechanism.
        if (mode === "replacement") { await fs.rename(path, join(parent, "old.bin")); await fs.writeFile(path, h.bytes); }
        else if (mode === "append") await fs.appendFile(path, Buffer.from([1]));
        else if (mode === "truncate-restore") { await fs.truncate(path, 0); await fs.writeFile(path, changed); }
        else if (mode === "identical") await fs.writeFile(path, h.bytes);
        else if (mode !== "unchanged") await fs.writeFile(path, changed);
        if (mode === "restored-mtime") await fs.utimes(path, new Date(), new Date(Number(initial.mtime / 1000000n)));
        let result = await scan.next(cursor);
        if (mode === "immediate") expect(result.ok).toBe(true); // Byte 100 has not yet been read.
        while (result.ok && !result.value.continuation.ended) {
          cursor = result.value.continuation;
          result = await scan.next(cursor);
        }
        if (["replacement", "append"].includes(mode)) expect(result).toMatchObject(recovery);
        else if (["boundary", "after", "immediate"].includes(mode)) expect(result).toMatchObject({ ok: false, error: { code: "PERSISTENCE_CORRUPTION" } });
        else {
          expect(value(result).continuation).toMatchObject({ ended: true, tip: h.tip });
          // Previously accepted bytes are NOT reread; success is only advisory.
          expect(scan.mode).toBe("advisory");
        }
      } finally { await file.close(); }
    });
});
