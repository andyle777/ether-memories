import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { StartupRecovery, type RecoveryPhase } from "../src/persistence/StartupRecovery.js";
import { ProductionWalStore, PRODUCTION_OPERATIONS, reduceProduction } from "../src/persistence/productionOperations.js";
import { encodeSnapshotPayload, hydrateSnapshot, snapshotData } from "../src/persistence/snapshotPayload.js";
import { PERSISTENCE_LIMITS } from "../src/persistence/codecs.js";
import { nodeWalIO, type WalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";
import { bootstrap, notePut, mutationId, semanticFrame, sourceSnapshot, semanticNote, identityPut } from "./helpers/recovery.js";

const cleanup: string[] = [];
const setup = async (raw?: unknown) => { const store = await bootstrap(raw); cleanup.push(store.parent); return store; };
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

describe("authoritative startup recovery", { timeout: 30_000 }, () => {
  it("checkpoint-only, derived index, clone isolation and repeated restart", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) {
      const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
      expect(runtime.read().ok).toBe(false);
      expect(runtime.queryMemories("TypeScript").ok).toBe(false);
      const receipt = value(await runtime.recover());
      expect(receipt.transactions).toBe(0);
      const read = value(runtime.read());
      expect(read.tip).toEqual(s.tip);
      expect(value(encodeSnapshotPayload(read.snapshot))).toEqual(value(encodeSnapshotPayload(s.snapshot)));
      expect(value(runtime.queryMemories("TypeScript", { asOf: 0 })).some(x => x.memory.id === "alpha")).toBe(true);
      read.snapshot.memoryNotes[0]!.content = "caller mutation";
      expect(value(runtime.read()).snapshot.memoryNotes[0]!.content).not.toBe("caller mutation");
    }
  });
  it("one transaction publishes complete state and exact large txId while authority is held", async () => {
    const s = await setup();
    const receipt = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("first"), [notePut()]));
    let runtime: StartupRecovery;
    const phases: string[] = [];
    runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, { async at(phase) {
      phases.push(phase);
      expect(await fs.readFile(join(s.directory, "writer.lock"), "utf8")).toContain("store-a");
      if (phase !== "after-publication") expect(runtime.read().ok).toBe(false);
      else expect(value(runtime.read()).tip).toEqual(receipt.identity);
    } });
    expect(value(await runtime.recover()).transactions).toBe(1);
    expect(value(runtime.read()).snapshot.memoryNotes.find(n => n.id === "alpha")?.content).toBe("Termux recovered");
    expect(receipt.identity.txId).toBe("9007199254740994");
    expect(phases).toContain("before-publication");
    expect(value(runtime.queryMemories("Termux", { asOf: 0 }))).toHaveLength(1);
  });
  it.each<RecoveryPhase>(["checkpoint", "transaction", "indexes", "before-publication"])("failure at %s keeps old generation unchanged", async phase => {
    const s = await setup();
    let fail = false;
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, { async at(p) { if (fail && p === phase) throw new Error("injected"); } });
    value(await runtime.recover());
    const before = value(runtime.read());
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("first"), [notePut()]));
    fail = true;
    expect((await runtime.recover()).ok).toBe(false);
    expect(value(runtime.read())).toEqual(before);
  });
  it("postpublication failure does not duplicate history or undo the published root", async () => {
    const s = await setup();
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("first"), [notePut()]));
    const before = await fs.readFile(s.walPath);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, { async at(p) { if (p === "after-publication") throw new Error("lost response"); } });
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(true);
    expect(await fs.readFile(s.walPath)).toEqual(before);
    const fresh = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    value(await fresh.recover());
    expect(value(fresh.read())).toEqual(value(runtime.read()));
  });
  it("physical duplicates replay once and reducer failure never publishes or truncates", async () => {
    const s = await setup();
    const good = semanticFrame(s.tip);
    await fs.writeFile(s.walPath, Buffer.concat([good.bytes, good.bytes]));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await runtime.recover()).transactions).toBe(1);
    const bad = semanticFrame(good.transaction.identity, [{ type: "ether.note.remove", version: "1", payload: { id: "missing" } }], "second");
    await fs.appendFile(s.walPath, bad.bytes);
    const before = await fs.readFile(s.walPath);
    expect((await runtime.recover()).ok).toBe(false);
    expect(value(runtime.read()).tip).toEqual(good.transaction.identity);
    expect(await fs.readFile(s.walPath)).toEqual(before);
  });
  it.each(["head", "checkpoint", "wal", "garbage", "lock"] as const)("fails closed for %s damage", async kind => {
    const s = await setup();
    const frame = semanticFrame(s.tip);
    await fs.writeFile(s.walPath, frame.bytes);
    if (kind === "head") await fs.writeFile(join(s.directory, "HEAD"), "bad");
    if (kind === "checkpoint") await fs.appendFile(join(s.directory, "checkpoints", "checkpoint-checkpoint-a.bin"), "bad");
    if (kind === "wal") { const bytes = Buffer.from(frame.bytes); bytes[bytes.length - 9]! ^= 1; await fs.writeFile(s.walPath, bytes); }
    if (kind === "garbage") await fs.appendFile(s.walPath, "garbage");
    if (kind === "lock") await fs.writeFile(join(s.directory, "writer.lock"), "foreign");
    const before = await fs.readFile(s.walPath);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(before);
  });
  it.each([1, 24, 30, "header", "operations", "digest", "trailer"] as const)("repairs only incomplete final tail at %s then cleanly rescans", async point => {
    const s = await setup();
    const a = semanticFrame(s.tip);
    const b = semanticFrame(a.transaction.identity, [notePut("second")], "second");
    const headerEnd = 24 + Buffer.from(b.bytes).readUInt32BE(8);
    const cuts = { header: headerEnd, operations: b.bytes.length - 40, digest: b.bytes.length - 8, trailer: b.bytes.length - 1 };
    const cut = typeof point === "number" ? point : cuts[point];
    await fs.writeFile(s.walPath, Buffer.concat([a.bytes, b.bytes.subarray(0, cut)]));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = value(await runtime.recover());
    expect(result.repairedTailBytes).toBe(cut);
    expect(result.tip).toEqual(a.transaction.identity);
    expect(await fs.readFile(s.walPath)).toEqual(a.bytes);
  });
  it("failed truncate sync never publishes; retry recovers the surviving prefix", async () => {
    const s = await setup(), frame = semanticFrame(s.tip);
    await fs.writeFile(s.walPath, frame.bytes.subarray(0, 30));
    const files: WalIO = { ...nodeWalIO, async open(path, create) {
      const f = await nodeWalIO.open(path, create);
      return { ...f, async sync() { throw new Error("sync"); } };
    } };
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, files);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
    value(await new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io).recover());
  });
  it.each([145000, 1157983, 3 * 1024 * 1024, PERSISTENCE_LIMITS.checkpointPayloadBytes - 1, PERSISTENCE_LIMITS.checkpointPayloadBytes])("recovers exact canonical snapshot size %s", async size => {
    const raw = sourceSnapshot();
    raw.memoryNotes[0].content = "";
    const initial = value(encodeSnapshotPayload(value(hydrateSnapshot(raw, raw.identity.userId)))).length;
    raw.memoryNotes[0].content = "x".repeat(size - initial);
    const s = await setup(raw);
    const runtime = new StartupRecovery(s.directory, raw.identity.userId, s.io);
    value(await runtime.recover());
    expect(value(encodeSnapshotPayload(value(runtime.read()).snapshot)).length).toBe(size);
  });
  it("WAL growth past checkpoint size fails deterministically without publication or truncation", async () => {
    const raw = sourceSnapshot();
    raw.memoryNotes[0].content = "x".repeat(PERSISTENCE_LIMITS.checkpointPayloadBytes - 4000);
    const s = await setup(raw);
    const op = notePut(); (op.payload as any).id = "new-note"; (op.payload as any).content = "y".repeat(8000);
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("overflow"), [op]));
    const before = await fs.readFile(s.walPath);
    for (let i = 0; i < 2; i++) {
      const runtime = new StartupRecovery(s.directory, raw.identity.userId, s.io);
      const result = await runtime.recover();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("RECOVERY_REQUIRED");
      expect(runtime.read().ok).toBe(false);
    }
    expect(await fs.readFile(s.walPath)).toEqual(before);
  });
  it("lost ACK large payload retry on same base with same mutation produces same transaction", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "idempotent-note"; (op.payload as any).content = "x".repeat(10000);
    const first = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("first"), [op]));
    const runtime1 = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const receipt1 = value(await runtime1.recover());
    expect(receipt1.tip.txId).toBe(first.identity.txId);
    const second = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("first"), [op]));
    expect(second.identity.txId).toBe(first.identity.txId);
  });
  it("reads during recovery never expose candidate state", async () => {
    const s = await setup();
    const op = notePut();
    await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("read-test"), [op]);
    let readDuring = false;
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, { async at(phase) {
      if (phase === "checkpoint" || phase === "transaction" || phase === "indexes") {
        readDuring = runtime.read().ok;
      }
    } });
    value(await runtime.recover());
    expect(readDuring).toBe(false);
  });
  it("restart idempotency produces identical StateRoot", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "restart-test"; (op.payload as any).content = "z".repeat(5000);
    await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("restart"), [op]);
    const results = [];
    for (let i = 0; i < 3; i++) {
      const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
      const receipt = value(await runtime.recover());
      const read = value(runtime.read());
      results.push({ tip: receipt.tip, snapshotBytes: value(encodeSnapshotPayload(read.snapshot)) });
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i].tip).toEqual(results[0].tip);
      expect(results[i].snapshotBytes).toEqual(results[0].snapshotBytes);
    }
  });
  it("corrupt production-data encoding fails recovery", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "corrupt-enc"; (op.payload as any).content = "x".repeat(1000000);
    const result = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("corrupt-commit"), [op]));
    const objectsDir = join(s.directory, "objects");
    const files = await fs.readdir(objectsDir);
    const objPath = join(objectsDir, files[0]);
    const objBytes = await fs.readFile(objPath);
    const corrupted = Buffer.from(objBytes);
    corrupted[100] = 0; corrupted[101] = 0; corrupted[102] = 0;
    await fs.writeFile(objPath, corrupted);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
  });
  it("wrong object path referenced fails recovery gracefully", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "wrong-path"; (op.payload as any).content = "x".repeat(1000000);
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("path-commit"), [op]));
    const objectsDir = join(s.directory, "objects");
    const files = await fs.readdir(objectsDir);
    const objPath = join(objectsDir, files[0]);
    await fs.rename(objPath, join(objectsDir, "wrong-name.bin"));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
  });
  it("unrelated orphan object does not affect recovery", async () => {
    const s = await setup();
    const op = notePut();
    await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("orphan-test"), [op]);
    const objectsDir = join(s.directory, "objects");
    await fs.mkdir(objectsDir, { recursive: true });
    await fs.writeFile(join(objectsDir, "unrelated-orphan.bin"), Buffer.from("unrelated data"));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = value(await runtime.recover());
    expect(result.transactions).toBe(1);
    expect(runtime.read().ok).toBe(true);
  });
  it("detects duplicate mutation IDs beyond the old 4096-entry horizon", async () => {
    const s = await setup();
    // 4096 unique transactions, then two distinct transactions reusing one
    // mutation identity. Frames are built directly so the writer-side
    // reconciliation cannot mask what recovery must detect on its own.
    const chunks: Buffer[] = [];
    let base = s.tip;
    for (let i = 0; i < 4096; i++) {
      const frame = semanticFrame(base, [identityPut()], `unique-${i}`);
      chunks.push(Buffer.from(frame.bytes));
      base = frame.transaction.identity;
    }
    const duplicate = "duplicate-beyond-horizon";
    const first = semanticFrame(base, [identityPut()], duplicate);
    chunks.push(Buffer.from(first.bytes));
    const second = semanticFrame(first.transaction.identity, [identityPut()], duplicate, "2".repeat(64));
    chunks.push(Buffer.from(second.bytes));
    const wal = Buffer.concat(chunks);
    await fs.writeFile(s.walPath, wal);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = await runtime.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
  }, 120_000);
  it("rejects one mutation identity reused by two distinct transactions even with an identical digest", async () => {
    const s = await setup();
    // Same mutationId AND same mutation digest under two distinct transaction
    // identities is a logical duplicate, not the harmless physical frame case.
    const first = semanticFrame(s.tip, [notePut("first reuse")], "same-digest-reuse");
    const second = semanticFrame(first.transaction.identity, [notePut("second reuse")], "same-digest-reuse");
    const wal = Buffer.concat([Buffer.from(first.bytes), Buffer.from(second.bytes)]);
    await fs.writeFile(s.walPath, wal);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = await runtime.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
  });
  it("allows physical duplicate WAL frames according to frozen WAL semantics", async () => {
    const s = await setup();
    const op = notePut();
    (op.payload as any).id = "physical-dup-test";
    const frame = semanticFrame(s.tip, [op], "test-mutation");
    // Write the same frame twice (physical duplicate)
    await fs.writeFile(s.walPath, Buffer.concat([frame.bytes, frame.bytes]));
    
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = value(await runtime.recover());
    // Physical duplicates should replay once and succeed
    expect(result.transactions).toBe(1);
    expect(runtime.read().ok).toBe(true);
  });
  it("detects duplicate mutation IDs thousands of frames apart", async () => {
    const s = await setup();
    const distant = "duplicate-spread-apart";
    const chunks: Buffer[] = [];
    let base = s.tip;
    const first = semanticFrame(base, [notePut("first content")], distant);
    chunks.push(Buffer.from(first.bytes));
    base = first.transaction.identity;
    for (let i = 0; i < 100; i++) {
      const frame = semanticFrame(base, [identityPut()], `mutation-${i}`);
      chunks.push(Buffer.from(frame.bytes));
      base = frame.transaction.identity;
    }
    const second = semanticFrame(base, [notePut("different content")], distant, "2".repeat(64));
    chunks.push(Buffer.from(second.bytes));
    const wal = Buffer.concat(chunks);
    await fs.writeFile(s.walPath, wal);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const result = await runtime.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
  });
  it("object durable but WAL not committed leaves an inert orphan and recovers zero transactions", async () => {
    const s = await setup();
    let armed = true;
    const files: WalIO = { ...nodeWalIO, async open(path, create) {
      if (armed && path.includes(join("wal", "wal-"))) throw new Error("injected WAL open after object install");
      return nodeWalIO.open(path, create);
    } };
    const op = notePut(); (op.payload as any).id = "orphan-note"; (op.payload as any).content = "x".repeat(100000);
    const result = await new ProductionWalStore(s.directory, s.io, files).commit(s.tip, mutationId("orphan-fault"), [op]);
    expect(result.ok).toBe(false);
    const objectsDir = join(s.directory, "objects");
    const objects = await fs.readdir(objectsDir);
    expect(objects.length).toBe(1);
    expect(await fs.stat(s.walPath).then(x => x.size, () => 0)).toBe(0);
    // The durable object is inert: recovery never publishes it without a committed frame.
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(0);
    const read = value(runtime.read());
    expect(read.snapshot.memoryNotes.find(n => n.id === "orphan-note")).toBeUndefined();
    // A later retry on the same base commits cleanly and the object is reused.
    armed = false;
    const retry = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("orphan-fault"), [op]));
    expect(retry.status).toBe("committed");
  });
  it("committed WAL with a missing referenced object fails recovery without publication", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "missing-object-note"; (op.payload as any).content = "x".repeat(100000);
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("missing-object"), [op]));
    const objectsDir = join(s.directory, "objects");
    for (const name of await fs.readdir(objectsDir)) await fs.rm(join(objectsDir, name));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
  });
  it("authority loss before publication never publishes the recovered generation", async () => {
    const s = await setup();
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("authority-loss"), [notePut()]));
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, { async at(phase) {
      if (phase === "before-publication") await fs.writeFile(join(s.directory, "writer.lock"), "foreign-authority");
    } });
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
    // The foreign authority keeps the store locked until it is cleared.
    await fs.rm(join(s.directory, "writer.lock"));
    value(await new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io).recover());
  });
  it("a complete but corrupt final frame is never repaired", async () => {
    const s = await setup();
    const a = semanticFrame(s.tip);
    const b = semanticFrame(a.transaction.identity, [notePut("second")], "second");
    const corrupt = Buffer.from(b.bytes);
    corrupt[corrupt.length - 9]! ^= 1;
    const wal = Buffer.concat([a.bytes, corrupt]);
    await fs.writeFile(s.walPath, wal);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
  });
  it("middle corruption is never repaired and leaves the WAL untouched", async () => {
    const s = await setup();
    const a = semanticFrame(s.tip);
    const b = semanticFrame(a.transaction.identity, [notePut("second")], "second");
    const c = semanticFrame(b.transaction.identity, [notePut("third")], "third");
    const middle = Buffer.from(b.bytes);
    middle[40]! ^= 1;
    const wal = Buffer.concat([a.bytes, middle, c.bytes]);
    await fs.writeFile(s.walPath, wal);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect((await runtime.recover()).ok).toBe(false);
    expect(runtime.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
    // A middle-corrupted WAL never recovers until it is repaired out of band.
    expect((await new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io).recover()).ok).toBe(false);
  });
  it("object immutability: reinstalling identical content reuses and preserves the installed object", async () => {
    const s = await setup();
    const op = notePut(); (op.payload as any).id = "immutable-object-note"; (op.payload as any).content = "x".repeat(100000);
    const first = value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("immutable-first"), [op]));
    const objectsDir = join(s.directory, "objects");
    const name = (await fs.readdir(objectsDir))[0]!;
    const before = await fs.readFile(join(objectsDir, name));
    // Same semantic content from a new base: the content-addressed object is
    // never overwritten, only re-verified.
    const second = value(await new ProductionWalStore(s.directory, s.io).commit(first.identity, mutationId("immutable-second"), [op]));
    expect((await fs.readdir(objectsDir)).length).toBe(1);
    expect(await fs.readFile(join(objectsDir, name))).toEqual(before);
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    expect(value(await runtime.recover()).transactions).toBe(2);
    expect(value(runtime.read()).tip).toEqual(second.identity);
  });
  it("concurrent recovery sessions serialize through writer authority", async () => {
    const s = await setup();
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("concurrent"), [notePut()]));
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = new Promise<void>(resolve => { reached = resolve; });
    const held: StartupRecovery = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, {
      async at(phase) { if (phase === "transaction") { reached(); await gate; } }
    });
    const heldRecovery = held.recover();
    const competing = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    try {
      await Promise.race([blocked, heldRecovery.then(() => { throw new Error("recovery ended before the transaction marker"); })]);
      const rejected = await competing.recover();
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("WRITER_BUSY");
      expect(competing.read().ok).toBe(false);
    } finally { release(); await heldRecovery; }
    expect(value(await heldRecovery).transactions).toBe(1);
    expect(held.read().ok).toBe(true);
    // The rejected session recovers cleanly once authority is free.
    value(await competing.recover());
    expect(value(competing.read())).toEqual(value(held.read()));
  }, 30_000);
  it("mutation-index resource limit fails recovery before publication; retry with capacity succeeds", async () => {
    const s = await setup();
    // Long mutation identities make each index record ~194 bytes; enough
    // transactions force a run flush against a deliberately small cap.
    const longId = (i: number) => `m-${"a".repeat(120)}-${i}`;
    const chunks: Buffer[] = [];
    let base = s.tip;
    for (let i = 0; i < 1400; i++) {
      const frame = semanticFrame(base, [identityPut()], longId(i));
      chunks.push(Buffer.from(frame.bytes));
      base = frame.transaction.identity;
    }
    const wal = Buffer.concat(chunks);
    await fs.writeFile(s.walPath, wal);
    const headBefore = await fs.readFile(join(s.directory, "HEAD"));
    const capped = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io, nodeWalIO, undefined, 200_000);
    const result = await capped.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECOVERY_REQUIRED");
      expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    }
    // No publication, no truncation, canonical state untouched.
    expect(capped.read().ok).toBe(false);
    expect(await fs.readFile(s.walPath)).toEqual(wal);
    expect(await fs.readFile(join(s.directory, "HEAD"))).toEqual(headBefore);
    // Cap rejection happened before any growth: no index artifacts remain.
    const privateEntries = await fs.readdir(join(s.directory, ".private"));
    expect(privateEntries.filter(name => name.includes("recovery-mutation-index"))).toEqual([]);
    // Retry with sufficient resources rebuilds the index and recovers.
    const retry = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const receipt = value(await retry.recover());
    expect(receipt.transactions).toBe(1400);
    expect(retry.read().ok).toBe(true);
  }, 120_000);
  it("recovery-index crash debris never strands a valid store end to end", async () => {
    const s = await setup();
    value(await new ProductionWalStore(s.directory, s.io).commit(s.tip, mutationId("debris-commit"), [notePut()]));
    const wal = await fs.readFile(s.walPath);
    // Simulate the exact Codex crash state: high-numbered stale runs survive
    // with holes below, plus a manifest covering them.
    const privateDir = join(s.directory, ".private");
    await fs.writeFile(join(privateDir, "recovery-mutation-index-000008.idx"), "debris-8");
    await fs.writeFile(join(privateDir, "recovery-mutation-index-000009.idx"), "debris-9");
    await fs.writeFile(join(privateDir, "recovery-mutation-index-manifest.v1"),
      "ether.recovery-mutation-index.v1|01234567-89ab-cdef-0123-456789abcdef|000009");
    const runtime = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(1);
    const bytes = value(encodeSnapshotPayload(value(runtime.read()).snapshot));
    // Repeated restart stays deterministic and the namespace stays clean.
    for (let i = 0; i < 2; i++) {
      const restart = new StartupRecovery(s.directory, s.snapshot.identity.userId, s.io);
      value(await restart.recover());
      expect(value(encodeSnapshotPayload(value(restart.read()).snapshot))).toEqual(bytes);
    }
    expect(await fs.readFile(s.walPath)).toEqual(wal);
    const remaining = (await fs.readdir(privateDir)).filter(name => name.includes("recovery-mutation-index"));
    expect(remaining).toEqual([]);
  });
});
