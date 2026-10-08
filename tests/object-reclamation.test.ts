import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../src/persistence/directoryIO.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "../src/persistence/walIO.js";
import { encodeEtherData, ETHER_DATA_PROFILE } from "../src/persistence/etherData.js";
import { OBJECT_REFERENCE, referenceFor, validateReference } from "../src/persistence/payloadObjects.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import {
  GC_CANDIDATES_NAME, GcDigestSorter, RunWriter, SealedRunReader, compareDigests, createGcSession,
  deriveReclaimCandidates, extractObjectDigest, gcLimits, sweepGcScratch,
  type GcInstrumentation, type GcLimits, type GcSession, type SealedRun
} from "../src/persistence/objectReclamation.js";
import type { CommittedTip, WalOperation } from "../src/types/persistence.js";
import { ok } from "../src/utils/result.js";
import { createReplayRegistry } from "../src/persistence/walOperations.js";
import { decodeStoreHead, WAL_FORMAT, WAL_VERSION } from "../src/persistence/codecs.js";
import { encodeWalFrame } from "../src/persistence/wal.js";
import { parseTransactionSequenceId } from "../src/utils/durablePersistence.js";
import * as publicApi from "../src/index.js";
import * as gcModule from "../src/persistence/objectReclamation.js";

const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const failure = (result: { ok: boolean; error?: unknown }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error as { code: string; message: string; details?: Record<string, unknown> };
};

// Fault injections deliberately reject close without closing the real handle.
// Test teardown owns these handles; production failure assertions run first.
const rejectedCloseHandles = new Set<WalFileHandle>();
const closeRejectedHandles = async () => {
  for (const handle of rejectedCloseHandles) {
    await handle.close();
    rejectedCloseHandles.delete(handle);
  }
};

/** Distinct 64-hex digests; order under compareDigests is stable. */
const digest = (index: number) => index.toString(16).padStart(64, "0");
const sortedDigests = (count: number) => Array.from({ length: count }, (_, i) => digest(i)).sort();
const objectReference = (bytes: Uint8Array): WalOperation => ({
  type: "ether.note.put", version: "1", payload: referenceFor(bytes) as unknown as WalOperation["payload"]
});
const inlineOperation = (): WalOperation => ({
  type: "ether.note.put", version: "1",
  payload: { encoding: ETHER_DATA_PROFILE, data: Buffer.from(value(encodeEtherData({ id: "a" }))).toString("utf8") }
});

/** Plain file reader for asserting scratch-run contents in unit tests. */
const runLines = async (path: string): Promise<string[]> => {
  const bytes = await fs.readFile(path);
  if (bytes.byteLength === 0) return [];
  if (bytes.byteLength % 129 !== 0) throw new Error("test run is not record-aligned");
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 129) {
    lines.push(bytes.subarray(offset, offset + 64).toString("utf8"));
  }
  return lines;
};
/** Write an authenticated, sealed run through the real writer. */
const sealFile = async (path: string, runType: "mark" | "inventory" | "candidates" | "validated",
  digests: string[], session: GcSession, phase: "G2-mark-scratch" | "G3-inventory" | "G4-coverage" = "G4-coverage"):
  Promise<SealedRun> => {
  const writer = new RunWriter(path, nodeWalIO, session, runType, phase);
  value(await writer.open());
  for (const entry of digests) value(await writer.append(entry));
  return value(await writer.close());
};
/** Counting WalIO wrapper for file-handle accounting assertions. */
const countingFiles = (files: WalIO = nodeWalIO) => {
  let opened = 0;
  let closed = 0;
  const openHandles = new Set<WalFileHandle>();
  const counting: WalIO = {
    ...files,
    open: async (path, create) => {
      const handle = await files.open(path, create);
      opened++;
      const tracked = { ...handle } as WalFileHandle;
      const originalClose = tracked.close.bind(tracked);
      tracked.close = async () => { closed++; openHandles.delete(tracked); await originalClose(); };
      openHandles.add(tracked);
      return tracked;
    }
  };
  return { files: counting, balances: () => opened === closed && openHandles.size === 0, opened: () => opened };
};

const testLimits = (overrides: Partial<GcLimits> = {}): GcLimits =>
  value(gcLimits({ namespaceSlots: 4, chunkEntries: 4, unlinkBatch: 4, ...overrides }));

describe("two-bank cascade digest sorter with exact-content bindings", { timeout: 120_000 }, () => {
  let parent: string;
  let directory: string;
  let io: DirectoryIO;
  const files = nodeWalIO;
  const privateNames = async () => (await fs.readdir(join(directory, ".private"))).sort();

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-sorter-"));
    directory = join(parent, "store");
    await fs.mkdir(join(directory, ".private"), { recursive: true });
    io = { ...nodeDirectoryIO, syncDirectory: async () => {}, activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } };
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  it("produces no run for an empty stream and sweeps to zero scratch", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits(), createGcSession());
    expect(value(await sorter.finish())).toBeUndefined();
    expect(await privateNames()).toEqual([]);
  });

  it("sorts one chunk into one sealed strictly-increasing authenticated run", async () => {
    const sorter = new GcDigestSorter(directory, "inventory", io, files, testLimits(), createGcSession());
    const input = [digest(9), digest(3), digest(7), digest(1)];
    for (const entry of input) value(await sorter.add(entry));
    const finished = value(await sorter.finish())!;
    expect(finished.records).toBe(4);
    expect(finished.byteLength).toBe(4 * 129);
    expect(finished.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await runLines(finished.path)).toEqual([...input].sort());
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("collapses duplicate marks with exact set semantics across chunks and banks", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits({ chunkEntries: 2, namespaceSlots: 2 }),
      createGcSession());
    const distinct = sortedDigests(30);
    for (const entry of [...distinct, ...distinct].sort()) value(await sorter.add(entry));
    const finished = value(await sorter.finish())!;
    expect(finished.records).toBe(30);
    expect(await runLines(finished.path)).toEqual(distinct);
  });

  it("cascades when every input-bank slot is occupied and never overwrites a consumed run", async () => {
    const limits = testLimits({ namespaceSlots: 4, chunkEntries: 4 });
    const sorter = new GcDigestSorter(directory, "mark", io, files, limits, createGcSession());
    const distinct = sortedDigests(68);
    for (const entry of distinct) value(await sorter.add(entry));
    const finished = value(await sorter.finish())!;
    expect(finished.records).toBe(68);
    expect(await runLines(finished.path)).toEqual(distinct);
    expect((await privateNames()).filter(name => name.startsWith("gc-mark"))).toHaveLength(1);
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("reaches multiple cascade levels with a small namespace and exact results", async () => {
    const limits = testLimits({ namespaceSlots: 2, chunkEntries: 2 });
    const sorter = new GcDigestSorter(directory, "inventory", io, files, limits, createGcSession());
    const distinct = sortedDigests(100);
    for (const entry of distinct) value(await sorter.add(entry));
    const finished = value(await sorter.finish())!;
    expect(finished.records).toBe(100);
    expect(await runLines(finished.path)).toEqual(distinct);
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("fails closed on a non-hex digest input as maintenance", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits(), createGcSession());
    const result = await sorter.add("not-a-digest");
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(await privateNames()).toEqual([]);
  });

  it("reserves before create: debris occupying the next slot fails the flush", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits(), createGcSession());
    await fs.writeFile(join(directory, ".private", "gc-mark-a-000000.run"), "debris");
    for (let i = 1; i <= 4; i++) {
      const added = await sorter.add(digest(i));
      if (!added.ok) {
        expect(failure(added).code).toBe("RECOVERY_REQUIRED");
        expect(await fs.readFile(join(directory, ".private", "gc-mark-a-000000.run"), "utf8")).toBe("debris");
        return;
      }
    }
    throw new Error("expected the debris-occupied slot to fail the flush");
  });

  it.each(["output-create", "output-fsync", "output-verify", "input-unlink", "private-barrier"] as const)
  ("observes the injected %s cascade failure and leaves only inert retryable debris", async point => {
    const limits = testLimits({ namespaceSlots: 2, chunkEntries: 2 });
    const failingFiles: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        if (point === "output-create" && create && path.includes("-b-")) throw new Error("injected output create failure");
        const handle = await nodeWalIO.open(path, create);
        if (point === "output-fsync" && create && path.includes("-b-")) {
          return { ...handle, sync: async () => { await handle.close(); throw new Error("injected output sync failure"); } } as WalFileHandle;
        }
        if (point === "output-verify" && !create && path.includes("-b-")) {
          return { ...handle, read: async (bytes: Uint8Array, position: number) => { bytes.fill(0x7a); return bytes.byteLength; } } as WalFileHandle;
        }
        return handle;
      }
    };
    const failingIo: DirectoryIO = {
      ...io,
      removeOwnedFile: point === "input-unlink"
        ? async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }
        : io.removeOwnedFile,
      syncDirectory: point === "private-barrier"
        ? async (path: string) => { if (path.endsWith(".private")) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected barrier failure"); }
        : io.syncDirectory
    };
    const sorter = new GcDigestSorter(directory, "mark", failingIo, failingFiles, limits, createGcSession());
    let observed: { ok: boolean } | undefined;
    for (const entry of sortedDigests(10)) {
      const added = await sorter.add(entry);
      if (!added.ok) { observed = added; break; }
    }
    const finished = observed ?? await sorter.finish();
    const error = failure(finished);
    expect(["RECOVERY_REQUIRED", "READ_ONLY_LOCKED", "DURABILITY_UNAVAILABLE", "PERSISTENCE_CORRUPTION"]).toContain(error.code);
    expect(error.details!.gcDisposition).toBe("maintenance");
    const retry = new GcDigestSorter(directory, "mark", io, files, limits, createGcSession());
    value(await sweepGcScratch(directory, io, limits, "G1-scratch-sweep"));
    for (const entry of sortedDigests(10)) value(await retry.add(entry));
    const retried = value(await retry.finish())!;
    expect(retried.records).toBe(10);
    await retry.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("keeps verified merge output and undeleted source runs as legal coexisting crash debris", async () => {
    const limits = testLimits({ namespaceSlots: 2, chunkEntries: 2 });
    const crashingIo: DirectoryIO = {
      ...io,
      removeOwnedFile: async path => {
        if (path.includes("-a-")) throw new Error("simulated crash during source-run replacement");
        await io.removeOwnedFile(path);
      }
    };
    const sorter = new GcDigestSorter(directory, "mark", crashingIo, files, limits, createGcSession());
    let crashed = false;
    for (const entry of sortedDigests(8)) {
      const added = await sorter.add(entry);
      if (!added.ok) { expect(failure(added).code).toBe("RECOVERY_REQUIRED"); crashed = true; break; }
    }
    if (!crashed) expect(failure(await sorter.finish()).code).toBe("RECOVERY_REQUIRED");
    const names = await privateNames();
    expect(names.some(name => name.includes("gc-mark-b-"))).toBe(true);
    expect(names.filter(name => name.includes("gc-mark-a-")).length).toBeGreaterThan(0);
    const outputPath = join(directory, ".private", "gc-mark-b-000000.run");
    expect(await runLines(outputPath)).toEqual(sortedDigests(8).slice(0, 4));
    value(await sweepGcScratch(directory, io, limits, "G1-scratch-sweep"));
    expect(await privateNames()).toEqual([]);
    const retry = new GcDigestSorter(directory, "mark", io, files, limits, createGcSession());
    for (const entry of sortedDigests(8)) value(await retry.add(entry));
    expect(value(await retry.finish())!.records).toBe(8);
    await retry.sweep();
  });
});

