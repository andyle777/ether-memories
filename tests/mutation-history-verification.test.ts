import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MutationHistoryVerifier } from "../src/persistence/mutationHistoryVerification.js";
import {
  ReceiptLedgerReader, ROOT_PREDECESSOR_DIGEST, compareMutationIds, encodeReceiptEntryLine, encodeReceiptHeaderLine, receiptLedgerPath
} from "../src/persistence/receiptLedger.js";
import type { ReceiptEntry, ReceiptLedgerHeader } from "../src/persistence/receiptLedger.js";
import type { DirectoryIO } from "../src/persistence/directoryIO.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import { value } from "./helpers/persistence.js";

const cleanup: string[] = [];
const fresh = async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-history-"));
  cleanup.push(parent);
  const directory = join(parent, "store");
  await fs.mkdir(join(directory, ".private"), { recursive: true });
  await fs.mkdir(join(directory, "receipts"), { recursive: true });
  return directory;
};
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

/** Physical session-scratch inventory: every verifier artifact lives in .private. */
const scratch = async (directory: string) => {
  const names = (await fs.readdir(join(directory, ".private"))).filter(name => name.startsWith("mutation-history-"));
  let bytes = 0;
  for (const name of names) bytes += (await fs.stat(join(directory, ".private", name))).size;
  return { files: names.length, bytes };
};

const receiptEntry = (mutationId: string, intentDigest = "1".repeat(64)): ReceiptEntry => ({
  mutationId, intentDigest, txId: "9007199254740993", transactionDigest: "2".repeat(64),
  operations: [{ type: "ether.note.put", version: "1", payload: { id: mutationId, content: "x" } }]
});

