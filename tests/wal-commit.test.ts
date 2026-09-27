import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsDurableStore } from "../src/persistence/FsDurableStore.js";
import { FsWalStore, MUTATION_CACHE_ENTRIES } from "../src/persistence/FsWalStore.js";
import { nodeWalIO, type WalIO, type WalFileHandle } from "../src/persistence/walIO.js";
import { WalFileScan } from "../src/persistence/walFileScan.js";
import { nodeDirectoryIO } from "../src/persistence/directoryIO.js";
import { scanWal } from "../src/persistence/wal.js";
import { fixture, value } from "./helpers/persistence.js";
import { frame, history, registry, request, simulatedDirectoryIO } from "./helpers/wal.js";

const recovery = { ok: false, error: { code: "RECOVERY_REQUIRED" } };
const corruption = { ok: false, error: { code: "PERSISTENCE_CORRUPTION" } };
const busy = { ok: false, error: { code: "WRITER_BUSY" } };
const stale = { ok: false, error: { code: "STALE_TRANSACTION_BASE" } };
const fail = () => { throw new Error("injected failure"); };

describe("durable WAL coordinator and real filesystem fault ordering", () => {
  let parent: string;
  let directory: string;
  let path: string;
  const data = fixture();
  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-wal4-"));
    directory = join(parent, "store");
    value(await new FsDurableStore({ directory }, simulatedDirectoryIO()).initialize(data));
    path = join(directory, "wal", `wal-${data.head.checkpoint.digest}.bin`);
  });
  afterEach(async () => {
    if (dirname(resolve(parent)) !== resolve(tmpdir()) || !basename(parent).startsWith("ether-wal4-")) throw new Error("Unsafe cleanup path");
    await fs.rm(parent, { recursive: true, force: true });
  });
  const store = (io: WalIO = nodeWalIO) => new FsWalStore({ directory, registry }, simulatedDirectoryIO(), io);
  const onDisk = async () => {
    const bytes = await fs.readFile(path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return Buffer.alloc(0); throw e; });
    return { bytes, scan: scanWal(bytes, data.head, registry) };
  };

  it("appends the exact reviewed wire bytes, reads durable tip and preserves authority bytes", async () => {
    const before = await fs.readFile(join(directory, "HEAD"));
    const s = store();
    expect(value(await s.readTip())).toEqual(data.head.checkpoint.tip);
    const receipt = value(await s.commit(request()));
    expect(receipt).toMatchObject({ status: "committed", durability: "confirmed", identity: frame().transaction.identity, mutation: request().mutation });
    expect(await fs.readFile(path)).toEqual(Buffer.from(frame().bytes));
    expect(value(await store().readTip())).toEqual(receipt.identity);
    expect(await fs.readFile(join(directory, "HEAD"))).toEqual(before);
    expect(await nodeDirectoryIO.kind(join(directory, "writer.lock"))).toBe("missing");
  });

  it("assigns exact +1 sequence for many appends beyond Number.MAX_SAFE_INTEGER", async () => {
    const s = store();
    let base = data.head.checkpoint.tip;
    for (let i = 0; i < 40; i++) {
      const receipt = value(await s.commit(request(base, `mutation-${i}`)));
      expect(receipt.identity.txId).toBe((BigInt(base.txId) + 1n).toString());
      base = receipt.identity;
    }
    expect(value(await store().readTip())).toEqual(base);
    expect(value((await onDisk()).scan).transactions).toHaveLength(40);
  }, 30000);

  it.each(["tx", "digest", "epoch"])("rejects stale %s base without rebase or WAL changes", async part => {
    const s = store();
    const first = value(await s.commit(request()));
    const base = { ...first.identity };
    if (part === "tx") base.txId = data.head.checkpoint.tip.txId;
    if (part === "digest") base.digest = "f".repeat(64);
    if (part === "epoch") base.epochId = "other-epoch";
    const before = await fs.readFile(path);
    expect(await s.commit(request(base, "other"))).toMatchObject({ ...stale, error: { ...stale.error, details: { outcome: "not-committed", visibility: "none" } } });
    expect(await fs.readFile(path)).toEqual(before);
  });

  it("reconciles old-base logical retries and fails conflicting digest or resolved operations closed", async () => {
    const first = value(await store().commit(request()));
    const before = await fs.readFile(path);
    expect(value(await store().commit(request()))).toMatchObject({ status: "already-committed", identity: first.identity });
    expect(await store().commit(request(undefined, "mutation-a", "different"))).toMatchObject(corruption);
    const spoof = { ...request(undefined, "mutation-a", "different"), mutation: request().mutation };
    expect(await store().commit(spoof)).toMatchObject(corruption);
    expect(await fs.readFile(path)).toEqual(before);
  });

  it("owns caller input before first await and rejects unknown operations before acquisition", async () => {
    const r = request();
    const pending = store().commit(r);
    (r.operations[0]!.payload as { text: string }).text = "changed after call";
    expect(value(await pending).identity).toEqual(frame().transaction.identity);
    expect(await store().commit({ ...request(), operations: [{ type: "unknown", version: "1", payload: {} }] })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PERSISTENCE_FORMAT", details: { phase: "prepare" } } });
  });

  it("serializes two independent writers and never commits two successor IDs", async () => {
    let announce!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(r => { announce = r; });
    const gate = new Promise<void>(r => { release = r; });
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, write: async (b, at) => { const n = await h.write(b, at); announce(); await gate; return n; } };
    } };
    const first = store(io).commit(request());
    await reached;
    const loser = await store().commit(request(undefined, "second"));
    release();
    expect(loser).toMatchObject(busy);
    expect((await first).ok).toBe(true);
    expect(await store().commit(request(undefined, "second"))).toMatchObject(stale);
    expect(value((await onDisk()).scan).transactions).toHaveLength(1);
  });

  it("handles positive short writes in an explicit ordered positional loop", async () => {
    const positions: number[] = [];
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, write: async (b, at) => { positions.push(at); return h.write(b.subarray(0, 13), at); } };
    } };
    expect((await store(io).commit(request())).ok).toBe(true);
    expect(positions.length).toBeGreaterThan(20);
    expect(positions).toEqual(positions.map((_, i) => i * 13));
    expect(await fs.readFile(path)).toEqual(Buffer.from(frame().bytes));
  });

  const failurePoints = ["before-open", "after-open", "before-write", "prefix", "header", "operations", "digest", "terminator", "before-sync", "sync", "after-sync", "directory-sync", "close", "release"];
  it.each(failurePoints)("classifies on-disk state and retry after fault: %s", async point => {
    const bytes = Buffer.from(frame().bytes);
    const headerEnd = 24 + bytes.readUInt32BE(8);
    const cut = ({ prefix: 7, header: 40, operations: headerEnd + 8, digest: bytes.length - 25, terminator: bytes.length - 3 } as Record<string, number>)[point];
    let written = 0;
    let synced = false;
    let closeFailed = false;
    const events: string[] = [];
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      events.push("open");
      if (point === "before-open") fail();
      const h = await nodeWalIO.open(p, c);
      if (point === "after-open") { await h.close(); fail(); }
      return { ...h,
        write: async (b, at) => {
          events.push("write");
          if (point === "before-write" || (cut !== undefined && written >= cut)) fail();
          const n = await h.write(cut === undefined ? b : b.subarray(0, cut - written), at);
          written += n;
          return n;
        },
        sync: async () => {
          events.push("sync");
          if (point === "before-sync" || point === "sync") fail();
          await h.sync(); synced = true;
          if (point === "after-sync") fail();
        },
        close: async () => {
          events.push("close"); await h.close();
          if (point === "close" && !closeFailed) { closeFailed = true; fail(); }
        }
      };
    } };
    const baseDir = simulatedDirectoryIO();
    const dir = { ...baseDir,
      syncDirectory: async (p: string) => { events.push("directory:" + basename(p)); if (point === "directory-sync" && synced && basename(p) === "wal") fail(); },
      removeOwnedFile: async (p: string) => { await baseDir.removeOwnedFile(p); if (point === "release") fail(); }
    };
    const result = await new FsWalStore({ directory, registry }, dir, io).commit(request());
    expect(result.ok).toBe(false);
    const disk = await onDisk();
    const scan = value(disk.scan);
    if (["before-open", "after-open", "before-write"].includes(point)) {
      expect(disk.bytes.length).toBe(0);
      expect(scan.transactions).toHaveLength(0);
    } else if (cut !== undefined) {
      expect(disk.bytes.length).toBe(cut);
      expect(scan).toMatchObject({ tail: "incomplete", transactions: [], tip: data.head.checkpoint.tip });
      expect(await store().commit(request())).toMatchObject(recovery);
      expect(await fs.readFile(path)).toEqual(disk.bytes);
    } else {
      expect(scan.transactions).toHaveLength(1);
      expect(scan.tail).toBe("none");
      expect(result).toMatchObject({ error: { code: "RECOVERY_REQUIRED", details: { outcome: "reconciliation-required", visibility: "complete" } } });
      expect(value(await store().commit(request()))).toMatchObject({ status: "already-committed", identity: frame().transaction.identity });
      expect(await fs.readFile(path)).toEqual(disk.bytes);
    }
    if (point === "before-open" || point === "after-open") expect(result).toMatchObject({ error: { details: { outcome: "not-committed", visibility: "none" } } });
    if (point === "close" || point === "release") expect(result).toMatchObject({ error: { details: { durability: "confirmed" } } });
    if (events.includes("sync")) expect(events.indexOf("sync")).toBeGreaterThan(events.indexOf("write"));
  });

  it("never calls a visible but unsynced frame durable on retry when the barrier still fails", async () => {
    await fs.writeFile(path, frame().bytes);
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => { const h = await nodeWalIO.open(p, c); return { ...h, sync: async () => fail() }; } };
    expect(await store(io).commit(request())).toMatchObject({ error: { code: "RECOVERY_REQUIRED", details: { durability: "unconfirmed", outcome: "reconciliation-required" } } });
    expect(await fs.readFile(path)).toEqual(Buffer.from(frame().bytes));
  });

  it("reconciles a write that completed but threw before returning its byte count", async () => {
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, write: async (b, at) => { await h.write(b, at); return fail(); } };
    } };
    expect(await store(io).commit(request())).toMatchObject({ error: { code: "RECOVERY_REQUIRED",
      details: { outcome: "reconciliation-required", visibility: "possible", durability: "unconfirmed" } } });
    expect(value((await onDisk()).scan).transactions).toHaveLength(1);
    expect(value(await store().commit(request())).status).toBe("already-committed");
    expect(await fs.readFile(path)).toEqual(Buffer.from(frame().bytes));
  });

  it("retries owned-handle cleanup when close throws before closing", async () => {
    let closes = 0;
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, close: async () => { if (++closes === 1) fail(); await h.close(); } };
    } };
    expect(await store(io).commit(request())).toMatchObject(recovery);
    expect(closes).toBe(2);
    expect(value(await store().commit(request())).status).toBe("already-committed");
  });

  it("requires reconciliation when the writer-removal directory barrier fails", async () => {
    let removed = false;
    const io = simulatedDirectoryIO();
    const dir = { ...io,
      removeOwnedFile: async (p: string) => { await io.removeOwnedFile(p); removed = true; },
      syncDirectory: async () => { if (removed) fail(); }
    };
    expect(await new FsWalStore({ directory, registry }, dir).commit(request())).toMatchObject({ error: {
      code: "RECOVERY_REQUIRED", details: { phase: "writer-release", durability: "confirmed", outcome: "reconciliation-required" }
    } });
    expect(value(await store().commit(request())).status).toBe("already-committed");
  });

  it.each([0, -1, Number.NaN, 2 ** 30])("fails closed on invalid write progress %s", async count => {
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, write: async () => count };
    } };
    expect(await store(io).commit(request())).toMatchObject(recovery);
    expect((await onDisk()).bytes.length).toBe(0);
  });

  it("detects a file mutation during the durability barrier", async () => {
    const io: WalIO = { ...nodeWalIO, open: async (p, c) => {
      const h = await nodeWalIO.open(p, c);
      return { ...h, sync: async () => { await h.sync(); await fs.appendFile(p, Buffer.from([1])); } };
    } };
    expect(await store(io).commit(request())).toMatchObject(recovery);
    expect((await onDisk()).scan).toMatchObject(corruption);
  });

  it("invalidates cached history when another authority commits", async () => {
    const a = store();
    const first = value(await a.commit(request()));
    const second = value(await store().commit(request(first.identity, "other-writer")));
    expect(await a.commit(request(first.identity, "stale-cached"))).toMatchObject(stale);
    expect(value(await a.readTip())).toEqual(second.identity);
  });

  it("leaves a failed authority release for explicit operator handling", async () => {
    const io = simulatedDirectoryIO();
    const dir = { ...io, removeOwnedFile: async () => fail() };
    expect(await new FsWalStore({ directory, registry }, dir).commit(request())).toMatchObject({
      error: { code: "RECOVERY_REQUIRED", details: { durability: "confirmed", outcome: "reconciliation-required" } }
    });
    expect(await store().commit(request())).toMatchObject(busy);
    expect(value((await onDisk()).scan).transactions).toHaveLength(1);
  });

  it("rejects caller-assigned transaction IDs, numeric bases and overflowing exact successors", async () => {
    const s = store();
    expect(await s.commit({ ...request(), txId: "2" } as any)).toMatchObject(corruption);
    expect(await s.commit({ ...request(), expectedBase: { ...request().expectedBase, txId: 9007199254740992 } } as any)).toMatchObject(corruption);
    expect(await s.commit({ ...request(), expectedBase: { ...request().expectedBase, txId: "9".repeat(128) } } as any)).toMatchObject(corruption);
    expect(await nodeDirectoryIO.kind(path)).toBe("missing");
  });

  it("keeps permission denial distinct and does not publish success", async () => {
    const io: WalIO = { ...nodeWalIO, open: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    expect(await store(io).commit(request())).toMatchObject({ error: { code: "READ_ONLY_LOCKED", details: { outcome: "not-committed" } } });
    expect(await nodeDirectoryIO.kind(path)).toBe("missing");
  });

  it("bounds configured directory paths before touching the filesystem", async () => {
    expect(await new FsWalStore({ directory: "x".repeat(4097), registry }, simulatedDirectoryIO()).commit(request()))
      .toMatchObject({ error: { code: "DURABILITY_UNAVAILABLE", details: { phase: "preflight" } } });
  });

  it("ignores orphan WAL names and refuses unsafe WAL layout", async () => {
    await fs.writeFile(join(directory, "wal", "newest-looking.bin"), Buffer.from("not authoritative"));
    expect(value(await store().readTip())).toEqual(data.head.checkpoint.tip);
    await fs.rename(join(directory, "wal"), join(directory, "wal-saved"));
    await fs.symlink(join(directory, "wal-saved"), join(directory, "wal"), "junction");
    expect(await store().commit(request())).toMatchObject(recovery);
    expect(await fs.readFile(join(directory, "wal-saved", "newest-looking.bin"))).toEqual(Buffer.from("not authoritative"));
  });

  it.each(["partial", "corrupt", "fork", "logical-duplicate"])("refuses existing %s history without appending or repairing", async mode => {
    const f = frame();
    let bytes = Buffer.from(f.bytes);
    if (mode === "partial") bytes = bytes.subarray(0, bytes.length - 4);
    if (mode === "corrupt") bytes[bytes.length - 20] ^= 1;
    if (mode === "fork") bytes = Buffer.concat([bytes, frame(request(undefined, "other", "B")).bytes]);
    if (mode === "logical-duplicate") bytes = Buffer.concat([bytes, frame(request(f.transaction.identity)).bytes]);
    await fs.writeFile(path, bytes);
    const result = await store().commit(request(f.transaction.identity, "new"));
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path)).toEqual(bytes);
  });

  it("skips adjacent physical duplicates and reconciles without adding another frame", async () => {
    await fs.writeFile(path, Buffer.concat([frame().bytes, frame().bytes]));
    expect(value(await store().commit(request())).status).toBe("already-committed");
    expect(value((await onDisk()).scan)).toMatchObject({ duplicates: 1, transactions: [frame().transaction] });
  });

  it("detects mutation between tip validation and append", async () => {
    const first = frame();
    await fs.writeFile(path, first.bytes);
    let readComplete = false;
    let checksAfterRead = 0;
    const io: WalIO = { ...nodeWalIO,
      open: async (p, c) => {
        const file = await nodeWalIO.open(p, c);
        return { ...file, read: async (b, at) => { const n = await file.read(b, at); readComplete = true; return n; } };
      },
      stamp: async p => {
        // After the batch's post-read and final scan checks, attack the pre-append check.
        if (readComplete && ++checksAfterRead === 3) await fs.appendFile(path, frame(request(first.transaction.identity, "external")).bytes);
        return nodeWalIO.stamp(p);
      }
    };
    expect(await store(io).commit(request(first.transaction.identity, "ours"))).toMatchObject(recovery);
    expect(checksAfterRead).toBe(3);
    expect(value((await onDisk()).scan).transactions).toHaveLength(2);
    expect(value((await onDisk()).scan).transactions.some(t => t.mutation.mutationId === "ours")).toBe(false);
  });

  it("does not break an ambiguous acquisition or a foreign writer artifact", async () => {
    const io = simulatedDirectoryIO();
    const dir = { ...io, writeExclusive: async (p: string, b: Uint8Array) => { await io.writeExclusive(p, b); fail(); } };
    expect((await new FsWalStore({ directory, registry }, dir).commit(request())).ok).toBe(false);
    const lock = await fs.readFile(join(directory, "writer.lock"));
    expect(await store().commit(request())).toMatchObject(busy);
    expect(await fs.readFile(join(directory, "writer.lock"))).toEqual(lock);
  });

  it("rejects hardlinked WAL files without modifying either link", async () => {
    await fs.writeFile(path, frame().bytes);
    await fs.link(path, join(parent, "alias"));
    expect(await store().commit(request())).toMatchObject(recovery);
    expect(await fs.readFile(path)).toEqual(Buffer.from(frame().bytes));
  });

  it("keeps native Windows directory durability refusal before WAL or lock mutation", async () => {
    if (process.platform !== "win32") return;
    expect(await new FsWalStore({ directory, registry }).commit(request())).toMatchObject({ ok: false, error: { code: "DURABILITY_UNAVAILABLE" } });
    expect(await nodeDirectoryIO.kind(path)).toBe("missing");
    expect(await nodeDirectoryIO.kind(join(directory, "writer.lock"))).toBe("missing");
  });

  it("reconciles beyond the bounded cache by streaming history, never treating eviction as absence", async () => {
    const h = history(MUTATION_CACHE_ENTRIES + 2);
    await fs.writeFile(path, h.bytes);
    const s = store();
    expect(value(await s.readTip())).toEqual(h.tip);
    const retry = request(h.frames[MUTATION_CACHE_ENTRIES]!.transaction.expectedBase, `mutation-${MUTATION_CACHE_ENTRIES}`);
    expect(value(await s.commit(retry)).identity).toEqual(h.frames[MUTATION_CACHE_ENTRIES]!.transaction.identity);
    expect((await fs.stat(path)).size).toBe(h.bytes.length);
  }, 30000);

  it.each(["growth", "same-size", "replacement"])("invalidates file continuations on %s changes with observable stamp differences", async mode => {
    const h = history(3);
    await fs.writeFile(path, h.bytes);
    const handle = await nodeWalIO.open(path, false);
    try {
      let changedStamp = false;
      // The old test assumed a rewrite must change timestamps. Inject that indicator
      // deterministically; equal-stamp rewrites have separate advisory contract tests.
      const io: WalIO = { ...nodeWalIO, stamp: async p => {
        const stamp = await nodeWalIO.stamp(p);
        return changedStamp ? { ...stamp, ctime: stamp.ctime + 1n } : stamp;
      } };
      const scan = value(await WalFileScan.open(path, handle, data.head, registry, io, { mode: "advisory" }, 50));
      const first = value(await scan.next(scan.cursor()));
      if (mode === "growth") await fs.appendFile(path, frame(request(h.tip, "extra")).bytes);
      if (mode === "same-size") { const changed = Buffer.from(h.bytes); changed[100] ^= 1; await fs.writeFile(path, changed); changedStamp = true; }
      if (mode === "replacement") { await fs.rename(path, join(parent, "old")); await fs.writeFile(path, h.bytes); }
      expect(await scan.next(first.continuation)).toMatchObject(recovery);
    } finally { await handle.close(); }
  });

  it("detects WAL growth during a batch read and rejects foreign file tokens", async () => {
    await fs.writeFile(path, history(3).bytes);
    const handle = await nodeWalIO.open(path, false);
    try {
      let mutated = false;
      const ioHandle: WalFileHandle = { ...handle, read: async (b, at) => {
        const n = await handle.read(b, at);
        if (!mutated) { mutated = true; await fs.appendFile(path, Buffer.from([1])); }
        return n;
      } };
      const first = value(await WalFileScan.open(path, ioHandle, data.head, registry, nodeWalIO, { mode: "advisory" }, 50));
      const other = value(await WalFileScan.open(path, handle, data.head, registry, nodeWalIO, { mode: "advisory" }, 50));
      expect(await first.next(other.cursor())).toMatchObject(recovery);
      expect(await first.next(first.cursor())).toMatchObject(recovery);
    } finally { await handle.close(); }
  });
});