describe("per-record authentication of sealed runs", () => {
  let parent: string;
  let directory: string;
  const files = nodeWalIO;

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-auth-"));
    directory = join(parent, "store");
    await fs.mkdir(join(directory, ".private"), { recursive: true });
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  /** Wrap reads so the Nth read of a path returns substituted record bytes. */
  const substitutingReads = (pathPart: string, readIndex: number, replacement: () => Uint8Array): WalIO => ({
    ...nodeWalIO,
    open: async (path, create) => {
      const handle = await nodeWalIO.open(path, create);
      if (!path.includes(pathPart)) return handle;
      let reads = 0;
      return {
        ...handle,
        read: async (bytes: Uint8Array, position: number) => {
          const read = await handle.read(bytes, position);
          if (reads++ === readIndex) {
            const record = replacement();
            bytes.set(record.subarray(0, Math.min(record.byteLength, bytes.byteLength)));
          }
          return read;
        }
      } as WalFileHandle;
    }
  });
  const recordOf = (digest: string, tag: string) => Buffer.from(digest + tag + "\n", "utf8");

  it("authenticates every consumed record against the invocation key before returning it", async () => {
    const session = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated",
      sortedDigests(3), session);
    const reader = value(await SealedRunReader.open(sealed, files, session, "G6-reclaim", "maintenance"));
    const seen: string[] = [];
    for (;;) {
      const item = await reader.next();
      const digest = value(item);
      if (digest === undefined) break;
      seen.push(digest);
    }
    expect(seen).toEqual(sortedDigests(3));
    value(reader.verifyConsumed());
    await reader.close();
  });

  it("fails BEFORE the digest is used when consumption substitutes a legal digest with the original tag", async () => {
    // The exact review counterexample at unit level: the whole-run seal was
    // verified against the real bytes (read #1); the record-authorizing read
    // (read #2) returns a substituted legal digest while preserving syntax,
    // length and ordering. Only per-record authentication catches it.
    const session = createGcSession();
    const entries = sortedDigests(1);
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated", entries, session);
    const original = await fs.readFile(sealed.path);
    const substituted = recordOf(digest(50), original.subarray(64, 128).toString("utf8"));
    const corrupting = substitutingReads("gc-validated", 1, () => substituted);
    const reader = value(await SealedRunReader.open(sealed, corrupting, session, "G6-reclaim", "maintenance"));
    const result = await reader.next();
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).message).toContain("authentication failed");
    await reader.close();
  });

  it.each(["first", "middle", "last"] as const)
  ("fails on a substituted %s record of a multi-record run", async position => {
    const session = createGcSession();
    const entries = sortedDigests(3);
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated", entries, session);
    const bytes = await fs.readFile(sealed.path);
    const target = position === "first" ? 0 : position === "middle" ? 1 : 2;
    // Whole-run verification read happens first (read #0), then the record
    // reads: read #(1 + target).
    const corrupting = substitutingReads("gc-validated", 1 + target, () => {
      const record = Buffer.from(bytes.subarray(target * 129, target * 129 + 129));
      record.write(digest(50), 0, 64, "utf8");
      return record;
    });
    const reader = value(await SealedRunReader.open(sealed, corrupting, session, "G6-reclaim", "maintenance"));
    let failed = false;
    for (let index = 0; index < 3; index++) {
      const item = await reader.next();
      if (!item.ok) {
        expect(failure(item).code).toBe("PERSISTENCE_CORRUPTION");
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    await reader.close();
  });

  it("fails on a substituted tag", async () => {
    const session = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated",
      sortedDigests(1), session);
    const corrupting = substitutingReads("gc-validated", 1, () => recordOf(sortedDigests(1)[0]!, "f".repeat(64)));
    const reader = value(await SealedRunReader.open(sealed, corrupting, session, "G6-reclaim", "maintenance"));
    expect(failure(await reader.next()).code).toBe("PERSISTENCE_CORRUPTION");
    await reader.close();
  });

  it("fails on a valid record replayed at another position (index binding)", async () => {
    const session = createGcSession();
    const entries = sortedDigests(3);
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated", entries, session);
    const bytes = await fs.readFile(sealed.path);
    // Return the record of position 2 when position 0 is consumed.
    const corrupting = substitutingReads("gc-validated", 1, () => bytes.subarray(2 * 129, 3 * 129));
    const reader = value(await SealedRunReader.open(sealed, corrupting, session, "G6-reclaim", "maintenance"));
    expect(failure(await reader.next()).code).toBe("PERSISTENCE_CORRUPTION");
    await reader.close();
  });

  it("fails across invocations: a run written under another key never authenticates", async () => {
    const writingSession = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-validated-000000.run"), "validated",
      sortedDigests(2), writingSession);
    const readerSession = createGcSession();
    const reader = value(await SealedRunReader.open(sealed, files, readerSession, "G6-reclaim", "maintenance"));
    expect(failure(await reader.next()).code).toBe("PERSISTENCE_CORRUPTION");
    await reader.close();
  });

  it("fails across run types: candidates records never authenticate as validated records", async () => {
    const session = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-candidates-000000.run"), "candidates",
      sortedDigests(2), session);
    const forged: SealedRun = { ...sealed, runType: "validated" };
    const reader = value(await SealedRunReader.open(forged, files, session, "G6-reclaim", "maintenance"));
    expect(failure(await reader.next()).code).toBe("PERSISTENCE_CORRUPTION");
    await reader.close();
  });
});

