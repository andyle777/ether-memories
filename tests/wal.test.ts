import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "../src/utils/result.js";
import { parseTransactionSequenceId } from "../src/utils/durablePersistence.js";
import { fixture, value } from "./helpers/persistence.js";
import { canonicalJson, type JsonObject } from "../src/persistence/walJson.js";
import { createReplayRegistry, type ReplayOperationDefinition } from "../src/persistence/walOperations.js";
import { checkpointWalAnchor, decodeWalFrame, encodeWalFrame, scanWal, WAL_LIMITS, WAL_PREFIX_BYTES,
  type WalTransactionInput } from "../src/persistence/wal.js";
import { replayWal } from "../src/persistence/walReplay.js";
import type { CommittedTip } from "../src/types/persistence.js";
import type { MutationId } from "../src/types/persistence.js";

const head = fixture().head;
const definition: ReplayOperationDefinition = {
  type: "test.append", version: "1",
  validate: payload => Object.keys(payload).sort().join(",") === "at,id,text"
    && ["at", "id", "text"].every(key => typeof payload[key] === "string") ? ok(undefined) : err("PERSISTENCE_CORRUPTION", "Invalid test payload."),
  reduce: (state, payload) => ok({ ...state, text: String(state.text) + payload.text, lastId: payload.id!, lastAt: payload.at! })
};
const registry = value(createReplayRegistry([definition, { type: "test.json", version: "1", validate: () => ok(undefined), reduce: state => ok(state) }]));
const operation = (text = "A") => ({ type: "test.append", version: "1", payload: { text, id: "already-assigned-id", at: "2000-01-01T00:00:00.000Z" } });
const input = (base: CommittedTip = head.checkpoint.tip): WalTransactionInput => ({
  storeId: head.storeId, format: { format: "ether.wal", version: "1" }, expectedBase: base,
  identity: { epochId: base.epochId, txId: value(parseTransactionSequenceId((BigInt(base.txId) + 1n).toString())) },
  mutation: { mutationId: "caller-command-a" as MutationId, digest: "b".repeat(64) },
  operations: [operation("A"), operation("B")], audit: null
});
const encoded = (base?: CommittedTip) => value(encodeWalFrame(input(base), registry));
const corrupt = { ok: false, error: { code: "PERSISTENCE_CORRUPTION" } };
const unsupported = { ok: false, error: { code: "UNSUPPORTED_PERSISTENCE_FORMAT" } };
const json = (object: unknown) => Buffer.from(value(canonicalJson(object, { bytes: WAL_LIMITS.frameBytes, depth: 64, nodes: 65536 })));
function parts(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  const end = WAL_PREFIX_BYTES + data.readUInt32BE(8);
  return { header: JSON.parse(data.subarray(WAL_PREFIX_BYTES, end).toString()), operations: JSON.parse(data.subarray(end, end + data.readUInt32BE(12)).toString()) };
}
// Independently assemble malicious frames with a correct checksum to reach semantic/canonical checks.
function frame(header: Uint8Array, operations: Uint8Array) {
  const prefix = Buffer.from(encoded().bytes).subarray(0, WAL_PREFIX_BYTES);
  prefix.writeUInt32BE(header.length, 8);
  prefix.writeUInt32BE(operations.length, 12);
  const total = WAL_PREFIX_BYTES + header.length + operations.length + 40;
  prefix.writeUInt32BE(total, 16);
  prefix.writeUInt32BE((~total) >>> 0, 20);
  const end = Buffer.from("EWALDONE");
  const digest = createHash("sha256").update(Buffer.from("ether.wal/1\0")).update(prefix).update(header).update(operations).update(end).digest();
  return Buffer.concat([prefix, header, operations, digest, end]);
}
function changed(change: (header: Record<string, any>, operations: any[]) => void) {
  const { header, operations } = parts(encoded().bytes);
  change(header, operations);
  return frame(json(header), json(operations));
}

