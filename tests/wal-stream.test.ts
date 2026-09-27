import { describe, expect, it } from "vitest";
import { WalStreamScanner } from "../src/persistence/walStream.js";
import { WAL_LIMITS } from "../src/persistence/wal.js";
import { fixture, value } from "./helpers/persistence.js";
import { frame, history, registry, request } from "./helpers/wal.js";

const scanner = () => value(WalStreamScanner.create(fixture().head, registry));
const recovery = { ok: false, error: { code: "RECOVERY_REQUIRED" } };
const corruption = { ok: false, error: { code: "PERSISTENCE_CORRUPTION" } };

describe("resumable WAL scanner", () => {
  it.each([1, 12, 24, 25, 100, -41, -35, -5, 0])("resumes at frame region boundary %s", boundary => {
    const h = history(3);
    const size = h.frames[0]!.bytes.length;
    const split = boundary === 0 ? size : boundary < 0 ? size + boundary : boundary;
    const s = scanner();
    const first = value(s.next(s.cursor(), h.bytes.subarray(0, split)));
    const last = value(s.next(first.continuation, h.bytes.subarray(split), true));
    expect(last.continuation).toMatchObject({ offset: h.bytes.length, completeBytes: h.bytes.length, tip: h.tip, ended: true, tail: "none" });
    expect(first.transactions.length + last.transactions.length).toBe(3);
  });

  it("accepts empty EOF only once, anchored to the checkpoint", () => {
    const s = scanner();
    const result = value(s.next(s.cursor(), new Uint8Array(), true));
    expect(result.continuation.tip).toEqual(fixture().head.checkpoint.tip);
    expect(s.next(result.continuation, new Uint8Array(), true)).toMatchObject(recovery);
  });

  it("processes beyond 8 MiB and 1,024 frames across bounded batches", () => {
    const h = history(1200, "X".repeat(7200));
    expect(h.bytes.length).toBeGreaterThan(WAL_LIMITS.streamBytes);
    const s = scanner();
    let cursor = s.cursor();
    let transactions = 0;
    let calls = 0;
    while (!cursor.ended) {
      const end = Math.min(h.bytes.length, cursor.offset + WAL_LIMITS.streamBytes);
      const result = value(s.next(cursor, h.bytes.subarray(cursor.offset, end), end === h.bytes.length));
      expect(result.transactions.length).toBeLessThanOrEqual(1024);
      transactions += result.transactions.length;
      cursor = result.continuation;
      calls++;
    }
    expect(transactions).toBe(1200);
    expect(calls).toBeGreaterThan(1);
    expect(cursor.tip).toEqual(h.tip);
    expect(cursor.completeBytes).toBe(h.bytes.length);
  }, 30000);

  it("returns exactly 1,024 physical frames then resumes unconsumed input", () => {
    const h = history(1025);
    const s = scanner();
    const first = value(s.next(s.cursor(), h.bytes, true));
    expect(first.transactions).toHaveLength(1024);
    expect(first.continuation.ended).toBe(false);
    expect(first.consumed).toBe(h.bytes.length - h.frames[1024]!.bytes.length);
    const last = value(s.next(first.continuation, h.bytes.subarray(first.consumed), true));
    expect(last.transactions).toHaveLength(1);
    expect(last.continuation.tip).toEqual(h.tip);
  });

  it("preserves duplicate context across byte and batch boundaries without replay twice", () => {
    const f = frame();
    const bytes = Buffer.concat(Array.from({ length: 1026 }, () => f.bytes));
    const s = scanner();
    const first = value(s.next(s.cursor(), bytes, true));
    expect(first.transactions).toHaveLength(1);
    expect(first.duplicates).toBe(1023);
    const second = value(s.next(first.continuation, bytes.subarray(first.consumed), true));
    expect(second.duplicates).toBe(2);
    expect(second.transactions).toHaveLength(0);
    expect(second.continuation.tip).toEqual(f.transaction.identity);
  });

  it("rejects forged, copied, stale and foreign continuation state", () => {
    const a = scanner();
    const b = scanner();
    const original = a.cursor();
    expect(a.next({ ...original }, frame().bytes)).toMatchObject(recovery);
    expect(a.next(b.cursor(), frame().bytes)).toMatchObject(recovery);
    const next = value(a.next(original, frame().bytes)).continuation;
    expect(Object.isFrozen(next)).toBe(true);
    expect(a.next(original, frame().bytes)).toMatchObject(recovery);
    expect(value(a.next(next, new Uint8Array(), true)).continuation.ended).toBe(true);
  });

  it("fails closed on corruption after many chunks, permanently invalidating the session", () => {
    const h = history(20);
    h.bytes[h.bytes.length - 10] ^= 1;
    const s = scanner();
    let cursor = s.cursor();
    while (cursor.offset + 97 < h.bytes.length - 97) cursor = value(s.next(cursor, h.bytes.subarray(cursor.offset, cursor.offset + 97))).continuation;
    expect(s.next(cursor, h.bytes.subarray(cursor.offset), true)).toMatchObject(corruption);
    expect(s.next(cursor, new Uint8Array(), true)).toMatchObject(recovery);
  });

  it("reports partial EOF after many chunks without advancing past the complete prefix", () => {
    const h = history(20);
    const bytes = h.bytes.subarray(0, h.bytes.length - 7);
    const s = scanner();
    let cursor = s.cursor();
    while (!cursor.ended) {
      const end = Math.min(bytes.length, cursor.offset + 31);
      cursor = value(s.next(cursor, bytes.subarray(cursor.offset, end), end === bytes.length)).continuation;
    }
    expect(cursor.tail).toBe("incomplete");
    expect(cursor.tip).toEqual(h.frames[18]!.transaction.identity);
    expect(cursor.completeBytes).toBe(h.bytes.length - h.frames[19]!.bytes.length);
  });

  it("rejects a different transaction with the same sequence across continuations", () => {
    const s = scanner();
    const first = value(s.next(s.cursor(), frame().bytes));
    expect(s.next(first.continuation, frame(request(undefined, "other", "B")).bytes, true)).toMatchObject(corruption);
  });

  it("keeps byte ceilings per call and detects malformed partial prefix at EOF", () => {
    const s = scanner();
    expect(s.next(s.cursor(), new Uint8Array(WAL_LIMITS.streamBytes + 1))).toMatchObject(corruption);
    expect(s.next(s.cursor(), Buffer.from([1]), true)).toMatchObject(corruption);
  });
});