describe("sealed-reader handle lifetimes", () => {
  let parent: string;
  let directory: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-handles-"));
    directory = join(parent, "store");
    await fs.mkdir(join(directory, ".private"), { recursive: true });
  });
  afterEach(async () => {
    await closeRejectedHandles();
    await fs.rm(parent, { recursive: true, force: true });
  });

  it.each(["size", "hash", "canonical", "read"] as const)
  ("closes the handle on %s failure during open, without accumulation", async mode => {
    const session = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(3), session,
      "G2-mark-scratch");
    if (mode === "size") {
      await fs.writeFile(sealed.path, Buffer.concat([await fs.readFile(sealed.path), Buffer.alloc(129)]));
    }
    if (mode === "hash") {
      const bytes = await fs.readFile(sealed.path);
      bytes[40] = 0x7a;
      await fs.writeFile(sealed.path, bytes);
    }
    if (mode === "canonical") {
      const bytes = await fs.readFile(sealed.path);
      bytes[100] = 0x7a;
      await fs.writeFile(sealed.path, Buffer.from([...bytes.subarray(0, 128), 0x7a, ...bytes.subarray(129)]));
    }
    const counting = countingFiles();
    let failing: WalIO | undefined;
    if (mode === "read") {
      failing = {
        ...counting.files,
        open: async (path, create) => {
          const handle = await counting.files.open(path, create);
          return { ...handle, read: async () => { throw new Error("injected read failure"); } } as WalFileHandle;
        }
      };
      const result = await SealedRunReader.open(sealed, failing!, session, "G2-mark-scratch", "maintenance");
      expect(result.ok).toBe(false);
    } else {
      const result = await SealedRunReader.open(sealed, counting.files, session, "G2-mark-scratch", "maintenance");
      expect(result.ok).toBe(false);
    }
    expect(counting.balances()).toBe(true);
    // Repeated attempts do not accumulate handles.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await SealedRunReader.open(sealed, mode === "read" ? failing! : counting.files, session,
        "G2-mark-scratch", "maintenance");
      expect(result.ok).toBe(false);
    }
    expect(counting.balances()).toBe(true);
    expect(counting.opened()).toBeGreaterThan(0);
  });

  it("closes the first reader when the second G4 reader fails to open", async () => {
    const session = createGcSession();
    const mark = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(2), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(4), session);
    const counting = countingFiles();
    const failing: WalIO = {
      ...counting.files,
      open: async (path, create) => {
        if (path.includes("gc-inventory")) throw new Error("injected second-reader open failure");
        return counting.files.open(path, create);
      }
    };
    const result = await deriveReclaimCandidates(mark, inventory,
      join(directory, ".private", GC_CANDIDATES_NAME), failing, session);
    expect(result.ok).toBe(false);
    expect(counting.balances()).toBe(true);
  });

  it("surfaces a close rejection as a close failure with exactly one close attempt", async () => {
    const session = createGcSession();
    let failClose = false;
    let closeAttempts = 0;
    const closeFailing: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        const handle = await nodeWalIO.open(path, create);
        const originalClose = handle.close.bind(handle);
        if (!create) return handle;
        // Count only WRITER handles: the read-back verification opens and
        // closes its own reader handle outside this accounting.
        return { ...handle, close: async () => {
          closeAttempts++;
          if (failClose) { rejectedCloseHandles.add(handle); throw new Error("injected close rejection"); }
          await originalClose();
        } } as WalFileHandle;
      }
    };
    const writer = new RunWriter(join(directory, ".private", "gc-mark-a-000000.run"), closeFailing, session,
      "mark", "G2-mark-scratch");
    value(await writer.open());
    value(await writer.append(digest(1)));
    failClose = true;
    const result = await writer.close();
    const error = failure(result);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.message).toContain("close failed");
    expect(error.message).not.toContain("sync failed");
    expect(closeAttempts).toBe(1);
    // dispose after a completed close path never re-attempts the close.
    await writer.dispose();
    expect(closeAttempts).toBe(1);
    // Retry after fault removal succeeds with exactly one more attempt.
    failClose = false;
    const retry = new RunWriter(join(directory, ".private", "gc-mark-a-000001.run"), closeFailing, session,
      "mark", "G2-mark-scratch");
    value(await retry.open());
    value(await retry.append(digest(2)));
    const sealed = value(await retry.close());
    expect(sealed.records).toBe(1);
    expect(closeAttempts).toBe(2);
  });

  it("keeps the sync failure as the primary diagnosis even when cleanup close also fails", async () => {
    const session = createGcSession();
    const failing: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        const handle = await nodeWalIO.open(path, create);
        return { ...handle, sync: async () => { throw new Error("injected sync failure"); },
          close: async () => { rejectedCloseHandles.add(handle); throw new Error("injected close failure"); } } as WalFileHandle;
      }
    };
    const writer = new RunWriter(join(directory, ".private", "gc-mark-a-000000.run"), failing, session,
      "mark", "G2-mark-scratch");
    value(await writer.open());
    value(await writer.append(digest(1)));
    const result = await writer.close();
    const error = failure(result);
    expect(error.message).toContain("sync failed");
    expect(error.details!.gcDisposition).toBe("maintenance");
    await writer.dispose();
  });

  it("closes the handle when the initial stat fails during open, without accumulation", async () => {
    const session = createGcSession();
    const sealed = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(2), session,
      "G2-mark-scratch");
    const counting = countingFiles();
    const statFailing: WalIO = {
      ...counting.files,
      open: async (path, create) => {
        const handle = await counting.files.open(path, create);
        return { ...handle, stat: async () => { throw new Error("injected stat failure"); } } as WalFileHandle;
      }
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await SealedRunReader.open(sealed, statFailing, session, "G2-mark-scratch", "maintenance");
      expect(result.ok).toBe(false);
      expect(counting.balances()).toBe(true);
    }
    expect(counting.opened()).toBe(5);
    // Retry after fault removal succeeds.
    const reader = value(await SealedRunReader.open(sealed, counting.files, session, "G2-mark-scratch", "maintenance"));
    await reader.close();
    expect(counting.balances()).toBe(true);
  });

  it("disposes the chunk-run writer when append fails, without accumulation", async () => {
    const session = createGcSession();
    let failWrite = false;
    const counting = countingFiles();
    const writeFailing: WalIO = {
      ...counting.files,
      open: async (path, create) => {
        const handle = await counting.files.open(path, create);
        if (!create || !path.includes("gc-mark") || !failWrite) return handle;
        return { ...handle, write: async () => { throw new Error("injected append failure"); } } as WalFileHandle;
      }
    };
    const io: DirectoryIO = { ...nodeDirectoryIO, syncDirectory: async () => {},
      activateFile: async (a, b) => { await fs.rename(a, b); return "atomic"; } };
    const sorter = new GcDigestSorter(directory, "mark", io, writeFailing, testLimits(), session);
    for (let attempt = 0; attempt < 5; attempt++) {
      failWrite = true;
      let failed = false;
      for (let index = 0; index < 5; index++) {
        const added = await sorter.add(digest(index + 1));
        if (!added.ok) {
          // The chunk flush failed on append: the writer must be disposed.
          failed = true;
          expect(failure(added).details!.gcDisposition).toBe("maintenance");
          break;
        }
      }
      expect(failed).toBe(true);
      expect(counting.balances()).toBe(true);
    }
    failWrite = false;
    const retry = new GcDigestSorter(directory, "mark", io, counting.files, testLimits(), createGcSession());
    value(await sweepGcScratch(directory, io, testLimits(), "G1-scratch-sweep"));
    for (let index = 0; index < 5; index++) value(await retry.add(digest(index + 1)));
    const finished = value(await retry.finish())!;
    expect(finished.records).toBe(5);
    await retry.sweep();
    expect(counting.balances()).toBe(true);
  });

  it("balances handles across a full successful derive", async () => {
    const session = createGcSession();
    const mark = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(2), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(4), session);
    const counting = countingFiles();
    const coverage = value(await deriveReclaimCandidates(mark, inventory,
      join(directory, ".private", GC_CANDIDATES_NAME), counting.files, session));
    expect(coverage.candidates).toBe(2);
    expect(counting.balances()).toBe(true);
  });
});

describe("exact reachability merge over sealed runs", () => {
  let parent: string;
  let directory: string;
  const files = nodeWalIO;
  const candidatesPath = () => join(directory, ".private", GC_CANDIDATES_NAME);
  const privateNames = async () => (await fs.readdir(join(directory, ".private"))).sort();

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-merge-"));
    directory = join(parent, "store");
    await fs.mkdir(join(directory, ".private"), { recursive: true });
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  it("treats an empty mark set and empty inventory as a valid no-object store", async () => {
    const coverage = value(await deriveReclaimCandidates(undefined, undefined, candidatesPath(), files, createGcSession()));
    expect(coverage).toEqual({ candidatesRun: undefined, candidates: 0, reachable: 0 });
  });

  it("marks every inventory object a candidate when no marks exist", async () => {
    const session = createGcSession();
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(3), session, "G3-inventory");
    const coverage = value(await deriveReclaimCandidates(undefined, inventory, candidatesPath(), files, session));
    expect(coverage.candidates).toBe(3);
    expect(await runLines(coverage.candidatesRun!.path)).toEqual(sortedDigests(3));
  });

  it("writes zero candidates when every object is reachable", async () => {
    const session = createGcSession();
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(2), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(2), session, "G3-inventory");
    const coverage = value(await deriveReclaimCandidates(marks, inventory, candidatesPath(), files, session));
    expect(coverage).toEqual({ candidatesRun: undefined, candidates: 0, reachable: 2 });
    expect(await privateNames()).toEqual(["gc-inventory-a-000000.run", "gc-mark-a-000000.run"]);
  });

  it("separates reachable objects from candidates in one exact merge", async () => {
    const session = createGcSession();
    const all = sortedDigests(10);
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark",
      all.slice(0, 4).concat(all.slice(6, 8)), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory", all, session,
      "G3-inventory");
    const coverage = value(await deriveReclaimCandidates(marks, inventory, candidatesPath(), files, session));
    expect(coverage.candidates).toBe(4);
    expect(coverage.reachable).toBe(6);
    expect(await runLines(coverage.candidatesRun!.path)).toEqual(all.slice(4, 6).concat(all.slice(8)));
  });

  it("fails closed as authoritative when a marked object is missing from the inventory", async () => {
    const session = createGcSession();
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(5), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(5).slice(0, 3), session, "G3-inventory");
    const result = await deriveReclaimCandidates(marks, inventory, candidatesPath(), files, session);
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("authoritative");
    expect(error.details!.missingDigest).toBe(sortedDigests(5)[3]);
    expect(await privateNames()).not.toContain(GC_CANDIDATES_NAME);
  });

  it("fails closed as authoritative when the inventory is absent while marks exist", async () => {
    const session = createGcSession();
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(2), session);
    const result = await deriveReclaimCandidates(marks, undefined, candidatesPath(), files, session);
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).details!.gcDisposition).toBe("authoritative");
  });

  it("fails closed as authoritative when marks remain after inventory EOF", async () => {
    const session = createGcSession();
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(4), session);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(10).slice(1, 2), session, "G3-inventory");
    const result = await deriveReclaimCandidates(marks, inventory, candidatesPath(), files, session);
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).details!.gcDisposition).toBe("authoritative");
  });

  it("fails closed as maintenance on a semantically substituted sealed mark run", async () => {
    const session = createGcSession();
    const marks = await sealFile(join(directory, ".private", "gc-mark-a-000000.run"), "mark", sortedDigests(4), session);
    const replaced = sortedDigests(4).slice();
    replaced[1] = digest(50);
    const bytes = await fs.readFile(marks.path);
    const record = Buffer.from(replaced[1]! + bytes.subarray(65, 129).toString("utf8") + "\n", "utf8");
    bytes.set(record, 129);
    await fs.writeFile(marks.path, bytes);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory",
      sortedDigests(10), session, "G3-inventory");
    const result = await deriveReclaimCandidates(marks, inventory, candidatesPath(), files, session);
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(await privateNames()).not.toContain(GC_CANDIDATES_NAME);
  });

  it.each(["truncate", "extend", "reorder", "duplicate"] as const)
  ("fails closed as maintenance on a %sd sealed inventory run", async mode => {
    const session = createGcSession();
    const entries = sortedDigests(6);
    const inventory = await sealFile(join(directory, ".private", "gc-inventory-a-000000.run"), "inventory", entries,
      session, "G3-inventory");
    const bytes = await fs.readFile(inventory.path);
    let out = bytes;
    if (mode === "truncate") out = bytes.subarray(0, bytes.byteLength - 129);
    if (mode === "extend") out = Buffer.concat([bytes, bytes.subarray(0, 129)]);
    if (mode === "reorder") {
      out = Buffer.from(bytes);
      const first = bytes.subarray(0, 129);
      const second = bytes.subarray(129, 258);
      out.set(second, 0);
      out.set(first, 129);
    }
    if (mode === "duplicate") {
      // Replace the final record with a duplicate of the first: still legal
      // syntax, same count and length, but no longer increasing and no longer
      // the sealed content.
      out = Buffer.from(bytes);
      out.set(bytes.subarray(0, 129), bytes.byteLength - 129);
    }
    await fs.writeFile(inventory.path, out);
    const result = await deriveReclaimCandidates(undefined, inventory, candidatesPath(), files, session);
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
  });
});

