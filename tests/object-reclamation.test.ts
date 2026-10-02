import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../src/persistence/directoryIO.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "../src/persistence/walIO.js";
import { encodeEtherData, ETHER_DATA_PROFILE } from "../src/persistence/etherData.js";
import { referenceFor } from "../src/persistence/payloadObjects.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { simulatedDirectoryIO } from "./helpers/wal.js";
import {
  GC_CANDIDATES_NAME, collectDurableGarbage, compareDigests, deriveReclaimCandidates, extractObjectDigest, gcLimits,
  GcDigestSorter, mergeDigestRuns, readDigestFile, sweepGcScratch, verifyDigestFile,
  type GcLimits
} from "../src/persistence/objectReclamation.js";
import type { WalOperation } from "../src/types/persistence.js";

const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const failure = (result: { ok: boolean; error?: unknown }) => {
  if (result.ok) throw new Error("expected a failure result");
  return result.error as { code: string; message: string; details?: Record<string, unknown> };
};

/** Distinct, hex-colliding-free digests; order under compareDigests is stable. */
const digest = (index: number) => index.toString(16).padStart(64, "0");
const sortedDigests = (count: number) => Array.from({ length: count }, (_, i) => digest(i)).sort(compareDigests);
const objectReference = (bytes: Uint8Array): WalOperation => ({
  type: "ether.note.put", version: "1", payload: referenceFor(bytes) as unknown as WalOperation["payload"]
});
const inlineOperation = (): WalOperation => ({
  type: "ether.note.put", version: "1",
  payload: { encoding: ETHER_DATA_PROFILE, data: Buffer.from(value(encodeEtherData({ id: "a" }))).toString("utf8") }
});

const testLimits = (overrides: Partial<GcLimits> = {}): GcLimits =>
  value(gcLimits({ namespaceSlots: 4, chunkEntries: 4, unlinkBatch: 4, ...overrides }));

