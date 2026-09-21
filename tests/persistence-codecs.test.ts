import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_FORMAT, PERSISTENCE_LIMITS, WAL_FORMAT, decodeStoreHead, encodeCheckpoint, encodeStoreHead,
  persistenceLimits, verifyCheckpoint, type PersistedStoreHead } from "../src/index.js";
import { fixture, value } from "./helpers/persistence.js";

const json = (input: unknown) => Buffer.from(JSON.stringify(input), "utf8");
const corruption = { ok: false, error: { code: "PERSISTENCE_CORRUPTION" } };

describe("bounded durable persistence codecs", () => {
  it("encodes fixed HEAD field order independently of every input object's insertion order", () => {
    const { head } = fixture();
    const reverse = (object: object) => Object.fromEntries(Object.entries(object).reverse());
    const reordered = reverse({ ...head, checkpoint: reverse({ ...head.checkpoint, tip: reverse(head.checkpoint.tip) }), walFormat: reverse(head.walFormat) });
    const encoded = value(encodeStoreHead(head));
    expect(value(encodeStoreHead(reordered as unknown as PersistedStoreHead))).toEqual(encoded);
    expect(value(decodeStoreHead(encoded))).toEqual(head);
    expect(value(encodeStoreHead(value(decodeStoreHead(encoded))))).toEqual(encoded);
    expect(Buffer.from(encoded).toString()).toBe('{"format":"ether.store_head","version":"1","storeId":"store-a","epochId":"epoch-a","schemaVersion":"ether.memory_store.v0.3","digestAlgorithm":"sha256","checkpoint":{"checkpointId":"checkpoint-a","digest":"' + head.checkpoint.digest + '","tip":{"epochId":"epoch-a","txId":"9007199254740993","digest":"' + "a".repeat(64) + '"}},"walFormat":{"format":"ether.wal","version":"1"}}');
  });

  it("preserves exact transaction decimals up to the digit limit without number conversion", () => {
    for (const txId of ["0", "9007199254740992", "9007199254740993", "18446744073709551616", "9".repeat(PERSISTENCE_LIMITS.transactionDigits)]) {
      const { head, checkpointBytes } = fixture(txId);
      expect(value(decodeStoreHead(value(encodeStoreHead(head)))).checkpoint.tip.txId).toBe(txId);
      expect(verifyCheckpoint(checkpointBytes, head).ok).toBe(true);
    }
  });

  it.each(["../a", "a/b", "a\\b", "a:b", "A", "a.", "a\n", "a\r", "a ", "\u00e9", "", "a".repeat(65)])("rejects unsafe identifier %j", storeId => {
    const head = { ...fixture().head, storeId };
    expect(encodeStoreHead(head)).toMatchObject(corruption);
    expect(decodeStoreHead(json(head))).toMatchObject(corruption);
  });

  it.each([0, 9007199254740992, "", "00", "01", "1.0", "1e2", "-1", "1\n", "9".repeat(129)])("rejects malformed or excessive transaction ID %j", txId => {
    const { head } = fixture();
    expect(decodeStoreHead(json({ ...head, checkpoint: { ...head.checkpoint, tip: { ...head.checkpoint.tip, txId } } }))).toMatchObject(corruption);
  });

  it("rejects unknown fields, wrong shapes, bad digests, and cross-epoch authority", () => {
    const { head } = fixture();
    for (const malformed of [null, [], 1, {}, { ...head, tip: head.checkpoint.tip }, { ...head, checkpoint: [] },
      { ...head, epochId: "epoch-b" }, { ...head, checkpoint: { ...head.checkpoint, digest: "A".repeat(64) } },
      { ...head, checkpoint: { ...head.checkpoint, digest: "a".repeat(64) + "\n" } },
      { ...head, checkpoint: { ...head.checkpoint, extra: true } }, { ...head, walFormat: { ...head.walFormat, optional: true } }]) {
      expect(decodeStoreHead(json(malformed))).toMatchObject(corruption);
    }
  });

  it.each([ { format: "future.head" }, { version: "2" }, { schemaVersion: "ether.memory_store.v99" },
    { digestAlgorithm: "future" }, { walFormat: { format: WAL_FORMAT, version: "2" } } ])("distinguishes unsupported required versions %j", change => {
    expect(decodeStoreHead(json({ ...fixture().head, ...change }))).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PERSISTENCE_FORMAT" } });
  });

  it("rejects duplicate keys, noncanonical JSON, invalid UTF-8 and nesting before accepting authority", () => {
    const bytes = Buffer.from(value(encodeStoreHead(fixture().head)));
    for (const malformed of [Buffer.concat([Buffer.from(" "), bytes]),
      Buffer.from(bytes.toString().replace('"version":"1"', '"version":"2","version":"1"')),
      Buffer.from(bytes.toString().replace('"store-a"', '"store-\\u0061"')),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), Buffer.from([0xc0, 0x80]),
      Buffer.from("[".repeat(9) + "]".repeat(9)), Buffer.from("{"), Buffer.alloc(PERSISTENCE_LIMITS.headBytes + 1)]) {
      expect(decodeStoreHead(malformed)).toMatchObject(corruption);
    }
  });

  it("hashes the original framed checkpoint bytes, including payload whitespace", () => {
    const { head, checkpointBytes, payload } = fixture();
    expect(head.checkpoint.digest).toBe(createHash("sha256").update(checkpointBytes).digest("hex"));
    expect(verifyCheckpoint(checkpointBytes, head)).toEqual({ ok: true, value: undefined });
    const bytes = Buffer.from(checkpointBytes);
    const separator = bytes.indexOf(10);
    expect(JSON.parse(bytes.subarray(0, separator).toString()).format).toBe(CHECKPOINT_FORMAT);
    expect(bytes.subarray(separator + 1)).toEqual(payload);
    bytes[bytes.length - 2] = 32;
    expect(verifyCheckpoint(bytes, head)).toMatchObject(corruption);
    const normalized = value(encodeCheckpoint({ storeId: head.storeId, checkpointId: head.checkpoint.checkpointId, tip: head.checkpoint.tip }, json(JSON.parse(payload.toString()))));
    expect(normalized.identity.digest).not.toBe(head.checkpoint.digest);
  });

  it("rejects malformed lengths and headers, unsupported checkpoint versions, and mismatched identities", () => {
    const { head, checkpointBytes } = fixture();
    const bytes = Buffer.from(checkpointBytes);
    const newline = bytes.indexOf(10);
    const header = JSON.parse(bytes.subarray(0, newline).toString());
    const replace = (changes: object) => Buffer.concat([json({ ...header, ...changes }), Buffer.from([10]), bytes.subarray(newline + 1)]);
    for (const length of [-1, 0, 0.5, "12", 1e20, header.payloadBytes + 1]) expect(verifyCheckpoint(replace({ payloadBytes: length }), head)).toMatchObject(corruption);
    for (const change of [{ storeId: "other" }, { checkpointId: "other" }, { tip: { ...head.checkpoint.tip, txId: "1" } }, { extra: true }]) {
      expect(verifyCheckpoint(replace(change), head)).toMatchObject(corruption);
    }
    expect(verifyCheckpoint(replace({ version: "2" }), head)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PERSISTENCE_FORMAT" } });
    expect(verifyCheckpoint(bytes.subarray(0, bytes.length - 1), head)).toMatchObject(corruption);
    expect(verifyCheckpoint(Buffer.from("x".repeat(4097)), head)).toMatchObject(corruption);
    expect(verifyCheckpoint(Buffer.concat([bytes, Buffer.from("trailing")]), head)).toMatchObject(corruption);
  });

  it("enforces configurable bounds without allowing format limits or prototype keys to bypass them", () => {
    const { head, checkpointBytes, payload } = fixture();
    const encoded = value(encodeStoreHead(head));
    expect(encodeStoreHead(head, { headBytes: encoded.byteLength }).ok).toBe(true);
    expect(decodeStoreHead(encoded, { headBytes: encoded.byteLength - 1 })).toMatchObject(corruption);
    expect(encodeStoreHead(head, { identifierBytes: 3 })).toMatchObject(corruption);
    expect(decodeStoreHead(encoded, { metadataDepth: 2 })).toMatchObject(corruption);
    expect(encodeStoreHead(head, { metadataDepth: 2 })).toMatchObject(corruption);
    expect(encodeCheckpoint({ storeId: "store-a", checkpointId: "checkpoint-a", tip: head.checkpoint.tip }, payload, { checkpointPayloadBytes: payload.byteLength - 1 })).toMatchObject(corruption);
    expect(verifyCheckpoint(checkpointBytes, head, { checkpointHeaderBytes: 4 })).toMatchObject(corruption);
    expect(encodeCheckpoint({ storeId: "store-a", checkpointId: "checkpoint-a", tip: head.checkpoint.tip }, payload, { metadataDepth: 1 })).toMatchObject(corruption);
    for (const options of [{ headBytes: 0 }, { headBytes: 1.5 }, { headBytes: Infinity }, { headBytes: 16385 }, JSON.parse('{"__proto__":1}')]) {
      expect(persistenceLimits(options)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });
});
