import { describe, it, expect } from "vitest";
import { encodeEtherData, decodeEtherData, MAX_ETHER_DATA_BYTES } from "../src/persistence/etherData.js";
import { encodeSnapshotPayload, decodeLegacySnapshotPayload, decodeSnapshotPayload } from "../src/persistence/snapshotPayload.js";
import { canonicalJson } from "../src/persistence/walJson.js";
import { value } from "./helpers/persistence.js";
import { readFileSync } from "node:fs";

const cases: unknown[] = [null, true, false, 0, -0, 1e20, 1e21, -1e21, 0.1, 1e-100, Number.MAX_VALUE, Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "", "ordinary", "\u4e2d\u6587", "\ud83d\ude00", "\ud800", "\udc00", "\n\u0000",
  [], [[], [null, true]], {}, { z: { a: 1 } }, JSON.parse('{"constructor":{"prototype":{"polluted":true}},"__proto__":{"polluted":true}}'),
  { "\ud800": ["\udc00", "x\ud800y"] }];
describe("production Ether data domain", () => {
  it.each(cases.map((x, i) => [i, x] as const))("preserves persisted JSON case %s", (_i, original) => {
    const encoded = value(encodeEtherData(original));
    const decoded = value(decodeEtherData(encoded));
    expect(decoded).toEqual(JSON.parse(JSON.stringify(original)));
    expect(value(encodeEtherData(decoded))).toEqual(encoded);
    if (Object.is(original, -0)) expect(Object.is(decoded, 0)).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    if (decoded && !Array.isArray(decoded) && typeof decoded === "object") expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });
  it("sorts UTF-16 keys and keeps dangerous names as own data", () => {
    const a = JSON.parse('{"z":1,"__proto__":{"polluted":true},"constructor":2}');
    const b = JSON.parse('{"constructor":2,"__proto__":{"polluted":true},"z":1}');
    expect(value(encodeEtherData(a))).toEqual(value(encodeEtherData(b)));
    const result = value(decodeEtherData(value(encodeEtherData(a)))) as any;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
  });
  it("rejects non-persisted JS without invoking accessors", () => {
    let calls = 0;
    const accessor = { get x() { calls++; return 1; } };
    const cycle: any = {}; cycle.x = cycle;
    for (const v of [undefined, Array(2), NaN, Infinity, -Infinity, 1n, new Date(), Symbol(), () => 1, accessor, cycle,
      { [Symbol()]: 1 }, { x: undefined }]) expect(encodeEtherData(v).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("uses exact byte bounds and does not widen WAL JSON", () => {
    expect(value(encodeEtherData("x".repeat(MAX_ETHER_DATA_BYTES - 2))).length).toBe(MAX_ETHER_DATA_BYTES);
    expect(encodeEtherData("x".repeat(MAX_ETHER_DATA_BYTES - 1)).ok).toBe(false);
    expect(canonicalJson({ value: 1e20 }, { bytes: 1024, depth: 8, nodes: 100 }).ok).toBe(false);
  });
  it("has deterministic seeded roundtrips", () => {
    let seed = 314159;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const generate = (depth: number): unknown => {
      if (!depth || next() % 3 === 0) return cases[next() % cases.length];
      return next() % 2 ? [generate(depth - 1), generate(depth - 1)]
        : Object.fromEntries([["__proto__", generate(depth - 1)], ["\ud800", generate(depth - 1)], ["safe", generate(depth - 1)]]);
    };
    for (let i = 0; i < 200; i++) {
      const original = generate(3), encoded = value(encodeEtherData(original));
      expect(value(decodeEtherData(encoded))).toEqual(JSON.parse(JSON.stringify(original)));
      expect(value(encodeEtherData(value(decodeEtherData(encoded))))).toEqual(encoded);
    }
  });
  it("accepts historical indentation and canonicalizes snapshot values", () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/store-v0.3.json", import.meta.url), "utf8"));
    for (const metadata of cases.filter(x => x && typeof x === "object" && !Array.isArray(x))) {
      raw.memoryNotes[0].metadata = metadata;
      // Historical plain v0.3 payloads use the explicit legacy decode path.
      const a = value(decodeLegacySnapshotPayload(Buffer.from(JSON.stringify(raw)), raw.identity.userId));
      const b = value(decodeLegacySnapshotPayload(Buffer.from(JSON.stringify(raw, null, 2)), raw.identity.userId));
      expect(value(encodeSnapshotPayload(a))).toEqual(value(encodeSnapshotPayload(b)));
      // Production payloads roundtrip through the production decode path.
      expect(value(encodeSnapshotPayload(value(decodeSnapshotPayload(value(encodeSnapshotPayload(a)), raw.identity.userId)))))
        .toEqual(value(encodeSnapshotPayload(a)));
    }
  });
});