describe("two-bank cascade digest sorter", () => {
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
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits());
    expect(value(await sorter.finish())).toBeUndefined();
    expect(await privateNames()).toEqual([]);
  });

  it("sorts one chunk into one verified strictly-increasing run", async () => {
    const sorter = new GcDigestSorter(directory, "inventory", io, files, testLimits());
    const input = [digest(9), digest(3), digest(7), digest(1)];
    for (const entry of input) value(await sorter.add(entry));
    const finished = value(await sorter.finish());
    expect(finished!.entries).toBe(4);
    expect((await verifyDigestFile(finished!.path, files, 4)).ok).toBe(true);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(finished!.path, files)) streamed.push(entry);
    expect(streamed).toEqual([...input].sort(compareDigests));
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("collapses duplicate marks with exact set semantics across chunks and banks", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits({ chunkEntries: 2, namespaceSlots: 2 }));
    const distinct = sortedDigests(30);
    for (const entry of [...distinct, ...distinct].sort(compareDigests)) value(await sorter.add(entry));
    const finished = value(await sorter.finish());
    expect(finished!.entries).toBe(30);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(finished!.path, files)) streamed.push(entry);
    expect(streamed).toEqual(distinct);
  });

  it("cascades when every input-bank slot is occupied and never overwrites a consumed run", async () => {
    // slots=4, chunk=4: filling 17 chunks forces repeated bank transitions.
    const limits = testLimits({ namespaceSlots: 4, chunkEntries: 4 });
    const sorter = new GcDigestSorter(directory, "mark", io, files, limits);
    const distinct = sortedDigests(68);
    for (const entry of distinct) value(await sorter.add(entry));
    const finished = value(await sorter.finish());
    expect(finished!.entries).toBe(68);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(finished!.path, files)) streamed.push(entry);
    expect(streamed).toEqual(distinct);
    // Exactly one final run remains after the collapse.
    expect((await privateNames()).filter(name => name.startsWith("gc-mark"))).toHaveLength(1);
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("reaches multiple cascade levels with a small namespace and exact results", async () => {
    const limits = testLimits({ namespaceSlots: 2, chunkEntries: 2 });
    const sorter = new GcDigestSorter(directory, "inventory", io, files, limits);
    const distinct = sortedDigests(100);
    for (const entry of distinct) value(await sorter.add(entry));
    const finished = value(await sorter.finish());
    expect(finished!.entries).toBe(100);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(finished!.path, files)) streamed.push(entry);
    expect(streamed).toEqual(distinct);
    await sorter.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("fails closed on a non-hex digest input", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits());
    const result = await sorter.add("not-a-digest");
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(await privateNames()).toEqual([]);
  });

  it("reserves before create: debris occupying the next slot fails the flush", async () => {
    const sorter = new GcDigestSorter(directory, "mark", io, files, testLimits());
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
          return { ...handle, read: async (bytes, position) => { bytes.fill(0x7a); return bytes.byteLength; } } as WalFileHandle;
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
        ? async (path) => { if (path.endsWith(".private")) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected barrier failure"); }
        : io.syncDirectory
    };
    const sorter = new GcDigestSorter(directory, "mark", failingIo, failingFiles, limits);
    let observed: { ok: true } | { ok: false; error: { code: string } } | undefined;
    for (const entry of sortedDigests(10)) {
      const added = await sorter.add(entry);
      if (!added.ok) { observed = added; break; }
    }
    const finished = observed ?? await sorter.finish();
    const error = failure(finished);
    expect(["RECOVERY_REQUIRED", "READ_ONLY_LOCKED", "DURABILITY_UNAVAILABLE", "PERSISTENCE_CORRUPTION"]).toContain(error.code);
    // Debris is inert: a fresh attempt sweeps it deterministically and succeeds.
    const retry = new GcDigestSorter(directory, "mark", io, files, limits);
    value(await sweepGcScratch(directory, io, limits, "G1-scratch-sweep"));
    for (const entry of sortedDigests(10)) value(await retry.add(entry));
    const retried = value(await retry.finish());
    expect(retried!.entries).toBe(10);
    await retry.sweep();
    expect(await privateNames()).toEqual([]);
  });

  it("keeps verified merge output and undeleted source runs as legal coexisting crash debris", async () => {
    // Crash exactly after output verification but before input deletion.
    const limits = testLimits({ namespaceSlots: 2, chunkEntries: 2 });
    const crashingIo: DirectoryIO = {
      ...io,
      removeOwnedFile: async path => {
        if (path.includes("-a-")) throw new Error("simulated crash during source-run replacement");
        await io.removeOwnedFile(path);
      }
    };
    const sorter = new GcDigestSorter(directory, "mark", crashingIo, files, limits);
    let crashed = false;
    for (const entry of sortedDigests(8)) {
      const added = await sorter.add(entry);
      if (!added.ok) { expect(failure(added).code).toBe("RECOVERY_REQUIRED"); crashed = true; break; }
    }
    if (!crashed) expect(failure(await sorter.finish()).code).toBe("RECOVERY_REQUIRED");
    const names = await privateNames();
    // Both the verified bank-b output and the bank-a source runs survive.
    expect(names.some(name => name.includes("gc-mark-b-"))).toBe(true);
    expect(names.filter(name => name.includes("gc-mark-a-")).length).toBeGreaterThan(0);
    // The verified output alone is a correct merged run of the consumed inputs.
    const outputPath = join(directory, ".private", "gc-mark-b-000000.run");
    const streamed: string[] = [];
    for await (const entry of readDigestFile(outputPath, files)) streamed.push(entry);
    expect(streamed).toEqual(sortedDigests(8).slice(0, 4));
    // Retry: deterministic sweep removes both banks and produces the same result.
    value(await sweepGcScratch(directory, io, limits, "G1-scratch-sweep"));
    expect(await privateNames()).toEqual([]);
    const retry = new GcDigestSorter(directory, "mark", io, files, limits);
    for (const entry of sortedDigests(8)) value(await retry.add(entry));
    expect(value(await retry.finish())!.entries).toBe(8);
    await retry.sweep();
  });

  it("mergeDigestRuns deduplicates, verifies and reports exact accounting", async () => {
    const runA = join(directory, ".private", "gc-mark-a-000000.run");
    const runB = join(directory, ".private", "gc-mark-a-000001.run");
    await fs.writeFile(runA, Buffer.from([digest(1), digest(3), digest(3)].map(d => d + "\n").join("")));
    await fs.writeFile(runB, Buffer.from([digest(2), digest(5)].map(d => d + "\n").join("")));
    const output = join(directory, ".private", "gc-mark-b-000000.run");
    const merged = value(await mergeDigestRuns([runA, runB], output, files));
    expect(merged).toEqual({ entries: 4, bytes: 4 * 65 });
    expect((await verifyDigestFile(output, files, 4)).ok).toBe(true);
  });
});