const writeLedger = async (directory: string, entries: ReceiptEntry[]) => {
  const header: ReceiptLedgerHeader = { format: "ether.receipts", version: "1", storeId: "store-a", epochId: "epoch-a",
    retiredCheckpointDigest: "a".repeat(64), predecessorLedgerDigest: ROOT_PREDECESSOR_DIGEST,
    entryCount: entries.length, payloadBytes: entries.reduce((s, e) => s + value(encodeReceiptEntryLine(e)).byteLength, 0) };
  const bytes = Buffer.concat([Buffer.from(value(encodeReceiptHeaderLine(header))),
    ...entries.map(e => Buffer.from(value(encodeReceiptEntryLine(e))))]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(receiptLedgerPath(directory, digest), bytes);
  return ReceiptLedgerReader.open(directory, digest);
};

const bulk = (count: number, prefix = "bulk", digits = 6) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(digits, "0")}`);
const record = (verifier: MutationHistoryVerifier, id: string) =>
  verifier.recordWal({ mutationId: id, intentDigest: "4".repeat(64), txId: "9007199254740994" });

describe("source-aware mutation history verification", { timeout: 180_000 }, () => {
  it("accepts disjoint receipt history and active-WAL records at any relative ordering", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const receipts = value(await writeLedger(directory, ["a", "c", "e"].map(id => receiptEntry(id))));
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    for (const id of ["b", "d", "f"]) value(await verifier.recordWal({ mutationId: id, intentDigest: "3".repeat(64), txId: "9007199254740994" }));
    value(await verifier.verify(receipts));
    expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
    expect((await new MutationHistoryVerifier(directory, io, nodeWalIO).verify()).ok).toBe(true);
  });

  it("flushes multiple runs and merges with bounded fan-in: thousands of records stay exact", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO, 256 * 1024 * 1024);
    const ids = bulk(5000);
    const shuffled = [...ids].sort(() => (i => (i % 2 ? 1 : -1))(ids.indexOf(ids[0]!) % 2));
    for (const id of shuffled) value(await record(verifier, id));
    value(await verifier.verify());
    // Strict ordering under the frozen comparator held through sort+merge.
    expect(compareMutationIds("bulk-000000", "bulk-000001")).toBeLessThan(0);
  });

  it("rejects a duplicate mutationId inside the active-WAL record stream", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "dup", intentDigest: "5".repeat(64), txId: "9007199254740994" }));
    value(await verifier.recordWal({ mutationId: "dup", intentDigest: "5".repeat(64), txId: "9007199254740995" }));
    const verified = await verifier.verify();
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("rejects conflicting intent digests under the same mutationId", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "same", intentDigest: "6".repeat(64), txId: "9007199254740994" }));
    const flush = await verifier.recordWal({ mutationId: "same", intentDigest: "7".repeat(64), txId: "9007199254740995" });
    void flush;
    const verified = await verifier.verify();
    expect(verified.ok).toBe(false);
  });

  it("rejects the same mutationId in receipt history AND active WAL (cross-source corruption)", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const receipts = value(await writeLedger(directory, ["shared", "x"].map(id => receiptEntry(id))));
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    value(await verifier.recordWal({ mutationId: "shared", intentDigest: "1".repeat(64), txId: "9007199254740994" }));
    const verified = await verifier.verify(receipts);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("sweeps its scratch completely on every path, including failures", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    const before = await fs.readdir(join(directory, ".private"));
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    for (const id of bulk(300, "sweep")) value(await record(verifier, id));
    value(await verifier.verify());
    const after = await fs.readdir(join(directory, ".private"));
    expect(after.filter(name => name.startsWith("mutation-history-"))).toEqual([]);
    expect(after.length).toBe(before.length);
  });

  it("successful verification leaves ZERO session-owned scratch: one run, two runs, many runs, multiple merge rounds and the 5,000-record reproducer", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    // Every count forces real sorting/merging work: 50 -> one flushed run;
    // 2,600 -> two runs (one merge); 5,000 -> three runs (Codex's exact
    // reproducer volume); 26,000 -> ten runs across MULTIPLE merge rounds.
    for (const count of [50, 2_600, 5_000, 26_000]) {
      const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO, 256 * 1024 * 1024);
      for (const id of bulk(count)) value(await record(verifier, id));
      value(await verifier.verify());
      // PHYSICAL assertion: no initial runs, no intermediate merged runs, no
      // final merged run, no stale artifact of any kind remains.
      expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
    }
  });

  it("repeated verifier sessions never accumulate scratch", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    for (let session = 0; session < 5; session++) {
      const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO, 256 * 1024 * 1024);
      for (const id of bulk(5_000, `session-${session}`)) value(await record(verifier, id));
      value(await verifier.verify());
      expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
    }
  });

  it("a crashed session's stale scratch is reclaimed by the next session's namespace sweep", async () => {
    const directory = await fresh();
    const io = simulatedDirectoryIO();
    // Simulate a crashed session: artifacts left behind with no cleanup.
    const crashed = new MutationHistoryVerifier(directory, io, nodeWalIO);
    for (const id of bulk(2_600, "crash")) value(await record(crashed, id));
    const leaked = await scratch(directory);
    expect(leaked.files).toBeGreaterThan(0);
    // The next session sweeps the entire bounded namespace before use.
    const next = new MutationHistoryVerifier(directory, io, nodeWalIO);
    for (const id of bulk(50, "fresh")) value(await record(next, id));
    value(await next.verify());
    expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
  });

  it("unlink failures are observable, retain ownership, never report false success, and are retryable", async () => {
    const directory = await fresh();
    // Fault by slot name: deterministic namespace makes every artifact
    // addressable. mutation-history-000000 = an original run; higher slots
    // are merge outputs (the final merged artifact is the highest slot).
    // The fault is armed only AFTER recording (the session-start namespace
    // sweep runs while disarmed, so it is the cleanup that fails).
    const faulting = (faultSlot: () => string | undefined, io: DirectoryIO = simulatedDirectoryIO()): { io: DirectoryIO; arm: () => void; disarm: () => void } => {
      let armed = false;
      const wrapped: DirectoryIO = { ...io, removeOwnedFile: async path => {
        const slot = faultSlot();
        if (armed && slot !== undefined && path.includes(slot)) throw new Error("injected unlink failure");
        return io.removeOwnedFile(path);
      } };
      return { io: wrapped, arm: () => { armed = true; }, disarm: () => { armed = false; } };
    };
    const slotName = (slot: number) => `mutation-history-${String(slot).padStart(6, "0")}.run`;
    // Deterministic artifact layout: R initial runs occupy slots 0..R-1 (the
    // final run is flushed at the start of verify(), so R = observed runs
    // after recording + 1); merge outputs take the next free slots in order.
    // 2,600 uniform records -> one mid-recording flush + the final flush ->
    // R = 2 runs, single merge round, merged output at slot 2.
    // 26,000 records -> 11 mid-recording flushes -> R = 12 runs, two merge
    // rounds: the first-round merge at slot 12 and the final merged artifact
    // at slot 13.
    const runCountBeforeVerify = async (directory: string) =>
      (await fs.readdir(join(directory, ".private"))).filter(name => name.startsWith("mutation-history-")).length;
    const cases: Array<{ name: string; count: number; expectedObserved: number; slotOf: (observed: number) => number }> = [
      { name: "original run", count: 2_600, expectedObserved: 1, slotOf: () => 0 },
      { name: "single-round merge output", count: 2_600, expectedObserved: 1, slotOf: observed => observed + 1 },
      { name: "first-round merge artifact", count: 26_000, expectedObserved: 11, slotOf: observed => observed + 1 },
      { name: "final merged artifact", count: 26_000, expectedObserved: 11, slotOf: observed => observed + 2 }
    ];
    for (const testCase of cases) {
      const directory2 = await fresh();
      const { io: faultIO, arm, disarm } = faulting(() => slotName(testCase.slotOf(testCase.expectedObserved)));
      const verifier = new MutationHistoryVerifier(directory2, faultIO, nodeWalIO, 256 * 1024 * 1024);
      for (const id of bulk(testCase.count)) value(await record(verifier, id));
      expect(await runCountBeforeVerify(directory2), testCase.name).toBe(testCase.expectedObserved);
      arm();
      const verified = await verifier.verify();
      // The cleanup failure is OBSERVABLE: never a false success, and the
      // artifact physically remains (ownership + accounting retained).
      expect(verified.ok, testCase.name).toBe(false);
      const retained = await scratch(directory2);
      expect(retained.files, testCase.name).toBe(1);
      expect(retained.bytes, testCase.name).toBeGreaterThan(0);
      // Retry on the same session sweeps it where semantics permit.
      disarm();
      value(await verifier.cleanup());
      expect(await scratch(directory2)).toEqual({ files: 0, bytes: 0 });
    }
    // A total cleanup failure retains everything; a fresh session reclaims it.
    const directory3 = await fresh();
    const total = faulting(() => "mutation-history-");
    const verifier3 = new MutationHistoryVerifier(directory3, total.io, nodeWalIO, 256 * 1024 * 1024);
    for (const id of bulk(2_600)) value(await record(verifier3, id));
    total.arm();
    const failedAll = await verifier3.verify();
    expect(failedAll.ok).toBe(false);
    expect((await scratch(directory3)).files).toBeGreaterThan(1);
    const freshVerifier = new MutationHistoryVerifier(directory3, simulatedDirectoryIO(), nodeWalIO);
    for (const id of bulk(50, "reclaim")) value(await record(freshVerifier, id));
    value(await freshVerifier.verify());
    expect(await scratch(directory3)).toEqual({ files: 0, bytes: 0 });
  });

  it("a .private directory barrier failure after cleanup is observable", async () => {
    const directory = await fresh();
    let armed = true;
    const io: DirectoryIO = { ...simulatedDirectoryIO(), syncDirectory: async path => {
      if (armed && path.endsWith(".private")) throw new Error("injected barrier failure");
      return simulatedDirectoryIO().syncDirectory(path);
    } };
    const verifier = new MutationHistoryVerifier(directory, io, nodeWalIO);
    for (const id of bulk(2_600)) value(await record(verifier, id));
    const verified = await verifier.verify();
    // The artifacts were removed, but the durability barrier failed: the
    // failure must be observable, never a silent success.
    expect(verified.ok).toBe(false);
    expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
    armed = false;
    value(await verifier.cleanup());
    const next = new MutationHistoryVerifier(directory, simulatedDirectoryIO(), nodeWalIO);
    for (const id of bulk(50, "post-barrier")) value(await record(next, id));
    value(await next.verify());
    expect(await scratch(directory)).toEqual({ files: 0, bytes: 0 });
  });
});