describe("object-reference extraction", () => {
  it("extracts the digest of a valid OBJECT_REFERENCE operation", () => {
    const bytes = value(encodeEtherData({ id: "object-backed", content: "x".repeat(70_000) }));
    const operation = objectReference(bytes);
    expect(value(extractObjectDigest(operation))).toBe(referenceFor(bytes).digest);
  });

  it("returns nothing for an inline envelope operation", () => {
    expect(value(extractObjectDigest(inlineOperation()))).toBeUndefined();
  });

  it("fails closed on an unknown operation encoding", () => {
    const operation = { type: "ether.note.put", version: "1", payload: { encoding: "ether.unknown.v1" } } as WalOperation;
    expect(failure(extractObjectDigest(operation)).code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("classifies a malformed persisted OBJECT_REFERENCE as corruption, not caller input", () => {
    const operation = objectReference(value(encodeEtherData({ id: "x" })));
    const corrupted = { ...operation, payload: { ...operation.payload, digest: "zz" } } as WalOperation;
    const error = failure(extractObjectDigest(corrupted));
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(validateReference(corrupted.payload)).code).toBe("INVALID_INPUT");
  });

  it("fails closed on a non-object payload", () => {
    const operation = { type: "ether.note.put", version: "1", payload: null } as unknown as WalOperation;
    expect(failure(extractObjectDigest(operation)).code).toBe("PERSISTENCE_CORRUPTION");
  });
});

describe("G0-G7 reclamation protocol", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc protocol large object payload ".repeat(3000);

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-protocol-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  const open = async (deps: { io?: DirectoryIO; files?: WalIO; gcInstrumentation?: GcInstrumentation } = {}) =>
    openDurableEtherMemoriesInternal({ userId: "gc-protocol-user", directory, openMode: "auto" },
      { io: deps.io ?? io, files: deps.files ?? files, gcInstrumentation: deps.gcInstrumentation });

  const injectOrphan = async (content = "orphan") => {
    const digest = createHash("sha256").update(content).digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), digest + ".bin"), content);
    return digest;
  };

  it("reclaims only never-referenced orphans on a non-rotated store and is idempotent", async () => {
    const runtime = value(await open());
    const note = value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-large-1"));
    expect(note.id).toBeTruthy();
    const referenced = await objectNames();
    expect(referenced.length).toBeGreaterThanOrEqual(1);
    await injectOrphan("unreferenced debris");
    const orphanName = createHash("sha256").update("unreferenced debris").digest("hex") + ".bin";
    const tip = value(runtime.tip);
    const snapshot = value(runtime.exportData());
    const outcome = value(await runtime.collectGarbage());
    expect(outcome).toEqual({ scannedObjects: referenced.length + 1, markedReferences: referenced.length,
      reclaimedObjects: 1, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual(referenced);
    expect(value(runtime.tip)).toEqual(tip);
    expect(value(runtime.exportData())).toEqual(snapshot);
    const second = value(await runtime.collectGarbage());
    expect(second).toEqual({ scannedObjects: referenced.length, markedReferences: referenced.length,
      reclaimedObjects: 0, unknownArtifacts: 0 });
    expect(orphanName).not.toBe("");
    value(await runtime.close());
  });

  it("preserves a historical-receipt-only object across rotation, deletion, GC, restart and exact retry", async () => {
    const runtime = value(await open());
    const large = value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-historical-1"));
    const objectsBefore = await objectNames();
    value(await runtime.rotate());
    expect(await fs.readdir(join(directory, "wal"))).toEqual([]);
    value(await runtime.deleteMemory(large.id, "gc-historical-2"));
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(0);
    expect(outcome.markedReferences).toBe(objectsBefore.length);
    expect(await objectNames()).toEqual(objectsBefore);
    value(await runtime.close());
    const reopened = value(await open());
    const retried = value(await reopened.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-historical-1"));
    expect(retried.id).toBe(large.id);
    expect(retried.createdAt.getTime()).toBe(large.createdAt.getTime());
    const afterRetry = value(await reopened.collectGarbage());
    expect(afterRetry.reclaimedObjects).toBe(0);
    value(await reopened.close());
  });

  it("fails closed before deletion when an active-WAL-referenced object is missing", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-wal-root"));
    const referenced = await objectNames();
    await injectOrphan("orphan while corrupted");
    await fs.unlink(join(objectsDir(), referenced[0]!));
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("authoritative");
    const orphanDigest = createHash("sha256").update("orphan while corrupted").digest("hex");
    expect(await objectNames()).toEqual([...referenced.slice(1), orphanDigest + ".bin"].sort());
    value(await runtime.close());
  });

  it("fails closed before deletion when a receipt-ledger-referenced object is missing", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-receipt-root"));
    value(await runtime.rotate());
    const referenced = await objectNames();
    await fs.unlink(join(objectsDir(), referenced[0]!));
    const result = await runtime.collectGarbage();
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).details!.gcDisposition).toBe("authoritative");
    expect(await objectNames()).toEqual(referenced.slice(1));
    value(await runtime.close());
  });

  it("treats a missing objects directory as zero inventory only when no marks exist", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "inline note", status: "active" }, "gc-inline-1"));
    const outcome = value(await runtime.collectGarbage());
    expect(outcome).toEqual({ scannedObjects: 0, markedReferences: 0, reclaimedObjects: 0, unknownArtifacts: 0 });
    value(await runtime.close());
  });

  it("treats a missing objects directory with authoritative marks as corruption", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-marks-1"));
    await fs.rm(objectsDir(), { recursive: true, force: true });
    const result = await runtime.collectGarbage();
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    value(await runtime.close());
  });

  it("never deletes or follows malformed names, dotfiles, directories or symlinks", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-unknown-1"));
    const referenced = await objectNames();
    await injectOrphan("plain orphan");
    await fs.writeFile(join(objectsDir(), "zz-not-hex.bin"), "junk");
    await fs.writeFile(join(objectsDir(), ".hidden.tmp"), "junk");
    await fs.mkdir(join(objectsDir(), "f".repeat(64) + ".bin"));
    const linkTarget = join(parent, "link-target");
    await fs.writeFile(linkTarget, "outside the store");
    const linkName = "e".repeat(64) + ".bin";
    let symlinkCreated = true;
    try { await fs.symlink(linkTarget, join(objectsDir(), linkName), "file"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      symlinkCreated = false;
    }
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.unknownArtifacts).toBe(symlinkCreated ? 4 : 3);
    expect(outcome.reclaimedObjects).toBe(1);
    const survivors = [...referenced, "zz-not-hex.bin", ".hidden.tmp", "f".repeat(64) + ".bin"];
    if (symlinkCreated) survivors.push(linkName);
    expect(await objectNames()).toEqual(survivors.sort());
    expect(await fs.readFile(linkTarget, "utf8")).toBe("outside the store");
    value(await runtime.close());
  });

  it("reclaims an unmarked valid-name object regardless of its content without reading it", async () => {
    const runtime = value(await open());
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), "a".repeat(64) + ".bin"), "not even valid ether data");
    const outcome = value(await runtime.collectGarbage());
    expect(outcome).toEqual({ scannedObjects: 1, markedReferences: 0, reclaimedObjects: 1, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual([]);
    value(await runtime.close());
  });

  it("never classifies a reachable corrupt-content object as garbage", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-corrupt-1"));
    const referenced = await objectNames();
    await fs.writeFile(join(objectsDir(), referenced[0]!), "corrupted bytes");
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(0);
    expect(await objectNames()).toEqual(referenced);
    value(await runtime.close());
    // Existing recovery semantics remain the corruption authority.
    const reopened = await open();
    expect(reopened.ok).toBe(false);
  });

  it("reclaims the genuine orphan left by a simulated pre-commit crash after object install", async () => {
    let failWalWrites = false;
    const crashingFiles: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        const handle = await nodeWalIO.open(path, create);
        if (failWalWrites && path.includes(join("wal", "wal-"))) {
          return { ...handle, write: async () => { throw new Error("simulated crash before WAL append"); } } as WalFileHandle;
        }
        return handle;
      }
    };
    const runtime = value(await open({ files: crashingFiles }));
    value(await runtime.addMemory({ content: "inline first", status: "active" }, "gc-crash-0"));
    failWalWrites = true;
    const failed = await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-crash-1");
    expect(failed.ok).toBe(false);
    failWalWrites = false;
    // The WAL-append failure is an ambiguous durable outcome: the frozen T6
    // semantics require explicit recovery before further durable operations.
    value(await runtime.recover());
    const orphans = await objectNames();
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    const outcome = value(await runtime.collectGarbage());
    expect(outcome).toEqual({ scannedObjects: orphans.length, markedReferences: 0,
      reclaimedObjects: orphans.length, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual([]);
    value(await runtime.close());
  });

  it("keeps every object when interrupted before deletion, then succeeds on retry", async () => {
    let failAtG6 = false;
    const runtime = value(await open({ gcInstrumentation: {
      at: async phase => { if (phase === "G6-reclaim" && failAtG6) throw new Error("simulated crash before deletion"); }
    } }));
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-interrupt-1"));
    const orphanName = (await injectOrphan("interrupted orphan")) + ".bin";
    const before = await objectNames();
    failAtG6 = true;
    const interrupted = await runtime.collectGarbage();
    expect(failure(interrupted).code).toBe("RECOVERY_REQUIRED");
    expect(failure(interrupted).details!.gcDisposition).toBe("maintenance");
    expect(await objectNames()).toEqual(before);
    failAtG6 = false;
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(before.filter(name => name !== orphanName));
    value(await runtime.close());
  });

  it("reports exact partial reclaim accounting when an unlink fails mid-deletion", async () => {
    let unlinks = 0;
    const failingIo: DirectoryIO = {
      ...io,
      removeOwnedFile: async path => {
        if (path.includes("objects") && ++unlinks === 2) throw Object.assign(new Error("denied"), { code: "EACCES" });
        await io.removeOwnedFile(path);
      }
    };
    const runtime = value(await open({ io: failingIo }));
    value(await runtime.addMemory({ content: "inline only", status: "active" }, "gc-partial-1"));
    await injectOrphan("orphan one");
    await injectOrphan("orphan two");
    await injectOrphan("orphan three");
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("READ_ONLY_LOCKED");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.details!.reclaimedObjects).toBe(1);
    expect(error.details!.remainingCandidates).toBe(2);
    expect(error.details!.gcPhase).toBe("G6-reclaim");
    expect((await objectNames())).toHaveLength(2);
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(2);
    expect(await objectNames()).toHaveLength(0);
    value(await runtime.close());
  });

  it("reports a barrier failure as a partial maintenance failure with exact accounting", async () => {
    let failBarrier = false;
    const failingIo: DirectoryIO = {
      ...io,
      syncDirectory: async path => {
        if (failBarrier && path === objectsDir()) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected barrier failure");
        await io.syncDirectory(path);
      }
    };
    const runtime = value(await open({ io: failingIo }));
    value(await runtime.addMemory({ content: "inline only", status: "active" }, "gc-barrier-1"));
    await injectOrphan("barrier orphan");
    failBarrier = true;
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.details!.reclaimedObjects).toBe(1);
    expect(error.details!.gcPhase).toBe("G6-reclaim");
    expect(await objectNames()).toHaveLength(0);
    value(await runtime.close());
  });

  it("fails observably when final scratch cleanup fails while leaving authority untouched", async () => {
    let failPrivate = false;
    const failingIo: DirectoryIO = {
      ...io,
      syncDirectory: async path => {
        if (failPrivate && path === join(directory, ".private")) {
          throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected cleanup barrier failure");
        }
        await io.syncDirectory(path);
      }
    };
    let g7Armed = true;
    const runtime = value(await open({ io: failingIo, gcInstrumentation: {
      at: async phase => { if (phase === "G7-final-cleanup" && g7Armed) { g7Armed = false; failPrivate = true; } }
    } }));
    value(await runtime.addMemory({ content: "inline before gc", status: "active" }, "gc-cleanup-1"));
    await injectOrphan("cleanup orphan");
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.details!.gcPhase).toBe("G7-final-cleanup");
    expect(await objectNames()).toHaveLength(0);
    failPrivate = false;
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(0);
    value(await runtime.close());
  });

  it("excludes a concurrent writer through ordinary writer contention while GC holds authority", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "inline before", status: "active" }, "gc-race-0"));
    let releaseGc: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { releaseGc = resolve; });
    let reached!: () => void;
    const blocked = new Promise<void>(resolve => { reached = resolve; });
    const gcInstrumentation: GcInstrumentation = {
      at: async phase => { if (phase === "G3-inventory") { reached(); await gate; } }
    };
    const collector = value(await open({ gcInstrumentation }));
    const started = collector.collectGarbage();
    try {
      await Promise.race([blocked, started.then(() => { throw new Error("GC ended before the inventory marker"); })]);
      const concurrent = await runtime.addMemory({ content: "concurrent", status: "active" }, "gc-race-1");
      expect(failure(concurrent).code).toBe("WRITER_BUSY");
    } finally { releaseGc(); value(await started); }
    value(await runtime.close());
    value(await collector.close());
  });
});