describe("exact reachability merge", () => {
  let parent: string;
  let directory: string;
  const files = nodeWalIO;
  const candidatesPath = () => join(directory, ".private", GC_CANDIDATES_NAME);
  const writeRun = async (name: string, entries: string[]) => {
    await fs.writeFile(join(directory, ".private", name), Buffer.from(entries.map(e => e + "\n").join("")));
    return join(directory, ".private", name);
  };

  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), "ether-gc-merge-"));
    directory = join(parent, "store");
    await fs.mkdir(join(directory, ".private"), { recursive: true });
  });
  afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

  it("treats an empty mark set and empty inventory as a valid no-object store", async () => {
    const coverage = value(await deriveReclaimCandidates(undefined, undefined, candidatesPath(), files));
    expect(coverage).toEqual({ candidatesPath: undefined, candidates: 0, reachable: 0 });
  });

  it("marks every inventory object a candidate when no marks exist", async () => {
    const inventory = await writeRun("gc-inventory-a-000000.run", sortedDigests(3));
    const coverage = value(await deriveReclaimCandidates(undefined, inventory, candidatesPath(), files));
    expect(coverage.candidates).toBe(3);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(coverage.candidatesPath!, files)) streamed.push(entry);
    expect(streamed).toEqual(sortedDigests(3));
  });

  it("writes zero candidates when every object is reachable", async () => {
    const marks = await writeRun("gc-mark-a-000000.run", sortedDigests(2));
    const inventory = await writeRun("gc-inventory-a-000000.run", sortedDigests(2));
    const coverage = value(await deriveReclaimCandidates(marks, inventory, candidatesPath(), files));
    expect(coverage).toEqual({ candidatesPath: undefined, candidates: 0, reachable: 2 });
    expect(await fs.readdir(join(directory, ".private"))).not.toContain(GC_CANDIDATES_NAME);
  });

  it("separates reachable objects from candidates in one exact merge", async () => {
    const all = sortedDigests(10);
    const marks = await writeRun("gc-mark-a-000000.run", all.slice(0, 4).concat(all.slice(6, 8)));
    const inventory = await writeRun("gc-inventory-a-000000.run", all);
    const coverage = value(await deriveReclaimCandidates(marks, inventory, candidatesPath(), files));
    expect(coverage.candidates).toBe(4);
    expect(coverage.reachable).toBe(6);
    const streamed: string[] = [];
    for await (const entry of readDigestFile(coverage.candidatesPath!, files)) streamed.push(entry);
    expect(streamed).toEqual(all.slice(4, 6).concat(all.slice(8)));
  });

  it("fails closed when a marked active-WAL/receipt object is missing from the inventory", async () => {
    const marks = await writeRun("gc-mark-a-000000.run", sortedDigests(5));
    const inventory = await writeRun("gc-inventory-a-000000.run", sortedDigests(5).slice(0, 3));
    const result = await deriveReclaimCandidates(marks, inventory, candidatesPath(), files);
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    expect(error.details!.missingDigest).toBe(sortedDigests(5)[3]);
    expect(await fs.readdir(join(directory, ".private"))).not.toContain(GC_CANDIDATES_NAME);
  });

  it("fails closed when the inventory is absent while marks exist", async () => {
    const marks = await writeRun("gc-mark-a-000000.run", sortedDigests(2));
    const result = await deriveReclaimCandidates(marks, undefined, candidatesPath(), files);
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
  });

  it("fails closed when marks remain after inventory EOF", async () => {
    const marks = await writeRun("gc-mark-a-000000.run", sortedDigests(4));
    const inventory = await writeRun("gc-inventory-a-000000.run", sortedDigests(10).slice(1, 2));
    const result = await deriveReclaimCandidates(marks, inventory, candidatesPath(), files);
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
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

  it("fails closed on a malformed OBJECT_REFERENCE", () => {
    const operation = objectReference(value(encodeEtherData({ id: "x" })));
    const corrupted = { ...operation, payload: { ...operation.payload, digest: "zz" } } as WalOperation;
    expect(failure(extractObjectDigest(corrupted)).code).toBe("INVALID_INPUT");
  });

  it("fails closed on a non-object payload", () => {
    const operation = { type: "ether.note.put", version: "1", payload: null } as unknown as WalOperation;
    expect(failure(extractObjectDigest(operation)).code).toBe("PERSISTENCE_CORRUPTION");
  });
});

