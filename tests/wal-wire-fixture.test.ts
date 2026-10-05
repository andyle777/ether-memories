import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkpointWalAnchor, decodeWalFrame, encodeWalFrame, scanWal, type WalTransactionInput } from "../src/persistence/wal.js";
import { createReplayRegistry } from "../src/persistence/walOperations.js";
import { err, ok } from "../src/utils/result.js";
import { value } from "./helpers/persistence.js";

describe("frozen AF1 WAL v1 wire fixture", () => {
  it("preserves Phase A bytes, digest, logical transaction and checkpoint anchoring", () => {
    const golden = JSON.parse(readFileSync(new URL("./fixtures/wal-wire-v1.json", import.meta.url), "utf8"));
    expect(golden.sourceCommit).toBe("7584b88422c46c101120ef5eb3e3cfaaa759399f");
    // Test-only operation; expected bytes and identities come only from the historical fixture.
    const registry = value(createReplayRegistry([{ type: "test.set", version: "1",
      validate: payload => typeof payload.text === "string" && Object.keys(payload).length === 1
        ? ok(undefined) : err("PERSISTENCE_CORRUPTION", "Invalid test payload"),
      reduce: (_state, payload) => ok(payload)
    }]));
    const input: WalTransactionInput = golden.input;
    expect(BigInt(input.identity.txId)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(BigInt(input.identity.txId)).toBe(BigInt(input.expectedBase.txId) + 1n);
    expect(input.audit).toBeNull();
    expect(input.expectedBase).toEqual(golden.expectedBase);
    expect(value(checkpointWalAnchor(golden.head))).toEqual(golden.expectedBase);

    const frozen = Buffer.from(golden.frameBase64, "base64");
    expect(frozen.toString("base64")).toBe(golden.frameBase64);
    expect(frozen.byteLength).toBe(golden.byteLength);
    expect(createHash("sha256").update(frozen).digest("hex")).toBe(golden.frameSha256);

    const encoded = value(encodeWalFrame(input, registry));
    expect(Buffer.from(encoded.bytes)).toEqual(frozen);
    expect(encoded.bytes.byteLength).toBe(golden.byteLength);
    expect(createHash("sha256").update(encoded.bytes).digest("hex")).toBe(golden.frameSha256);
    expect(encoded.transaction.identity.digest).toBe(golden.transactionDigest);
    expect(encoded.transaction).toEqual(golden.transaction);

    const decoded = value(decodeWalFrame(frozen, registry));
    expect(decoded).toEqual(golden.transaction);
    expect(decoded).toEqual({ ...input, identity: { ...input.identity, digest: golden.transactionDigest } });
    expect(decoded.expectedBase).toEqual(golden.expectedBase);
    expect(value(scanWal(frozen, golden.head, registry))).toEqual({
      transactions: [golden.transaction], tip: golden.transaction.identity,
      duplicates: 0, completeBytes: golden.byteLength, tail: "none", tailBytes: 0
    });
  });
});