describe("collectGarbage() durable-runtime facade member 19", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc facade large object payload ".repeat(3000);

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-facade-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  const open = async (io: DirectoryIO = simulatedDirectoryIO()) =>
    openDurableEtherMemoriesInternal({ userId: "gc-facade-user", directory, openMode: "auto" }, { io, files });

  const injectOrphan = async (content = "facade orphan") => {
    const digest = createHash("sha256").update(content).digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), digest + ".bin"), content);
  };

  it("collects orphans through the public facade, generation-neutral and tip-neutral", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-facade-1"));
    const referenced = await objectNames();
    await injectOrphan();
    const tip = value(runtime.tip);
    const snapshot = value(runtime.exportData());
    const summary = value(await runtime.collectGarbage());
    expect(summary).toEqual({ scannedObjects: referenced.length + 1, markedReferences: referenced.length,
      reclaimedObjects: 1, unknownArtifacts: 0 });
    expect(runtime.state).toBe("ready");
    expect(value(runtime.tip)).toEqual(tip);
    expect(value(runtime.exportData())).toEqual(snapshot);
    expect(await objectNames()).toEqual(referenced);
    const second = value(await runtime.collectGarbage());
    expect(second.reclaimedObjects).toBe(0);
    value(await runtime.close());
    const closed = await runtime.collectGarbage();
    expect(failure(closed).code).toBe("CLOSED");
  });

  it("keeps the runtime ready after maintenance failures, with exact partial details", async () => {
    let failObjectBarrier = false;
    const io: DirectoryIO = {
      ...simulatedDirectoryIO(),
      syncDirectory: async path => {
        if (failObjectBarrier && path === objectsDir()) {
          throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected facade barrier failure");
        }
        await simulatedDirectoryIO().syncDirectory(path);
      }
    };
    const runtime = value(await open(io));
    value(await runtime.addMemory({ content: "inline before gc", status: "active" }, "gc-ready-0"));
    await injectOrphan();
    failObjectBarrier = true;
    const failed = await runtime.collectGarbage();
    const error = failure(failed);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.details!.reclaimedObjects).toBe(1);
    expect(runtime.state).toBe("ready");
    failObjectBarrier = false;
    const note = value(await runtime.addMemory({ content: "still writable", status: "active" }, "gc-ready-1"));
    expect(note.id).toBeTruthy();
    const retry = value(await runtime.collectGarbage());
    expect(retry.reclaimedObjects).toBe(0);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("moves to recovery-required only when authoritative data becomes uncertain", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-authority-1"));
    const referenced = await objectNames();
    await fs.unlink(join(objectsDir(), referenced[0]!));
    const result = await runtime.collectGarbage();
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).details!.gcDisposition).toBe("authoritative");
    expect(runtime.state).toBe("recovery-required");
    const blocked = await runtime.addMemory({ content: "blocked", status: "active" }, "gc-authority-2");
    expect(failure(blocked).code).toBe("RECOVERY_REQUIRED");
    const blockedGc = await runtime.collectGarbage();
    expect(failure(blockedGc).code).toBe("RECOVERY_REQUIRED");
    const recovery = await runtime.recover();
    expect(recovery.ok).toBe(false);
    expect(runtime.state).toBe("recovery-required");
  });

  it("serializes concurrent GC requests and mutations through the single-flight queue", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "queue base", status: "active" }, "gc-queue-0"));
    await injectOrphan();
    const [first, second] = await Promise.all([runtime.collectGarbage(), runtime.collectGarbage()]);
    const reclaimed = [value(first).reclaimedObjects, value(second).reclaimedObjects].sort();
    expect(reclaimed).toEqual([0, 1]);
    expect(runtime.state).toBe("ready");
    await injectOrphan("second batch orphan");
    const [mutation, gc] = await Promise.all([
      runtime.addMemory({ content: "concurrent with gc", status: "active" }, "gc-queue-1"),
      runtime.collectGarbage()
    ]);
    expect(value(mutation).id).toBeTruthy();
    expect(value(gc).reclaimedObjects).toBe(1);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("returns exactly the approved detached summary shape and no implementation objects", async () => {
    const runtime = value(await open());
    const summary = value(await runtime.collectGarbage());
    expect(Object.keys(summary).sort()).toEqual(["markedReferences", "reclaimedObjects", "scannedObjects", "unknownArtifacts"]);
    for (const field of Object.values(summary)) expect(typeof field).toBe("number");
    expect("directory" in summary).toBe(false);
    expect("io" in summary).toBe(false);
    value(await runtime.close());
  });
});
describe("cascade production scale and rotation serialization attacks", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc attack large object payload ".repeat(3000);

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-attack-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  const open = async () => openDurableEtherMemoriesInternal({ userId: "gc-attack-user", directory, openMode: "auto" },
    { io, files });

  it("cascades past every production input-bank slot with exact sorted-set results and zero owned scratch", async () => {
    await fs.mkdir(join(directory, ".private"), { recursive: true });
    const limits = value(gcLimits());
    expect(limits).toEqual({ namespaceSlots: 128, chunkEntries: 512, unlinkBatch: 64 });
    const sorter = new GcDigestSorter(directory, "mark", io, files, limits, createGcSession());
    const count = 66_000;
    for (let index = 0; index < count; index++) {
      const added = await sorter.add(digest(index));
      if (!added.ok) throw new Error(JSON.stringify(added.error));
    }
    const finished = value(await sorter.finish());
    expect(finished!.records).toBe(count);
    let seen = 0;
    let last: string | undefined;
    for (const entry of await runLines(finished!.path)) {
      if (last !== undefined) expect(compareDigests(entry, last)).toBe(1);
      last = entry;
      seen++;
    }
    expect(seen).toBe(count);
    await sorter.sweep();
    expect(await fs.readdir(join(directory, ".private"))).toEqual([]);
  }, 300_000);

  it("preserves a rotation-1 object-backed result across three rotations, GC and restart", async () => {
    const runtime = value(await open());
    const first = value(await runtime.addMemory({ content: objectBackedContent(), tags: ["t8"], status: "active" }, "gc-rotations-1"));
    const objectsAfterFirst = await objectNames();
    value(await runtime.rotate());
    value(await runtime.addMemory({ content: "second epoch note", status: "active" }, "gc-rotations-2"));
    value(await runtime.rotate());
    value(await runtime.deleteMemory(first.id, "gc-rotations-3"));
    value(await runtime.rotate());
    const outcome = value(await runtime.collectGarbage());
    expect(outcome.reclaimedObjects).toBe(0);
    expect(await objectNames()).toEqual(objectsAfterFirst);
    const tip = value(runtime.tip);
    const snapshot = value(runtime.exportData());
    value(await runtime.close());
    const restarted = value(await open());
    expect(value(restarted.tip)).toEqual(tip);
    expect(value(restarted.exportData())).toEqual(snapshot);
    const retried = value(await restarted.addMemory({ content: objectBackedContent(), tags: ["t8"], status: "active" }, "gc-rotations-1"));
    expect(retried.id).toBe(first.id);
    expect(retried.createdAt.getTime()).toBe(first.createdAt.getTime());
    const afterRetry = value(await restarted.collectGarbage());
    expect(afterRetry.reclaimedObjects).toBe(0);
    expect(await objectNames()).toEqual(objectsAfterFirst);
    value(await restarted.close());
  });

  it("serializes GC with rotate() in both queue orders without interference", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-serial-1"));
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), "b".repeat(64) + ".bin"), "orphan before rotate");
    const rotatedFirst = await Promise.all([runtime.rotate(), runtime.collectGarbage()]);
    expect(value(rotatedFirst[0]).receiptCount).toBeGreaterThanOrEqual(1);
    expect(value(rotatedFirst[1]).reclaimedObjects).toBe(1);
    expect(runtime.state).toBe("ready");
    await fs.writeFile(join(objectsDir(), "c".repeat(64) + ".bin"), "orphan after rotate");
    const gcFirst = await Promise.all([runtime.collectGarbage(), runtime.rotate()]);
    expect(value(gcFirst[0]).reclaimedObjects).toBe(1);
    expect(value(gcFirst[1]).receiptCount).toBeGreaterThanOrEqual(1);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("recovers byte-equivalently after GC on a cold restart", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-cold-1"));
    value(await runtime.rotate());
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), "d".repeat(64) + ".bin"), "cold restart orphan");
    const summary = value(await runtime.collectGarbage());
    expect(summary.reclaimedObjects).toBe(1);
    const tip = value(runtime.tip);
    const snapshot = value(runtime.exportData());
    value(await runtime.close());
    const restarted = value(await open());
    expect(value(restarted.tip)).toEqual(tip);
    expect(value(restarted.exportData())).toEqual(snapshot);
    expect((await restarted.collectGarbage()).ok).toBe(true);
    value(await restarted.close());
  });
});