describe("bounded WAL v1 framing and chain validation", () => {
  it("has deterministic bytes, exact decode parity and a precisely bound digest", () => {
    const first = encoded();
    const request = input();
    const reordered = { ...request, operations: request.operations.map(op => ({ ...op, payload: Object.fromEntries(Object.entries(op.payload).reverse()) })) };
    expect(value(encodeWalFrame(reordered, registry)).bytes).toEqual(first.bytes);
    expect(value(decodeWalFrame(first.bytes, registry))).toEqual(first.transaction);
    const data = Buffer.from(first.bytes);
    const expected = createHash("sha256").update(Buffer.from("ether.wal/1\0")).update(data.subarray(0, data.length - 40)).update(Buffer.from("EWALDONE")).digest("hex");
    expect(first.transaction.identity.digest).toBe(expected);
    expect(Object.isFrozen(first.transaction.operations[0]!.payload)).toBe(true);
  });

  it("chains exactly from the checkpoint anchor, including empty WAL and large decimal IDs", () => {
    expect(value(checkpointWalAnchor(head))).toEqual(head.checkpoint.tip);
    expect(value(scanWal(Buffer.alloc(0), head, registry))).toMatchObject({ tip: head.checkpoint.tip, transactions: [], tail: "none" });
    const first = encoded();
    expect(first.transaction.identity.txId).toBe("9007199254740994");
    expect(first.transaction.expectedBase).toEqual(head.checkpoint.tip);
    expect(value(scanWal(first.bytes, head, registry)).tip).toEqual(first.transaction.identity);
    const hugeHead = fixture("9".repeat(127)).head;
    const huge = encoded(hugeHead.checkpoint.tip);
    expect(huge.transaction.identity.txId).toBe("1" + "0".repeat(127));
    expect(scanWal(huge.bytes, hugeHead, registry).ok).toBe(true);
    expect(encodeWalFrame(input(fixture("9".repeat(128)).head.checkpoint.tip), registry)).toMatchObject(corrupt);
  });

  it("persists logical mutation identity separately and binds it into transaction identity", () => {
    const first = encoded();
    expect(first.transaction.mutation).toEqual(input().mutation);
    const altered = value(encodeWalFrame({ ...input(), mutation: { ...input().mutation, digest: "c".repeat(64) } }, registry));
    expect(altered.transaction.mutation.mutationId).toBe(first.transaction.mutation.mutationId);
    expect(altered.transaction.identity.digest).not.toBe(first.transaction.identity.digest);
  });

  it("binds operation order, payloads, versions, store and epoch into the transaction hash", () => {
    const first = encoded();
    const reverse = value(encodeWalFrame({ ...input(), operations: [...input().operations].reverse() }, registry));
    expect(reverse.transaction.identity.digest).not.toBe(first.transaction.identity.digest);
    expect(value(replayWal(first.bytes, head, { text: "" }, registry)).state.text).toBe("AB");
    expect(value(replayWal(reverse.bytes, head, { text: "" }, registry)).state.text).toBe("BA");
    const reordered = Buffer.from(reverse.bytes);
    Buffer.from(first.transaction.identity.digest, "hex").copy(reordered, reordered.length - 40);
    expect(decodeWalFrame(reordered, registry)).toMatchObject(corrupt);
    for (const alteration of [
      { ...input(), storeId: "store-b" },
      { ...input(), expectedBase: { ...input().expectedBase, digest: "c".repeat(64) } },
      { ...input(), expectedBase: { ...input().expectedBase, epochId: "epoch-b" }, identity: { ...input().identity, epochId: "epoch-b" } }
    ]) {
      const result = value(encodeWalFrame(alteration, registry));
      expect(result.transaction.identity.digest).not.toBe(first.transaction.identity.digest);
      expect(scanWal(result.bytes, head, registry)).toMatchObject(corrupt);
    }
  });

  it("scans concatenated frames and recognizes only adjacent byte-identical duplicates", () => {
    const first = encoded();
    const second = encoded(first.transaction.identity);
    const scan = value(scanWal(Buffer.concat([first.bytes, first.bytes, second.bytes, second.bytes]), head, registry));
    expect(scan.transactions).toHaveLength(2);
    expect(scan.duplicates).toBe(2);
    expect(scan.tip).toEqual(second.transaction.identity);
    expect(value(replayWal(Buffer.concat([first.bytes, first.bytes, second.bytes]), head, { text: "" }, registry)).state.text).toBe("ABAB");
    expect(scanWal(Buffer.concat([first.bytes, second.bytes, first.bytes]), head, registry)).toMatchObject(corrupt);
    const fork = value(encodeWalFrame({ ...input(), operations: [operation("different")] }, registry));
    expect(fork.transaction.identity.txId).toBe(first.transaction.identity.txId);
    expect(scanWal(Buffer.concat([first.bytes, fork.bytes]), head, registry)).toMatchObject(corrupt);
  });

  it("recognizes every truncated final-frame prefix without advancing committed history", () => {
    const first = encoded();
    const second = encoded(first.transaction.identity);
    for (let end = 1; end < second.bytes.length; end++) {
      const scan = value(scanWal(Buffer.concat([first.bytes, second.bytes.subarray(0, end)]), head, registry));
      expect(scan.tail).toBe("incomplete");
      expect(scan.tip).toEqual(first.transaction.identity);
      expect(scan.completeBytes).toBe(first.bytes.length);
      expect(scan.transactions).toHaveLength(1);
      expect(decodeWalFrame(second.bytes.subarray(0, end), registry)).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    }
  });

  it("fails closed on middle corruption and on a truncated frame followed by another frame", () => {
    const first = encoded();
    const second = encoded(first.transaction.identity);
    for (const end of [1, 12, 25, 100, first.bytes.length - 41, first.bytes.length - 1]) {
      expect(scanWal(Buffer.concat([first.bytes.subarray(0, end), second.bytes]), head, registry)).toMatchObject(corrupt);
    }
    const damaged = Buffer.from(first.bytes);
    damaged[damaged.length - 40] ^= 1;
    expect(scanWal(Buffer.concat([damaged, second.bytes]), head, registry)).toMatchObject(corrupt);
    expect(scanWal(Buffer.concat([first.bytes, Buffer.from("garbage")]), head, registry)).toMatchObject(corrupt);
    expect(decodeWalFrame(Buffer.concat([first.bytes, second.bytes]), registry)).toMatchObject(corrupt);
  });

  it.each(["metadata-oversize", "operations-oversize", "frame-oversize", "undersize", "complement"])("rejects declared length attack %s", kind => {
    const bytes = Buffer.from(encoded().bytes);
    if (kind === "metadata-oversize") bytes.writeUInt32BE(0xffffffff, 8);
    if (kind === "operations-oversize") bytes.writeUInt32BE(0xffffffff, 12);
    if (kind === "frame-oversize") bytes.writeUInt32BE(0xffffffff, 16);
    if (kind === "undersize") bytes.writeUInt32BE(bytes.readUInt32BE(8) - 1, 8);
    if (kind === "complement") bytes[23] ^= 1;
    expect(decodeWalFrame(bytes, registry)).toMatchObject(corrupt);
    expect(scanWal(bytes, head, registry)).toMatchObject(corrupt);
  });

  it.each(["wal-version", "operation-version", "operation-type"])("fails closed on unknown %s", kind => {
    const bytes = changed((header, operations) => {
      if (kind === "wal-version") header.version = "2";
      if (kind === "operation-version") operations[0].version = "2";
      if (kind === "operation-type") operations[0].type = "test.unknown";
    });
    expect(decodeWalFrame(bytes, registry)).toMatchObject(unsupported);
    expect(scanWal(bytes, head, registry)).toMatchObject(unsupported);
    expect(decodeWalFrame(encoded().bytes, value(createReplayRegistry()))).toMatchObject(unsupported);
  });

  it.each(["numeric-tx", "leading-zero", "tx-overflow", "cross-epoch", "mutation-id", "mutation-digest", "unknown-field", "audit", "count", "payload-shape"])("rejects invalid committed metadata %s", kind => {
    const bytes = changed((header, operations) => {
      if (kind === "numeric-tx") header.txId = 1;
      if (kind === "leading-zero") header.txId = "09007199254740994";
      if (kind === "tx-overflow") header.txId = "9".repeat(129);
      if (kind === "cross-epoch") header.epochId = "epoch-b";
      if (kind === "mutation-id") header.mutation.mutationId = "a".repeat(129);
      if (kind === "mutation-digest") header.mutation.digest = "A".repeat(64);
      if (kind === "unknown-field") header.extra = true;
      if (kind === "audit") header.audit = {};
      if (kind === "count") header.operationCount = 129;
      if (kind === "payload-shape") operations[0].payload = [];
    });
    expect(decodeWalFrame(bytes, registry)).toMatchObject(corrupt);
  });

  it("rejects malformed UTF-8, duplicate fields, noncanonical encodings and forbidden operation fields even with recomputed hashes", () => {
    const { header, operations } = parts(encoded().bytes);
    const canonicalHeader = json(header);
    const canonicalOperations = json(operations);
    const variants = [
      frame(Buffer.from([0xff]), canonicalOperations),
      frame(Buffer.from(" " + canonicalHeader.toString()), canonicalOperations),
      frame(Buffer.from(canonicalHeader.toString().replace('"version":"1"', '"version":"1","version":"1"')), canonicalOperations),
      frame(Buffer.from(canonicalHeader.toString().replace('"txId":"9007199254740994"', '"txId":9007199254740994')), canonicalOperations),
      frame(canonicalHeader, Buffer.from(canonicalOperations.toString().replace('"text":"A"', '"text":"\\u0041"'))),
      frame(canonicalHeader, Buffer.from(canonicalOperations.toString().replace('"text":"A"', '"text":"B","text":"A"'))),
      frame(canonicalHeader, Buffer.from(canonicalOperations.toString().replace('"text":"A"', '"text":"A","unknown":1'))),
      frame(canonicalHeader, Buffer.from([0xc0, 0x80])),
      changed((_header, ops) => { ops[0].extra = true; })
    ];
    for (const bytes of variants) expect(decodeWalFrame(bytes, registry)).toMatchObject(corrupt);
  });

  it("bounds individual and aggregate payloads, depth, operation count and identifiers", () => {
    const base = input();
    for (const operations of [
      [operation("x".repeat(WAL_LIMITS.payloadBytes))],
      Array.from({ length: 9 }, () => operation("x".repeat(60 * 1024))),
      Array.from({ length: 129 }, () => operation()),
      [{ ...operation(), type: "x".repeat(65) }],
      [{ ...operation(), version: "1".repeat(17) }]
    ]) expect(encodeWalFrame({ ...base, operations }, registry)).toMatchObject(corrupt);
    let nested: JsonObject = {};
    for (let i = 0; i < 20; i++) nested = { child: nested };
    expect(encodeWalFrame({ ...base, operations: [{ type: "test.json", version: "1", payload: nested }] }, registry)).toMatchObject(corrupt);
    const tooMany = changed((header, ops) => { header.operationCount = 128; ops.push(...Array.from({ length: 127 }, () => operation())); });
    expect(decodeWalFrame(tooMany, registry)).toMatchObject(corrupt);
    expect(scanWal(Buffer.alloc(WAL_LIMITS.streamBytes + 1), head, registry)).toMatchObject(corrupt);
    const first = encoded();
    expect(scanWal(Buffer.concat(Array.from({ length: WAL_LIMITS.frames + 1 }, () => first.bytes)), head, registry)).toMatchObject(corrupt);
  });

  it("does not accept two logical contents or two byte representations as one transaction identity", () => {
    const original = encoded();
    const baseHash = original.transaction.identity.digest;
    for (let i = 0; i < 200; i++) {
      const other = value(encodeWalFrame({ ...input(), operations: [operation(String(i))] }, registry));
      expect(other.transaction.identity.digest).not.toBe(baseHash);
      const spoofed = Buffer.from(other.bytes);
      Buffer.from(baseHash, "hex").copy(spoofed, spoofed.length - 40);
      expect(decodeWalFrame(spoofed, registry)).toMatchObject(corrupt);
    }
    const { header, operations } = parts(original.bytes);
    const changedEncoding = frame(Buffer.from(JSON.stringify(header, null, 1)), json(operations));
    expect(decodeWalFrame(changedEncoding, registry)).toMatchObject(corrupt);
  });


  it("rejects decoder-side payload, aggregate and nesting attacks with otherwise valid checksums", () => {
    const oversizePayload = changed((_header, operations) => { operations[0].payload.text = "x".repeat(64 * 1024); });
    const aggregate = changed((header, operations) => {
      operations.splice(0, operations.length, ...Array.from({ length: 9 }, () => operation("x".repeat(60 * 1024))));
      header.operationCount = operations.length;
    });
    const { operations } = parts(encoded().bytes);
    const excessiveHeader = frame(Buffer.alloc(WAL_LIMITS.metadataBytes + 1, 32), json(operations));
    const nestedHeader = frame(Buffer.from("[".repeat(20) + "]".repeat(20)), json(operations));
    for (const bytes of [oversizePayload, aggregate, excessiveHeader, nestedHeader]) expect(decodeWalFrame(bytes, registry)).toMatchObject(corrupt);
  });

  it("rejects hidden array fields and alternate numeric/Unicode spellings", () => {
    const hidden = Object.defineProperty([1], "extra", { value: "hidden" });
    expect(canonicalJson({ hidden }, { bytes: 1024, depth: 16, nodes: 100 })).toMatchObject(corrupt);
    const hiddenOperations = Object.defineProperty([operation()], "extra", { value: "hidden" });
    expect(encodeWalFrame({ ...input(), operations: hiddenOperations }, registry)).toMatchObject(corrupt);
    const getter = vi.fn(() => operation().payload);
    const accessorOperation = Object.defineProperty({ ...operation() }, "payload", { get: getter, enumerable: true });
    expect(encodeWalFrame({ ...input(), operations: [accessorOperation] }, registry)).toMatchObject(corrupt);
    expect(getter).not.toHaveBeenCalled();
    const { header } = parts(encoded().bytes);
    header.operationCount = 1;
    for (const payload of ['{"n":1e0}', '{"n":-0}', '{"n":9007199254740993}', '{"text":"\\u0041"}']) {
      const raw = Buffer.from('[{"payload":' + payload + ',"type":"test.json","version":"1"}]');
      expect(decodeWalFrame(frame(json(header), raw), registry)).toMatchObject(corrupt);
    }
    expect(Buffer.from(value(canonicalJson({ "2": 2, "10": 10 }, { bytes: 1024, depth: 16, nodes: 100 }))).toString()).toBe('{"10":10,"2":2}');
  });

  it("owns scan bytes so caller mutation cannot alter later validation or duplicate recognition", () => {
    const first = encoded();
    const second = encoded(first.transaction.identity);
    const source = Buffer.concat([first.bytes, second.bytes]);
    const mutatesSource = value(createReplayRegistry([{ ...definition, validate: payload => {
      source.fill(0);
      return definition.validate(payload);
    } }]));
    expect(value(scanWal(source, head, mutatesSource)).transactions).toHaveLength(2);
  });

  it("rejects every single-byte corruption without accepting a different transaction under its original identity", () => {
    const original = encoded();
    for (let i = 0; i < original.bytes.length; i++) {
      const bytes = Buffer.from(original.bytes);
      bytes[i] ^= 1;
      expect(decodeWalFrame(bytes, registry).ok, "mutated byte " + i).toBe(false);
    }
  });

  it("rejects non-JSON payloads without invoking accessors or allocating from claimed lengths", () => {
    const getter = vi.fn(() => "bad");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const payload of [{ value: 1n }, { value: NaN }, { value: -0 }, { value: 9007199254740992 },
      { value: undefined }, { value: () => "callback" }, { value: new Date() }, { value: "\ud800" }, accessor, cycle]) {
      expect(encodeWalFrame({ ...input(), operations: [{ type: "test.json", version: "1", payload }] }, registry)).toMatchObject(corrupt);
    }
    expect(getter).not.toHaveBeenCalled();
    const declared = Buffer.from(encoded().bytes).subarray(0, 12);
    declared.writeUInt32BE(0xffffffff, 8);
    expect(decodeWalFrame(declared, registry)).toMatchObject(corrupt);
  });
});

