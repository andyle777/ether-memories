import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../src/persistence/directoryIO.js";
import { nodeWalIO, type WalFileHandle, type WalIO } from "../src/persistence/walIO.js";
import { encodeEtherData, ETHER_DATA_PROFILE } from "../src/persistence/etherData.js";
import { referenceFor } from "../src/persistence/payloadObjects.js";
import {
  GC_CANDIDATES_NAME, compareDigests, deriveReclaimCandidates, extractObjectDigest, gcLimits,
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