describe("hostile review repairs: terminal tip proof, scratch lifecycle, static symlink boundary", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc review large object payload ".repeat(3000);
  const walPath = async () => {
    const names = await fs.readdir(join(directory, "wal"));
    return join(directory, "wal", names[0]!);
  };

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-review-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  const open = async (deps: { io?: DirectoryIO; files?: WalIO; gcInstrumentation?: GcInstrumentation } = {}) =>
    openDurableEtherMemoriesInternal({ userId: "gc-review-user", directory, openMode: "auto" },
      { io: deps.io ?? io, files: deps.files ?? files, gcInstrumentation: deps.gcInstrumentation });

  const injectOrphan = async (content = "review orphan") => {
    const digest = createHash("sha256").update(content).digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), digest + ".bin"), content);
    return `${digest}.bin`;
  };

  it("fails closed before deletion when the active WAL is truncated to an earlier valid prefix", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-trunc-1"));
    const sizeAfterFirst = (await fs.stat(await walPath())).size;
    value(await runtime.addMemory({ content: objectBackedContent() + " two", status: "active" }, "gc-trunc-2"));
    value(await runtime.addMemory({ content: objectBackedContent() + " three", status: "active" }, "gc-trunc-3"));
    const committed = await objectNames();
    const orphan = await injectOrphan();
    await fs.truncate(await walPath(), sizeAfterFirst);
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("RECOVERY_REQUIRED");
    expect(error.details!.gcPhase).toBe("G2-mark");
    expect(error.details!.gcDisposition).toBe("authoritative");
    expect(error.details!.capturedTip).toBeDefined();
    expect(error.details!.durableTip).toBeDefined();
    expect(runtime.state).toBe("recovery-required");
    expect(await objectNames()).toEqual([...committed, orphan].sort());
    const recovery = await runtime.recover();
    expect(recovery.ok).toBe(true);
    expect(runtime.state).toBe("ready");
  });

  it("fails closed before deletion when the active WAL disappears under a committed tip", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-vanish-1"));
    const referenced = await objectNames();
    const orphan = await injectOrphan();
    await fs.unlink(await walPath());
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("RECOVERY_REQUIRED");
    expect(error.details!.gcPhase).toBe("G2-mark");
    expect(runtime.state).toBe("recovery-required");
    expect(await objectNames()).toEqual([...referenced, orphan].sort());
  });

  it("accepts legitimate post-rotation WAL absence and post-rotation WAL presence", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-absent-1"));
    value(await runtime.rotate());
    const afterRotation = value(await runtime.collectGarbage());
    expect(afterRotation.reclaimedObjects).toBe(0);
    expect(runtime.state).toBe("ready");
    value(await runtime.addMemory({ content: "inline after rotation", status: "active" }, "gc-absent-2"));
    const afterCommit = value(await runtime.collectGarbage());
    expect(afterCommit.reclaimedObjects).toBe(0);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("ships no independently callable destructive collector anywhere in its modules", async () => {
    // Source-level structural containment: the orchestrator is a module-private
    // closure inside the runtime module; the scratch/planning module exports
    // no collector at all.
    expect((gcModule as Record<string, unknown>).collectDurableGarbage).toBeUndefined();
    expect(Object.keys(gcModule)).not.toContain("collectDurableGarbage");
    expect(Object.hasOwn(publicApi, "collectDurableGarbage")).toBe(false);
    // The public API accepts no caller-supplied tip: the facade signature is
    // collectGarbage() with no arguments.
    const runtime = value(await open());
    expect(runtime.collectGarbage.length).toBe(0);
    value(await runtime.close());
  });

  it.each(["create", "write", "sync", "verify"] as const)
  ("keeps the runtime ready through an injected mark-scratch %s failure and recovers by retry", async mode => {
    let fault = false;
    const scratchFaultFiles: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        if (!fault || !path.includes("gc-mark")) return nodeWalIO.open(path, create);
        if (create) {
          if (mode === "create") throw new Error("injected mark-run create failure");
          const handle = await nodeWalIO.open(path, create);
          if (mode === "write") return { ...handle, write: async () => { throw new Error("injected mark-run write failure"); } } as WalFileHandle;
          if (mode === "sync") return { ...handle, sync: async () => { await handle.close(); throw new Error("injected mark-run sync failure"); } } as WalFileHandle;
          return handle;
        }
        if (mode === "verify") {
          const handle = await nodeWalIO.open(path, create);
          return { ...handle, read: async (bytes: Uint8Array) => { bytes.fill(0x7a); return bytes.byteLength; } } as WalFileHandle;
        }
        return nodeWalIO.open(path, create);
      }
    };
    const runtime = value(await open({ files: scratchFaultFiles }));
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-scratch-0"));
    const referenced = await objectNames();
    const orphan = await injectOrphan();
    const tip = value(runtime.tip);
    fault = true;
    const failed = await runtime.collectGarbage();
    const error = failure(failed);
    expect(error.details!.gcPhase).toBe("G2-mark-scratch");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(runtime.state).toBe("ready");
    expect(await objectNames()).toEqual([...referenced, orphan].sort());
    expect(value(runtime.tip)).toEqual(tip);
    fault = false;
    const note = value(await runtime.addMemory({ content: "writable after scratch failure", status: "active" }, "gc-scratch-1"));
    expect(note.id).toBeTruthy();
    const retry = value(await runtime.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(referenced);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("never unlinks or follows a candidate that is a static final-component symlink", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-link-1"));
    const referenced = await objectNames();
    const orphan = await injectOrphan("symlink orphan base");
    const linkTarget = join(parent, "outside-link-target");
    await fs.writeFile(linkTarget, "outside the store");
    await fs.unlink(join(objectsDir(), orphan));
    let symlinkCreated = true;
    try { await fs.symlink(linkTarget, join(objectsDir(), orphan), "file"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      symlinkCreated = false;
    }
    const outcome = value(await runtime.collectGarbage());
    if (symlinkCreated) {
      expect(outcome.unknownArtifacts).toBe(1);
      expect(outcome.reclaimedObjects).toBe(0);
      expect(await objectNames()).toEqual([...referenced, orphan].sort());
      expect(await fs.readFile(linkTarget, "utf8")).toBe("outside the store");
    } else {
      expect(outcome.unknownArtifacts).toBe(0);
      expect(await objectNames()).toEqual(referenced);
    }
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });
});