describe("detached deterministic WAL replay", () => {
  it("uses only committed values and exposes immutable detached state", () => {
    const first = encoded();
    const original = { text: "", nested: { value: 1 } };
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock"); });
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("random"); });
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("uuid"); });
    try {
      const a = value(replayWal(first.bytes, head, original, registry));
      const b = value(replayWal(first.bytes, head, original, registry));
      expect(a).toEqual(b);
      expect(a.state).toMatchObject({ text: "AB", lastId: "already-assigned-id", lastAt: "2000-01-01T00:00:00.000Z" });
      expect(original).toEqual({ text: "", nested: { value: 1 } });
      expect(a.state).not.toBe(original);
      expect(Object.isFrozen(a.state.nested)).toBe(true);
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); uuid.mockRestore(); }
  });

  it("validates the entire batch before any reducer runs and never skips unknown operations", () => {
    const reduce = vi.fn(definition.reduce);
    const tracked = value(createReplayRegistry([{ ...definition, reduce }]));
    const first = encoded();
    const second = encoded(first.transaction.identity);
    const corruptSecond = Buffer.from(second.bytes);
    corruptSecond[corruptSecond.length - 1] ^= 1;
    expect(replayWal(Buffer.concat([first.bytes, corruptSecond]), head, { text: "" }, tracked)).toMatchObject(corrupt);
    const unknown = changed((_header, operations) => { operations[1].version = "2"; });
    expect(replayWal(unknown, head, { text: "" }, tracked)).toMatchObject(unsupported);
    expect(reduce).not.toHaveBeenCalled();
  });

  it("does not publish partial state after reducer failure or permit mutation of caller state", () => {
    const broken = value(createReplayRegistry([{ ...definition, reduce: (state, payload) =>
      payload.text === "B" ? err("PERSISTENCE_CORRUPTION", "test failure") : definition.reduce(state, payload) }]));
    const original = { text: "" };
    expect(replayWal(encoded().bytes, head, original, broken)).toMatchObject(corrupt);
    expect(original.text).toBe("");
    const mutating = value(createReplayRegistry([{ ...definition, reduce: state => {
      (state as Record<string, unknown>).text = "mutated";
      return ok(state);
    } }]));
    expect(replayWal(encoded().bytes, head, original, mutating)).toMatchObject(corrupt);
    expect(original.text).toBe("");
  });

  it("rejects duplicate registry versions and snapshots definitions without installing test operations globally", () => {
    expect(createReplayRegistry([definition, definition])).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const mutable = { ...definition };
    const stable = value(createReplayRegistry([mutable]));
    mutable.reduce = () => { throw new Error("changed after registration"); };
    expect(replayWal(encoded().bytes, head, { text: "" }, stable).ok).toBe(true);
    expect(replayWal(encoded().bytes, head, { text: "" }, value(createReplayRegistry()))).toMatchObject(unsupported);
  });
});
