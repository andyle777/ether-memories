import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  EtherMemoriesCore, FsJsonStorage, err, ok, getDurableOperations,
  parseTransactionSequenceId, sameCommittedTip,
  type CommittedTip, type DurableStorageOperations, type DurableTransaction,
  type DurableTransactionIdentity, type EtherSnapshot, type PersistenceErrorCode,
  type StoragePort, type StoreHead, type TransactionSequenceId
} from "../src/index.js";
import type { MutationId, MutationIdentity } from "../src/index.js";

class LegacyStorage implements StoragePort {
  private saved = "null";
  async load(): Promise<unknown> { return JSON.parse(this.saved); }
  async save(snapshot: EtherSnapshot): Promise<void> { this.saved = JSON.stringify(snapshot); }
}

const sequence = (text: string): TransactionSequenceId => {
  const result = parseTransactionSequenceId(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("AF1 persistence contracts", () => {
  it("keeps legacy load/save implementers usable by the existing Core", async () => {
    const storage: StoragePort = new LegacyStorage();
    const source = new EtherMemoriesCore({ userId: "legacy", storage });
    expect(source.addMemory({ content: "Legacy note" }).ok).toBe(true);
    expect(source.addDiaryEntry({ content: "Legacy diary" }).ok).toBe(true);
    expect((await source.save()).ok).toBe(true);
    const target = new EtherMemoriesCore({ userId: "legacy", storage });
    expect((await target.load()).ok).toBe(true);
    expect(target.exportData()).toEqual(source.exportData());
    expect(target.exportData().schemaVersion).toBe("ether.memory_store.v0.3");
    expectTypeOf<LegacyStorage>().toMatchTypeOf<StoragePort>();
  });

  it("distinguishes missing durable operations on legacy and filesystem ports", () => {
    for (const storage of [new LegacyStorage(), new FsJsonStorage("legacy.json")]) {
      const port: StoragePort = storage;
      expect(port.durable).toBeUndefined();
      expect(getDurableOperations(port)).toMatchObject({ ok: false, error: { code: "DURABILITY_UNAVAILABLE" } });
    }
  });

  it("exposes actual operations without mistaking capability presence for writer authority", async () => {
    const durable: DurableStorageOperations = {
      withWriter: async () => err("WRITER_BUSY", "Another writer holds authority.")
    };
    const storage: StoragePort = { load: async () => null, save: async () => {}, durable };
    const capability = getDurableOperations(storage);
    expect(capability.ok).toBe(true);
    if (!capability.ok) throw new Error(capability.error.message);
    expect(capability.value).toBe(durable);
    const operation = vi.fn(async () => ok(undefined));
    expect(await capability.value.withWriter(operation)).toMatchObject({ ok: false, error: { code: "WRITER_BUSY" } });
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves exact sequence IDs beyond safe-integer and 64-bit limits through JSON", () => {
    for (const text of ["0", "1", "9007199254740992", "9007199254740993", "18446744073709551616", "9".repeat(100)]) {
      expect(parseTransactionSequenceId(text)).toEqual({ ok: true, value: text });
      expect(parseTransactionSequenceId(JSON.parse(JSON.stringify(sequence(text))))).toEqual({ ok: true, value: text });
    }
    expect(sequence("9007199254740992")).not.toBe(sequence("9007199254740993"));
    expectTypeOf<number>().not.toMatchTypeOf<TransactionSequenceId>();
    expectTypeOf<string>().not.toMatchTypeOf<TransactionSequenceId>();
    expectTypeOf<bigint>().not.toMatchTypeOf<TransactionSequenceId>();
  });

  it("rejects numeric coercion and noncanonical sequence IDs", () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER, 9007199254740992, NaN, Infinity, 1n,
      "", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "1\r\n", "\u0661", null, undefined, {}, { toString: () => "1" }]) {
      expect(parseTransactionSequenceId(value)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("requires epoch, exact sequence ID, and digest for full tip equality", () => {
    const tip: CommittedTip = { epochId: "epoch-a", txId: sequence("9007199254740992"), digest: "digest-a" };
    expect(sameCommittedTip(tip, { ...tip })).toBe(true);
    expect(sameCommittedTip(tip, { ...tip, epochId: "epoch-b" })).toBe(false);
    expect(sameCommittedTip(tip, { ...tip, txId: sequence("9007199254740993") })).toBe(false);
    expect(sameCommittedTip(tip, { ...tip, digest: "digest-b" })).toBe(false);
    expectTypeOf<DurableTransactionIdentity>().toEqualTypeOf<CommittedTip>();
    expectTypeOf<DurableTransaction["expectedBase"]>().toEqualTypeOf<CommittedTip>();
  });

  it("separates caller mutation IDs from assigned transaction IDs at the type boundary", () => {
    expectTypeOf<MutationId>().not.toMatchTypeOf<TransactionSequenceId>();
    expectTypeOf<TransactionSequenceId>().not.toMatchTypeOf<MutationId>();
    expectTypeOf<string>().not.toMatchTypeOf<MutationId>();
    expectTypeOf<number>().not.toMatchTypeOf<MutationId>();
    expectTypeOf<MutationIdentity>().not.toMatchTypeOf<DurableTransactionIdentity>();
    expectTypeOf<DurableTransactionIdentity>().not.toMatchTypeOf<MutationIdentity>();
    expectTypeOf<DurableTransaction["mutation"]>().toEqualTypeOf<MutationIdentity>();
    expectTypeOf<Omit<DurableTransaction, "mutation">>().not.toMatchTypeOf<DurableTransaction>();
  });

  it("carries a pre-commit mutation identity unchanged into the eventual transaction contract", () => {
    const mutation: MutationIdentity = { mutationId: "caller-command-a" as MutationId, digest: "canonical-mutation-a" };
    expect(Object.keys(mutation).sort()).toEqual(["digest", "mutationId"]);
    const transaction: DurableTransaction = {
      storeId: "store-a", mutation, format: { format: "ether.wal", version: "1" },
      expectedBase: { epochId: "epoch-a", txId: sequence("0"), digest: "genesis" },
      identity: { epochId: "epoch-a", txId: sequence("1"), digest: "transaction-a" },
      operations: [{ type: "test.delta", version: "1", payload: { value: "a" } }]
    };
    const retry = JSON.parse(JSON.stringify(transaction)) as DurableTransaction;
    expect(retry.mutation).toEqual(mutation);
    expect(retry.identity).toEqual(transaction.identity);
    expect(retry.mutation.mutationId).not.toBe(retry.identity.txId);
    expect(retry.mutation.digest).not.toBe(retry.identity.digest);
  });

  it("retains a canonical mutation fingerprint so incompatible ID reuse is distinguishable", () => {
    const original: MutationIdentity = { mutationId: "caller-command-a" as MutationId, digest: "canonical-mutation-a" };
    const sameCommandRetry: MutationIdentity = { ...original };
    const incompatible: MutationIdentity = { ...original, digest: "canonical-mutation-b" };
    expect(sameCommandRetry).toEqual(original);
    expect(incompatible.mutationId).toBe(original.mutationId);
    expect(incompatible.digest).not.toBe(original.digest);
    // This asserts representability only; there is deliberately no deduplication engine.
  });

  it("keeps persistence authority metadata outside ordinary snapshots", () => {
    expectTypeOf<Extract<keyof EtherSnapshot, "storeId" | "epochId" | "txId" | "digest" | "checkpoint" | "walFormat">>().toEqualTypeOf<never>();
    expectTypeOf<StoreHead["checkpoint"]["tip"]>().toEqualTypeOf<CommittedTip>();
    expectTypeOf<Extract<keyof StoreHead, "txId" | "tip">>().toEqualTypeOf<never>();
  });

  it("preserves each durable failure category in the existing Result representation", () => {
    const codes = ["STALE_TRANSACTION_BASE", "PERSISTENCE_CORRUPTION", "WRITER_BUSY", "READ_ONLY_LOCKED",
      "RECOVERY_REQUIRED", "UNSUPPORTED_PERSISTENCE_FORMAT", "DURABILITY_UNAVAILABLE"] as const satisfies readonly PersistenceErrorCode[];
    for (const code of codes) expect(err(code, "contract failure")).toMatchObject({ ok: false, error: { code } });
  });
});