describe("exact-content scratch-integrity attacks across every proof stage", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc seal large object payload ".repeat(3000);

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-seal-"));
    directory = join(parent, "store");
  });
  afterEach(async () => {
    await closeRejectedHandles();
    await fs.rm(parent, { recursive: true, force: true });
  });

  const open = (deps: { files?: WalIO } = {}) => openDurableEtherMemoriesInternal({ userId: "gc-seal-user",
    directory, openMode: "auto" }, { io, files: deps.files ?? files });

  /**
   * Read-path substitution that preserves everything shape verification ever
   * checked: 64-hex lowercase syntax, LF framing, record count, file length -
   * and, when triggered on the whole-run verification read, the seal itself.
   * The substitution fires on the Nth read of a matching handle, so tests can
   * target the record-authorizing consumption read AFTER a clean seal pass.
   */
  const substitutingRead = (stage: "gc-mark" | "gc-inventory" | "gc-candidates" | "gc-validated",
    enabled: () => boolean, readIndex: number, replacementDigest: () => string): WalIO => ({
    ...nodeWalIO,
    open: async (path, create) => {
      const handle = await nodeWalIO.open(path, create);
      if (!path.includes(stage)) return handle;
      let reads = 0;
      return {
        ...handle,
        read: async (bytes: Uint8Array, position: number) => {
          const read = await handle.read(bytes, position);
          if (enabled() && reads++ === readIndex && position % 129 === 0) {
            const record = Buffer.from(replacementDigest() + Buffer.from(bytes.subarray(64, bytes.byteLength)).toString("utf8"), "utf8");
            bytes.set(record.subarray(0, Math.min(record.byteLength, bytes.byteLength)));
          }
          return read;
        }
      } as WalFileHandle;
    }
  });

  /** Write-path substitution: legal bytes that differ from the intended output. */
  const substitutingWrite = (stage: "gc-mark-a" | "gc-mark-b" | "gc-inventory",
    enabled: () => boolean, replacement: () => string): WalIO => ({
    ...nodeWalIO,
    open: async (path, create) => {
      const handle = await nodeWalIO.open(path, create);
      if (!create || !path.includes(stage) || !enabled()) return handle;
      let substituted = false;
      return {
        ...handle,
        write: async (bytes: Uint8Array, position: number) => {
          if (!substituted) {
            substituted = true;
            const record = Buffer.from(replacement() + Buffer.from(bytes.subarray(64, bytes.byteLength)).toString("utf8"), "utf8");
            return handle.write(record, position);
          }
          return handle.write(bytes, position);
        }
      } as WalFileHandle;
    }
  });

  it.each(["gc-mark", "gc-inventory"] as const)
  ("fails closed when the %s run is substituted after its clean seal pass, before consumption", async stage => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-1"));
    const referenced = await objectNames();
    const orphan = createHash("sha256").update("seal stage orphan").digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), orphan + ".bin"), "seal stage orphan");
    let corrupt = false;
    const corrupting = substitutingRead(stage, () => corrupt, 1,
      () => createHash("sha256").update("substitute").digest("hex"));
    const collector = value(await open({ files: corrupting }));
    corrupt = true;
    const result = await collector.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    // Nothing was reclaimed: every committed object and the orphan survive.
    expect(await objectNames()).toEqual([...referenced, orphan + ".bin"].sort());
    corrupt = false;
    const retry = value(await collector.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(referenced);
    value(await runtime.close());
    value(await collector.close());
  });

  it("treats a scratch close rejection as maintenance: ready runtime, zero unlink, retry succeeds", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-close-1"));
    const referenced = await objectNames();
    const orphan = createHash("sha256").update("close orphan").digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), orphan + ".bin"), "close orphan");
    let failClose = false;
    const closeFailing: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        const handle = await nodeWalIO.open(path, create);
        if (!create || !path.includes("gc-mark") || !failClose) return handle;
        return { ...handle, close: async () => { rejectedCloseHandles.add(handle); throw new Error("injected scratch close rejection"); } } as WalFileHandle;
      }
    };
    const collector = value(await open({ files: closeFailing }));
    failClose = true;
    const result = await collector.collectGarbage();
    const error = failure(result);
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(["G2-mark-scratch", "G3-inventory"]).toContain(error.details!.gcPhase);
    expect(collector.state).toBe("ready");
    // Zero payload unlink: every committed object and the orphan survive.
    expect(await objectNames()).toEqual([...referenced, orphan + ".bin"].sort());
    failClose = false;
    const retry = value(await collector.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(referenced);
    value(await runtime.close());
    value(await collector.close());
  });

  it("fails closed when the candidates run is substituted after its clean seal pass", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-2"));
    const referenced = await objectNames();
    const orphan = createHash("sha256").update("candidates orphan").digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), orphan + ".bin"), "candidates orphan");
    let corrupt = false;
    const corrupting = substitutingRead("gc-candidates", () => corrupt, 1, () => referenced[0]!.slice(0, 64));
    const collector = value(await open({ files: corrupting }));
    corrupt = true;
    const result = await collector.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(await objectNames()).toEqual([...referenced, orphan + ".bin"].sort());
    corrupt = false;
    const retry = value(await collector.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(referenced);
    value(await runtime.close());
    value(await collector.close());
  });

  it("fails closed BEFORE UNLINK when the validated record is substituted orphan->committed (the data-loss path)", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-3"));
    const referenced = await objectNames();
    const orphan = createHash("sha256").update("validated orphan").digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), orphan + ".bin"), "validated orphan");
    // The whole-run seal verifies against the real bytes (read #1); the
    // record-authorizing read (read #2) returns the COMMITTED digest with the
    // original tag - legal syntax, same length, same count, unchanged stamp.
    // Only per-record authentication catches it, before the unlink.
    let corrupt = false;
    const corrupting = substitutingRead("gc-validated", () => corrupt, 1, () => referenced[0]!.slice(0, 64));
    const collector = value(await open({ files: corrupting }));
    corrupt = true;
    const result = await collector.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(error.details!.gcPhase).toBe("G6-reclaim");
    expect(error.details!.reclaimedObjects).toBe(0);
    // THE critical properties: the committed object was NOT deleted, the
    // orphan survives this attempt, and the runtime stays ready.
    expect(await objectNames()).toEqual([...referenced, orphan + ".bin"].sort());
    expect(collector.state).toBe("ready");
    corrupt = false;
    const retry = value(await collector.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(referenced);
    value(await runtime.close());
    value(await collector.close());
  });

  it.each(["gc-mark-a", "gc-mark-b"] as const)
  ("fails closed when a %s write is substituted before its write-time binding verification", async stage => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-4"));
    const referenced = await objectNames();
    const orphan = createHash("sha256").update("write orphan").digest("hex");
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), orphan + ".bin"), "write orphan");
    let corrupt = true;
    const corrupting = substitutingWrite(stage, () => corrupt,
      () => createHash("sha256").update("write substitute").digest("hex"));
    const collector = value(await open({ files: corrupting }));
    const result = await collector.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("maintenance");
    expect(["G2-mark-scratch", "G3-inventory"]).toContain(error.details!.gcPhase);
    expect(await objectNames()).toEqual([...referenced, orphan + ".bin"].sort());
    corrupt = false;
    const retry = value(await collector.collectGarbage());
    expect(retry.reclaimedObjects).toBe(1);
    value(await runtime.close());
    value(await collector.close());
  });

  it("separates G4 scratch corruption (maintenance) from a genuine missing marked object (authoritative)", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-5"));
    const referenced = await objectNames();
    await fs.unlink(join(objectsDir(), referenced[0]!));
    const authoritative = await runtime.collectGarbage();
    expect(failure(authoritative).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(authoritative).details!.gcDisposition).toBe("authoritative");
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.close());
    // Maintenance: transient G4 scratch read failure never touches authority,
    // proven on an independent, fully coherent second store.
    const secondDirectory = join(parent, "store2");
    const second = value(await openDurableEtherMemoriesInternal({ userId: "gc-seal-user",
      directory: secondDirectory, openMode: "auto" }, { io, files }));
    value(await second.addMemory({ content: objectBackedContent(), status: "active" }, "gc-seal-6"));
    let failRead = false;
    const transient = substitutingRead("gc-inventory", () => failRead, 1, () => "0".repeat(64));
    const transientRuntime = value(await openDurableEtherMemoriesInternal({ userId: "gc-seal-user",
      directory: secondDirectory, openMode: "existing" }, { io, files: transient }));
    failRead = true;
    const result = await transientRuntime.collectGarbage();
    expect(failure(result).details!.gcDisposition).toBe("maintenance");
    expect(transientRuntime.state).toBe("ready");
    failRead = false;
    const retry = await transientRuntime.collectGarbage();
    expect(retry.ok).toBe(true);
    value(await second.close());
    value(await transientRuntime.close());
  });
});