describe("G0-G7 reclamation protocol", () => {
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

  const open = async (deps: { io?: DirectoryIO; files?: WalIO } = {}) =>
    openDurableEtherMemoriesInternal({ userId: "gc-protocol-user", directory, openMode: "auto" },
      { io: deps.io ?? io, files: deps.files ?? files });

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
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome).toEqual({ scannedObjects: referenced.length + 1, markedReferences: referenced.length,
      reclaimedObjects: 1, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual(referenced);
    expect(value(runtime.tip)).toEqual(tip);
    expect(value(runtime.exportData())).toEqual(snapshot);
    const second = value(await collectDurableGarbage({ directory, io, files }));
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
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome.reclaimedObjects).toBe(0);
    expect(outcome.markedReferences).toBe(objectsBefore.length);
    expect(await objectNames()).toEqual(objectsBefore);
    value(await runtime.close());
    const reopened = value(await open());
    const retried = value(await reopened.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-historical-1"));
    expect(retried.id).toBe(large.id);
    expect(retried.createdAt.getTime()).toBe(large.createdAt.getTime());
    const afterRetry = value(await collectDurableGarbage({ directory, io, files }));
    expect(afterRetry.reclaimedObjects).toBe(0);
    value(await reopened.close());
  });

  it("fails closed before deletion when an active-WAL-referenced object is missing", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-wal-root"));
    const referenced = await objectNames();
    await injectOrphan("orphan while corrupted");
    await fs.unlink(join(objectsDir(), referenced[0]!));
    const result = await collectDurableGarbage({ directory, io, files });
    const error = failure(result);
    expect(error.code).toBe("PERSISTENCE_CORRUPTION");
    // No deletion occurred: the injected orphan is untouched.
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
    const result = await collectDurableGarbage({ directory, io, files });
    expect(failure(result).code).toBe("PERSISTENCE_CORRUPTION");
    expect(await objectNames()).toEqual(referenced.slice(1));
    value(await runtime.close());
  });

  it("treats a missing objects directory as zero inventory only when no marks exist", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "inline note", status: "active" }, "gc-inline-1"));
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome).toEqual({ scannedObjects: 0, markedReferences: 0, reclaimedObjects: 0, unknownArtifacts: 0 });
    value(await runtime.close());
  });

  it("treats a missing objects directory with authoritative marks as corruption", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-marks-1"));
    await fs.rm(objectsDir(), { recursive: true, force: true });
    const result = await collectDurableGarbage({ directory, io, files });
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
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
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
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome).toEqual({ scannedObjects: 1, markedReferences: 0, reclaimedObjects: 1, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual([]);
    value(await runtime.close());
  });

  it("never classifies a reachable corrupt-content object as garbage", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), tags: ["gc"], status: "active" }, "gc-corrupt-1"));
    const referenced = await objectNames();
    await fs.writeFile(join(objectsDir(), referenced[0]!), "corrupted bytes");
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
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
    // The installed-but-never-committed objects are genuine orphans.
    const orphans = await objectNames();
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    const outcome = value(await collectDurableGarbage({ directory, io, files: crashingFiles }));
    expect(outcome).toEqual({ scannedObjects: orphans.length, markedReferences: 0,
      reclaimedObjects: orphans.length, unknownArtifacts: 0 });
    expect(await objectNames()).toEqual([]);
    value(await runtime.close());
  });

  it("keeps every object when interrupted before deletion, then succeeds on retry", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: objectBackedContent(), status: "active" }, "gc-interrupt-1"));
    const orphanName = (await injectOrphan("interrupted orphan")) + ".bin";
    const before = await objectNames();
    const interrupted = await collectDurableGarbage({ directory, io, files,
      instrumentation: { at: async phase => { if (phase === "G6-reclaim") throw new Error("simulated crash before deletion"); } } });
    expect(failure(interrupted).code).toBe("RECOVERY_REQUIRED");
    expect(await objectNames()).toEqual(before);
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome.reclaimedObjects).toBe(1);
    expect(await objectNames()).toEqual(before.filter(name => name !== orphanName));
    value(await runtime.close());
  });

  it("reports exact partial reclaim accounting when an unlink fails mid-deletion", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "inline only", status: "active" }, "gc-partial-1"));
    await injectOrphan("orphan one");
    await injectOrphan("orphan two");
    await injectOrphan("orphan three");
    let unlinks = 0;
    const failingIo: DirectoryIO = {
      ...io,
      removeOwnedFile: async path => {
        if (path.includes("objects") && ++unlinks === 2) throw Object.assign(new Error("denied"), { code: "EACCES" });
        await io.removeOwnedFile(path);
      }
    };
    const result = await collectDurableGarbage({ directory, io: failingIo, files });
    const error = failure(result);
    expect(error.code).toBe("READ_ONLY_LOCKED");
    const details = error.details as Record<string, number>;
    expect(details.reclaimedObjects).toBe(1);
    expect(details.remainingCandidates).toBe(2);
    expect(details.gcPhase).toBe("G6-reclaim");
    expect((await objectNames())).toHaveLength(2);
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome.reclaimedObjects).toBe(2);
    expect(await objectNames()).toHaveLength(0);
    value(await runtime.close());
  });

  it("reports a barrier failure as a partial maintenance failure with exact accounting", async () => {
    const runtime = value(await open());
    await injectOrphan("barrier orphan");
    const failingIo: DirectoryIO = {
      ...io,
      syncDirectory: async path => {
        if (path === objectsDir()) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "injected barrier failure");
        await io.syncDirectory(path);
      }
    };
    const result = await collectDurableGarbage({ directory, io: failingIo, files });
    const error = failure(result);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    const details = error.details as Record<string, number>;
    expect(details.reclaimedObjects).toBe(1);
    expect(details.gcPhase).toBe("G6-reclaim");
    // The unlink happened; the barrier failure never claims more capacity.
    expect(await objectNames()).toHaveLength(0);
    value(await runtime.close());
  });

  it("fails observably when final scratch cleanup fails while leaving authority untouched", async () => {
    const runtime = value(await open());
    await injectOrphan("cleanup orphan");
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
    const result = await collectDurableGarbage({ directory, io: failingIo, files,
      instrumentation: { at: async phase => { if (phase === "G7-final-cleanup") failPrivate = true; } } });
    const error = failure(result);
    expect(error.code).toBe("DURABILITY_UNAVAILABLE");
    expect((error.details as Record<string, string>).gcPhase).toBe("G7-final-cleanup");
    expect(await objectNames()).toHaveLength(0);
    // Stale deterministic scratch is reclaimed by the next attempt.
    const outcome = value(await collectDurableGarbage({ directory, io, files }));
    expect(outcome.reclaimedObjects).toBe(0);
    value(await runtime.close());
  });

  it("excludes a concurrent writer through ordinary writer contention while GC holds authority", async () => {
    const runtime = value(await open());
    value(await runtime.addMemory({ content: "inline before", status: "active" }, "gc-race-0"));
    let releaseGc: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { releaseGc = resolve; });
    const started = new Promise<void>(resolve => {
      void (async () => {
        await collectDurableGarbage({ directory, io, files, instrumentation: {
          at: async phase => { if (phase === "G3-inventory") { resolve(); await gate; } }
        } });
      })();
    });
    await started;
    const concurrent = await runtime.addMemory({ content: "concurrent", status: "active" }, "gc-race-1");
    expect(failure(concurrent).code).toBe("WRITER_BUSY");
    releaseGc();
    await started;
    value(await runtime.close());
  });
});

describe("collectGarbage() durable-runtime facade member 19", () => {
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
    expect((error.details as Record<string, number>).reclaimedObjects).toBe(1);
    expect(runtime.state).toBe("ready");
    failObjectBarrier = false;
    // The runtime remains fully usable without recovery.
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
describe("cascade production scale and rotation serialization attacks", () => {
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
    const sorter = new GcDigestSorter(directory, "mark", io, files, limits);
    const count = 66_000;
    for (let index = 0; index < count; index++) {
      const added = await sorter.add(digest(index));
      if (!added.ok) throw new Error(JSON.stringify(added.error));
    }
    const finished = value(await sorter.finish());
    expect(finished!.entries).toBe(count);
    let seen = 0;
    let last: string | undefined;
    for await (const entry of readDigestFile(finished!.path, files)) {
      if (last !== undefined) expect(compareDigests(entry, last)).toBe(1);
      last = entry;
      seen++;
    }
    expect(seen).toBe(count);
    await sorter.sweep();
    expect(await fs.readdir(join(directory, ".private"))).toEqual([]);
  }, 120_000);

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