describe("authority-layer failure precedence over maintenance dispositions", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-authority-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  it.each(["G1-scratch-sweep", "G2-mark-scratch", "G6-reclaim", "G7-final-cleanup"] as const)
  ("a maintenance %s failure plus a failed authority release forces recovery-required", async primary => {
    let failLockRelease = false;
    let failScratch = false;
    let failObjectUnlink = false;
    const io: DirectoryIO = {
      ...simulatedDirectoryIO(),
      removeOwnedFile: async path => {
        if (failLockRelease && path.endsWith("writer.lock")) {
          throw Object.assign(new Error("lock release denied"), { code: "EPERM" });
        }
        if (primary === "G1-scratch-sweep" && failScratch && path.includes(".private") && path.includes("gc-")) {
          throw Object.assign(new Error("scratch sweep denied"), { code: "EACCES" });
        }
        if (primary === "G6-reclaim" && failObjectUnlink && path.includes("objects")) {
          throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
        }
        await simulatedDirectoryIO().removeOwnedFile(path);
      },
      syncDirectory: async path => {
        if (primary === "G7-final-cleanup" && failScratch && path.endsWith(".private")) {
          throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected final cleanup barrier failure");
        }
        await simulatedDirectoryIO().syncDirectory(path);
      }
    };
    const failingFiles: WalIO = {
      ...nodeWalIO,
      open: async (path, create) => {
        if (primary === "G2-mark-scratch" && failScratch && create && path.includes("gc-mark")) {
          throw new Error("injected mark-run create failure");
        }
        return nodeWalIO.open(path, create);
      }
    };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "gc-authority-user", directory },
      { io, files: failingFiles }));
    value(await runtime.addMemory({ content: "authority base", status: "active" }, "gc-auth-0"));
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), "a".repeat(64) + ".bin"), "orphan for authority");
    if (primary === "G1-scratch-sweep" || primary === "G2-mark-scratch") failScratch = true;
    if (primary === "G6-reclaim") failObjectUnlink = true;
    failLockRelease = true;
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("RECOVERY_REQUIRED");
    expect(error.details!.authorityReleaseFailed).toBe(true);
    expect(runtime.state).toBe("recovery-required");
    const blocked = await runtime.addMemory({ content: "blocked", status: "active" }, "gc-auth-1");
    expect(failure(blocked).code).toBe("RECOVERY_REQUIRED");
    failLockRelease = false;
    failScratch = false;
    failObjectUnlink = false;
    // The release failure left the writer lock in place; the frozen contract
    // never breaks a stale lock automatically, so the operator removes it
    // before explicit recovery.
    await fs.unlink(join(directory, "writer.lock"));
    const recovery = await runtime.recover();
    expect(recovery.ok).toBe(true);
    expect(runtime.state).toBe("ready");
    value(await runtime.close());
  });

  it("forces recovery-required when a fully successful collection cannot release authority", async () => {
    let failLockRelease = false;
    const io: DirectoryIO = {
      ...simulatedDirectoryIO(),
      removeOwnedFile: async path => {
        if (failLockRelease && path.endsWith("writer.lock")) {
          throw Object.assign(new Error("lock release denied"), { code: "EPERM" });
        }
        await simulatedDirectoryIO().removeOwnedFile(path);
      }
    };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "gc-authority-user", directory }, { io }));
    value(await runtime.addMemory({ content: "success base", status: "active" }, "gc-auth-2"));
    await fs.mkdir(objectsDir(), { recursive: true });
    await fs.writeFile(join(objectsDir(), "b".repeat(64) + ".bin"), "orphan before release failure");
    failLockRelease = true;
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("RECOVERY_REQUIRED");
    expect(error.details!.authorityReleaseFailed).toBe(true);
    expect(runtime.state).toBe("recovery-required");
    failLockRelease = false;
    await fs.unlink(join(directory, "writer.lock"));
    const recovery = await runtime.recover();
    expect(recovery.ok).toBe(true);
    value(await runtime.close());
  });

  it("treats an authority acquisition failure as ordinary contention without lifecycle change", async () => {
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "gc-authority-user", directory },
      { io: simulatedDirectoryIO() }));
    value(await runtime.addMemory({ content: "acquire base", status: "active" }, "gc-auth-3"));
    await fs.writeFile(join(directory, "writer.lock"), "foreign writer");
    const result = await runtime.collectGarbage();
    expect(failure(result).code).toBe("WRITER_BUSY");
    expect(runtime.state).toBe("ready");
    await fs.unlink(join(directory, "writer.lock"));
    const retry = value(await runtime.collectGarbage());
    expect(retry.reclaimedObjects).toBe(0);
    value(await runtime.close());
  });
});

describe("persisted-authority corruption and package containment", () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-corruption-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  it("classifies a corrupted authoritative receipt ledger as authoritative corruption", async () => {
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: "gc-corruption-user", directory }, { io, files }));
    value(await runtime.addMemory({ content: "corruption base ".repeat(3000), status: "active" }, "gc-corr-1"));
    value(await runtime.rotate());
    const ledger = (await fs.readdir(join(directory, "receipts")))[0]!;
    const bytes = await fs.readFile(join(directory, "receipts", ledger));
    bytes[bytes.byteLength - 2] = 0x7a;
    await fs.writeFile(join(directory, "receipts", ledger), bytes);
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("authoritative");
    expect(runtime.state).toBe("recovery-required");
    value(await runtime.close());
  });

  it("does not publish the destructive collector at the package root", () => {
    expect(Object.hasOwn(publicApi, "collectDurableGarbage")).toBe(false);
    expect(Object.hasOwn(publicApi, "GcDigestSorter")).toBe(false);
    expect(Object.hasOwn(publicApi, "SealedRunReader")).toBe(false);
  });
});

describe("persisted WAL reference classification at the GC reading boundary", { timeout: 300_000 }, () => {
  let parent: string;
  let directory: string;
  const io = simulatedDirectoryIO();
  const files = nodeWalIO;
  const objectsDir = () => join(directory, "objects");
  const objectNames = async () => (await fs.readdir(objectsDir())).sort();
  const objectBackedContent = () => "gc codex large object payload ".repeat(3000);
  const walPath = async () => {
    const names = await fs.readdir(join(directory, "wal"));
    return join(directory, "wal", names[0]!);
  };

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-codex-"));
    directory = join(parent, "store");
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  const open = () => openDurableEtherMemoriesInternal({ userId: "gc-codex-user", directory, openMode: "auto" },
    { io, files });

  /** A registry that accepts ANY payload at ENCODE time only; GC scans with
   * the frozen productionRegistry, so forged frames fail persisted validation. */
  const laxRegistry = value(createReplayRegistry([{ type: "ether.note.put", version: "1",
    validate: () => ok(undefined), reduce: (state, payload) => ok({ ...state, forged: payload }) }]));

  const forgedFrame = (base: CommittedTip, storeId: string, payload: Record<string, unknown>) =>
    value(encodeWalFrame({
      storeId,
      format: { format: WAL_FORMAT, version: WAL_VERSION },
      expectedBase: base,
      identity: { epochId: base.epochId, txId: value(parseTransactionSequenceId((BigInt(base.txId) + 1n).toString())) },
      mutation: { mutationId: "forged-mutation" as never, digest: "f".repeat(64) },
      audit: null,
      operations: [{ type: "ether.note.put", version: "1", payload: payload as never }]
    }, laxRegistry));

  const validReference = () => {
    const bytes = value(encodeEtherData({ id: "forged", content: "x".repeat(70_000) }));
    return { encoding: OBJECT_REFERENCE, profile: ETHER_DATA_PROFILE,
      digest: referenceFor(bytes).digest, byteLength: bytes.byteLength };
  };

  const cases: ReadonlyArray<[string, () => Record<string, unknown>]> = [
    ["wrong digest length", () => ({ ...validReference(), digest: "abc" })],
    ["non-hex digest", () => ({ ...validReference(), digest: "z".repeat(64) })],
    ["uppercase noncanonical digest", () => ({ ...validReference(), digest: "A".repeat(64) })],
    ["unexpected extra fields", () => ({ ...validReference(), extra: 1 })],
    ["unknown persisted encoding", () => ({ encoding: "ether.unknown.v1", data: "{}" })]
  ];

  it.each(cases)("classifies a persisted %s in the active WAL as authoritative corruption", async (_, forge) => {
    const runtime = value(await open());
    const committed = value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-codex-1"));
    expect(committed.id).toBeTruthy();
    const referenced = await objectNames();
    const head = value(decodeStoreHead(Buffer.from(await fs.readFile(join(directory, "HEAD")))));
    // Append a forged frame the frozen production registry rejects; the GC
    // reading boundary must classify the failure as persisted corruption.
    await fs.appendFile(await walPath(), forgedFrame(value(runtime.tip), head.storeId, forge()).bytes);
    const result = await runtime.collectGarbage();
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.gcDisposition).toBe("authoritative");
    expect(runtime.state).toBe("recovery-required");
    // Zero payload unlink: every committed object survives untouched.
    expect(await objectNames()).toEqual(referenced);
  });

  it("keeps caller-facing reference validation semantics unchanged", () => {
    // The frozen caller-facing validator keeps its own classification at
    // install boundaries; only the GC persistence-reading boundary normalizes.
    const malformed = { ...validReference(), digest: "zz" };
    expect(failure(validateReference(malformed as never)).code).toBe("INVALID_INPUT");
    const unknownProfile = { ...validReference(), profile: "ether.unknown.v1" };
    expect(failure(validateReference(unknownProfile as never)).code).toBe("UNSUPPORTED_PERSISTENCE_FORMAT");
  });

  it("retains receipt-ledger persisted corruption as authoritative corruption", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-codex-2"));
    value(await runtime.rotate());
    const ledger = (await fs.readdir(join(directory, "receipts")))[0]!;
    const bytes = await fs.readFile(join(directory, "receipts", ledger));
    bytes[bytes.byteLength - 2] = 0x7a;
    await fs.writeFile(join(directory, "receipts", ledger), bytes);
    const result = await runtime.collectGarbage();
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(failure(result).details!.gcDisposition).toBe("authoritative");
    expect(runtime.state).toBe("recovery-required");
  });
});
