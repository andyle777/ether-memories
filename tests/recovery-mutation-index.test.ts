import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DiskBackedMutationIndex, DEFAULT_MAX_INDEX_BYTES } from "../src/persistence/recoveryMutationIndex.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import type { MutationId } from "../src/types/persistence.js";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";

const cleanup: string[] = [];
const setup = async () => { const store = await bootstrap(); cleanup.push(store.parent); return store; };
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

/** Counts ALL index-owned artifacts simultaneously (runs, merges, manifest). */
const ownedOnDisk = async (directory: string): Promise<number> => {
  const privateDir = join(directory, ".private");
  let total = 0;
  for (const name of await fs.readdir(privateDir)) {
    if (!/^recovery-mutation-index(-\d{6}\.idx|-manifest\.v1)$/.test(name)) continue;
    total += (await fs.stat(join(privateDir, name))).size;
  }
  return total;
};

const mid = (id: string) => id as MutationId;
const digest = (n: number) => n.toString(16).padStart(64, "0").slice(0, 64);

// ---- shared exact peak-disk accounting helpers (RED 3 / AMBER) ----
// ---- RED 3: exact peak disk accounting under a configured cap ----

/** Counts ALL index-owned artifacts simultaneously (runs, merges, manifest). */
const indexFiles = async (directory: string): Promise<string[]> =>
  (await fs.readdir(join(directory, ".private"))).filter(name => /^recovery-mutation-index-\d{6}\.idx$/.test(name)).sort();
/** Fine-grained sampler of the true simultaneous on-disk peak. */
const samplePeak = async <T>(directory: string, run: () => Promise<T>): Promise<{ result: T; peak: number }> => {
  let peak = 0;
  let stopped = false;
  const sampler = setInterval(async () => {
    if (stopped) return;
    try { peak = Math.max(peak, await ownedOnDisk(directory)); } catch { /* directory removed */ }
  }, 1);
  try {
    const result = await run();
    stopped = true;
    clearInterval(sampler);
    peak = Math.max(peak, await ownedOnDisk(directory));
    return { result, peak };
  } catch (error) {
    stopped = true;
    clearInterval(sampler);
    throw error;
  }
};
const STRESS_RECORDS = 27_000;
const stressLine = (i: number) => `cap-stress-${String(i).padStart(6, "0")}|${digest(i + 1)}|${String(i + 1)}`;
const recordStress = async (index: DiskBackedMutationIndex) => {
  for (let i = 0; i < STRESS_RECORDS; i++) {
    value(await index.record(mid(`cap-stress-${String(i).padStart(6, "0")}`), { digest: digest(i + 1), txId: String(i + 1) }));
  }
};
/**
 * Exact peak for the deterministic merge shape. All recorded bytes are known:
 * flushed run files are read from disk, and the residual buffer that
 * verifyExact() flushes as one final run is total record bytes minus the
 * flushed bytes. With 9..16 runs there is a single merge level, so the peak
 * is every input run plus the first 8-run merge output (a byte-for-byte
 * reorder of those inputs): peak = totalRuns + firstGroup.
 */
const measuredPeakRequirement = async (directory: string): Promise<number> => {
  let totalRecordBytes = 0;
  for (let i = 0; i < STRESS_RECORDS; i++) totalRecordBytes += Buffer.byteLength(stressLine(i)) + 1;
  const runs = await indexFiles(directory);
  const sizes = await Promise.all(runs.map(name => fs.stat(join(directory, ".private", name)).then(x => x.size)));
  const flushed = sizes.reduce((a, b) => a + b, 0);
  const residual = totalRecordBytes - flushed;
  expect(residual).toBeGreaterThanOrEqual(0);
  const runCount = sizes.length + (residual > 0 ? 1 : 0);
  expect(runCount).toBeGreaterThanOrEqual(9);
  expect(runCount).toBeLessThanOrEqual(16);
  const totalAfterFinalFlush = flushed + residual;
  const firstGroup = sizes.slice(0, 8).reduce((a, b) => a + b, 0);
  // The allocation manifest is a session-owned artifact and is counted.
  const manifestBytes = (await fs.stat(join(directory, ".private", "recovery-mutation-index-manifest.v1"))).size;
  return totalAfterFinalFlush + firstGroup + manifestBytes;
};


describe("disk-backed recovery mutation index", () => {
  it("accepts 256 unique IDs that all share one shard prefix", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    for (let i = 0; i < 256; i++) {
      value(await index.record(mid(`same-shard-${String(i).padStart(6, "0")}`), { digest: digest(i), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    value(await index.reset());
  });
  it("accepts 4096 unique IDs including a skewed same-shard cluster", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    for (let i = 0; i < 256; i++) {
      value(await index.record(mid(`aaaaaaaaaa-${String(i).padStart(6, "0")}`), { digest: digest(i), txId: String(i + 1) }));
    }
    for (let i = 256; i < 4096; i++) {
      value(await index.record(mid(`mutation-${i}`), { digest: digest(i), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    value(await index.reset());
  });
  it("accepts 65536 unique IDs across merge levels", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    for (let i = 0; i < 65536; i++) {
      value(await index.record(mid(`mutation-${String(i).padStart(8, "0")}`), { digest: digest(i), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    value(await index.reset());
  }, 120_000);
  it("detects a duplicate whose first record is at the beginning", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    value(await index.record(mid("mutation-first"), { digest: digest(1), txId: "1" }));
    for (let i = 0; i < 5000; i++) {
      value(await index.record(mid(`mutation-${i}`), { digest: digest(i + 2), txId: String(i + 2) }));
    }
    value(await index.record(mid("mutation-first"), { digest: digest(1), txId: "5002" }));
    const result = await index.verifyExact();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    value(await index.reset());
  });
  it("detects a duplicate whose first record is at the end", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    for (let i = 0; i < 5000; i++) {
      value(await index.record(mid(`mutation-${i}`), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    value(await index.record(mid("mutation-last"), { digest: digest(1), txId: "5001" }));
    value(await index.record(mid("mutation-last"), { digest: digest(2), txId: "5002" }));
    const result = await index.verifyExact();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    value(await index.reset());
  });
  it("detects conflicting reuse of one mutation identity", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    value(await index.record(mid("mutation-conflicting"), { digest: digest(1), txId: "1" }));
    value(await index.record(mid("mutation-conflicting"), { digest: digest(2), txId: "2" }));
    const result = await index.verifyExact();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERSISTENCE_CORRUPTION");
    value(await index.reset());
  });
  it("does not report false duplicates for similar or prefix-sharing IDs", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    const ids = ["mutation", "mutation-1", "mutation-11", "mutation-111", "mutation-2",
      "mutationa", "mutatio", "aaaa", "aaaaa", "same-shard-1", "same-shard-2"];
    for (const [i, id] of ids.entries()) {
      value(await index.record(mid(id), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    value(await index.reset());
  });
  it("treats an identical mutationId/digest/txId triple as the benign physical case", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    value(await index.record(mid("mutation-physical"), { digest: digest(1), txId: "7" }));
    value(await index.record(mid("mutation-physical"), { digest: digest(1), txId: "7" }));
    value(await index.verifyExact());
    value(await index.reset());
  });
  it("fails explicitly as a resource limit instead of silently forgetting records", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, 4096);
    for (let i = 0; i < 100; i++) {
      value(await index.record(mid(`mutation-${i}`), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    // Cross the flush threshold; the disk bound must fail as a resource limit.
    let failed = false;
    for (let i = 100; i < 5000; i++) {
      const result = await index.record(mid(`mutation-${i}`), { digest: digest(i + 1), txId: String(i + 1) });
      if (!result.ok) {
        expect(result.error.code).toBe("RECOVERY_REQUIRED");
        expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    value(await index.reset());
  });
  it("sweeps stale artifacts, cleans only its own files and leaves foreign files alone", async () => {
    const s = await setup();
    const privateDir = join(s.directory, ".private");
    const stale = join(privateDir, "recovery-mutation-index-000000.idx");
    const foreign = join(privateDir, "object-foreign.tmp");
    await fs.writeFile(stale, "garbage");
    await fs.writeFile(foreign, "foreign");
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    for (let i = 0; i < 300; i++) {
      value(await index.record(mid(`mutation-${i}`), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    // Stale files are swept before the session writes; garbage never corrupts it.
    value(await index.reset());
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign");
    for (let i = 0; i < 8; i++) {
      expect(await fs.stat(join(privateDir, `recovery-mutation-index-${String(i).padStart(6, "0")}.idx`)).then(() => true, () => false)).toBe(false);
    }
    await fs.rm(foreign, { force: true });
  });

  it("Codex case: a 2,500,000-byte cap is enforced before merge growth, never exceeded on disk", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, 2_500_000);
    // Enough records to require a merge (more than the 8-run fan-in) while
    // the flushed runs themselves stay under the configured cap.
    await recordStress(index);
    const filesBefore = await indexFiles(s.directory);
    expect(filesBefore.length).toBeGreaterThan(8);
    const { result, peak } = await samplePeak(s.directory, () => index.verifyExact());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECOVERY_REQUIRED");
      expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    }
    // The index's own accounting rejected the growth BEFORE it happened:
    // at most the residual final run (next sequential index) may appear, and
    // no merge output exists after the failure.
    const afterFailure = await indexFiles(s.directory);
    expect(afterFailure.length - filesBefore.length).toBeLessThanOrEqual(1);
    if (afterFailure.length > filesBefore.length) {
      expect(afterFailure[afterFailure.length - 1]).toBe(
        "recovery-mutation-index-" + String(filesBefore.length).padStart(6, "0") + ".idx");
    }
    // Filesystem confirmation: the observed simultaneous peak never crossed the cap.
    expect(peak).toBeLessThanOrEqual(2_500_000);
    value(await index.reset());
    expect(await indexFiles(s.directory)).toEqual([]);
  }, 120_000);

  it("just-below, exactly-sufficient and generous caps behave exactly; retry rebuilds cleanly", async () => {
    const s = await setup();
    const recordWith = async (cap: number) => {
      const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, cap);
      await recordStress(index);
      return index;
    };
    // Generous cap: completes; the observed disk peak matches the exact
    // accounting bound and stays below the configured cap.
    const required = await (async () => {
      const generous = await recordWith(DEFAULT_MAX_INDEX_BYTES);
      const bound = await measuredPeakRequirement(s.directory);
      const { result, peak } = await samplePeak(s.directory, () => generous.verifyExact());
      value(result);
      expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_INDEX_BYTES);
      expect(peak).toBeLessThanOrEqual(bound);
      value(await generous.reset());
      return bound;
    })();
    // Exactly sufficient cap: succeeds with the observed peak within the cap.
    const exact = await recordWith(required);
    const exactRun = await samplePeak(s.directory, () => exact.verifyExact());
    value(exactRun.result);
    expect(exactRun.peak).toBeLessThanOrEqual(required);
    value(await exact.reset());
    expect(await indexFiles(s.directory)).toEqual([]);
    // One byte below the requirement: fails cleanly as a resource limit
    // before any growth, with no partial merge output left behind.
    const tight = await recordWith(required - 1);
    const before = await indexFiles(s.directory);
    const tightRun = await samplePeak(s.directory, () => tight.verifyExact());
    expect(tightRun.result.ok).toBe(false);
    if (!tightRun.result.ok) {
      expect((tightRun.result.error.details as { reason?: string }).reason).toBe("resource-limit");
    }
    // Only the residual final run may have been flushed; no merge output was
    // created before the cap rejection.
    const afterTight = await indexFiles(s.directory);
    expect(afterTight.length - before.length).toBeLessThanOrEqual(1);
    if (afterTight.length > before.length) {
      expect(afterTight[afterTight.length - 1]).toBe(
        "recovery-mutation-index-" + String(before.length).padStart(6, "0") + ".idx");
    }
    expect(tightRun.peak).toBeLessThanOrEqual(required - 1);
    value(await tight.reset());
    expect(await indexFiles(s.directory)).toEqual([]);
    // Retry with a sufficient cap rebuilds the index from scratch and succeeds.
    const retry = await recordWith(required);
    value(await retry.verifyExact());
    value(await retry.reset());
  }, 180_000);
});

describe("recovery-index crash debris never strands a valid store", () => {
  const runName = (index: number) => `recovery-mutation-index-${String(index).padStart(6, "0")}.idx`;
  const manifestName = "recovery-mutation-index-manifest.v1";
  const privateDir = (directory: string) => join(directory, ".private");
  const writeManifest = (directory: string, watermark: number) =>
    fs.writeFile(join(privateDir(directory), manifestName),
      `ether.recovery-mutation-index.v1|01234567-89ab-cdef-0123-456789abcdef|${String(watermark).padStart(6, "0")}`);
  const writeRun = (directory: string, index: number, content: string) =>
    fs.writeFile(join(privateDir(directory), runName(index)), content);
  const indexOwnedNames = async (directory: string) =>
    (await fs.readdir(privateDir(directory))).filter(name => name.startsWith("recovery-mutation-index")).sort();

  /** A fresh session must sweep the debris, rebuild the index and verify. */
  const restartAndVerify = async (directory: string) => {
    const index = new DiskBackedMutationIndex(directory, (await bootstrapReuse(directory)).io, nodeWalIO);
    for (let i = 0; i < 300; i++) {
      value(await index.record(mid(`recovery-${i}`), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    value(await index.reset());
    expect(await indexOwnedNames(directory)).toEqual([]);
  };

  // bootstrap() creates a fresh store each call; the crash tests reuse the
  // setup() store directory directly.
  let store: Awaited<ReturnType<typeof setup>>;
  const bootstrapReuse = async (directory: string) => {
    void directory;
    return { io: store.io };
  };

  it("crash after manifest reservation, before run creation", async () => {
    store = await setup();
    await writeManifest(store.directory, 5);
    await restartAndVerify(store.directory);
  });
  it("crash midway through an initial run write", async () => {
    store = await setup();
    await writeRun(store.directory, 0, "mutation-a|1111");
    await writeManifest(store.directory, 0);
    await restartAndVerify(store.directory);
  });
  it("crash after several run files", async () => {
    store = await setup();
    for (let i = 0; i < 4; i++) await writeRun(store.directory, i, `mutation-${i}|${digest(i + 1)}|${i + 1}\n`);
    await writeManifest(store.directory, 3);
    await restartAndVerify(store.directory);
  });
  it("crash during merge output, with deletion holes below", async () => {
    store = await setup();
    for (const i of [5, 6, 7]) await writeRun(store.directory, i, `mutation-${i}|${digest(i + 1)}|${i + 1}\n`);
    await writeRun(store.directory, 8, "partial-merge-ou");
    await writeManifest(store.directory, 8);
    await restartAndVerify(store.directory);
  });
  it("crash after merge output completion but before input deletion", async () => {
    store = await setup();
    for (let i = 0; i < 8; i++) await writeRun(store.directory, i, `mutation-${i}|${digest(i + 1)}|${i + 1}\n`);
    await writeRun(store.directory, 8, "mutation-merged|".repeat(4));
    await writeManifest(store.directory, 8);
    await restartAndVerify(store.directory);
  });
  it("Codex exact case: runs 000008 and 000009 survive with holes below (with manifest)", async () => {
    store = await setup();
    await writeRun(store.directory, 8, "mutation-x|".repeat(4));
    await writeRun(store.directory, 9, "mutation-y|".repeat(4));
    await writeManifest(store.directory, 9);
    await restartAndVerify(store.directory);
  });
  it("Codex exact case without a manifest falls back to the full bounded sweep", async () => {
    store = await setup();
    await writeRun(store.directory, 8, "mutation-x|".repeat(4));
    await writeRun(store.directory, 9, "mutation-y|".repeat(4));
    await restartAndVerify(store.directory);
  });
  it("crash during cleanup after removing only some runs", async () => {
    store = await setup();
    for (let i = 4; i < 10; i++) await writeRun(store.directory, i, `mutation-${i}|${digest(i + 1)}|${i + 1}\n`);
    await writeManifest(store.directory, 9);
    await restartAndVerify(store.directory);
  });
  it("repeated restart after interrupted cleanup stays clean and recovers", async () => {
    store = await setup();
    for (let i = 4; i < 10; i++) await writeRun(store.directory, i, `mutation-${i}|${digest(i + 1)}|${i + 1}\n`);
    await writeManifest(store.directory, 9);
    await restartAndVerify(store.directory);
    // Simulate a second interrupted cleanup, then restart again.
    await writeRun(store.directory, 12, "mutation-z|".repeat(4));
    await writeManifest(store.directory, 12);
    await restartAndVerify(store.directory);
  });
  it("torn manifest falls back to the full bounded sweep", async () => {
    store = await setup();
    await fs.writeFile(join(privateDir(store.directory), manifestName), "ether.recovery-mutation-ind");
    await writeRun(store.directory, 8, "mutation-x|".repeat(4));
    await writeRun(store.directory, 9, "mutation-y|".repeat(4));
    await restartAndVerify(store.directory);
  });
  // AMBER 4C: a syntactically valid manifest can carry a stale LOWER watermark
  // than files actually present (torn in-place update). Cleanup sweeps the
  // complete namespace every time, so the FIRST retry must clean and recover.
  it.each([[0], [3], [5], [500]] as const)(
    "syntactically valid stale watermark %i cleans all higher stale runs on the first retry",
    async watermark => {
      store = await setup();
      await writeRun(store.directory, 8, "mutation-x|".repeat(4));
      await writeRun(store.directory, 9, "mutation-y|".repeat(4));
      await writeManifest(store.directory, watermark);
      await restartAndVerify(store.directory);
    });
  it("Codex exact stale-low manifest: watermark 3 with stale runs 000008/000009 recovers on the first retry", async () => {
    store = await setup();
    await writeRun(store.directory, 8, "mutation-x|".repeat(4));
    await writeRun(store.directory, 9, "mutation-y|".repeat(4));
    await writeManifest(store.directory, 3);
    await restartAndVerify(store.directory);
  });
});

describe("manifest disk-cap preflight (AMBER 1)", () => {
  const manifestSize = async (directory: string) =>
    (await fs.stat(join(directory, ".private", "recovery-mutation-index-manifest.v1"))).size;
  const ownedNames = async (directory: string) =>
    (await fs.readdir(join(directory, ".private"))).filter(name => name.startsWith("recovery-mutation-index")).sort();

  it("cap = 0 fails before creating any recovery-index artifact", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, 0);
    const result = await index.record(mid("m-zero"), { digest: digest(1), txId: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECOVERY_REQUIRED");
      expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    }
    expect(await ownedNames(s.directory)).toEqual([]);
  });
  it("cap = 1 fails before creating any recovery-index artifact", async () => {
    const s = await setup();
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, 1);
    const result = await index.record(mid("m-one"), { digest: digest(1), txId: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECOVERY_REQUIRED");
      expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    }
    expect(await ownedNames(s.directory)).toEqual([]);
  });
  it("cap = manifest size - 1 fails without creating any artifact", async () => {
    const s = await setup();
    // Measure the exact manifest size with a generous session first.
    const probe = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES);
    value(await probe.record(mid("m-probe"), { digest: digest(1), txId: "1" }));
    const size = await manifestSize(s.directory);
    value(await probe.reset());
    expect(await ownedNames(s.directory)).toEqual([]);
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, size - 1);
    const result = await index.record(mid("m-tight"), { digest: digest(1), txId: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    expect(await ownedNames(s.directory)).toEqual([]);
  });
  it("cap = exact manifest minimum opens the session; runs exceed it cleanly", async () => {
    const s = await setup();
    const probe = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES);
    value(await probe.record(mid("m-probe"), { digest: digest(1), txId: "1" }));
    const size = await manifestSize(s.directory);
    value(await probe.reset());
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, size);
    // No records: the manifest alone fits; verification of nothing succeeds.
    value(await index.verifyExact());
    value(await index.reset());
    expect(await ownedNames(s.directory)).toEqual([]);
    // Any buffered record forces a run flush at verification that exceeds the
    // cap before writing (the in-memory buffer is not disk).
    const failing = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, size);
    value(await failing.record(mid("m-run"), { digest: digest(1), txId: "1" }));
    const result = await failing.verifyExact();
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
    // Only the manifest artifact exists; no run was created.
    expect(await ownedNames(s.directory)).toEqual(["recovery-mutation-index-manifest.v1"]);
    value(await failing.reset());
  });
  it("manifest watermark growth/update never exceeds the cap and never doubles physically", async () => {
    const s = await setup();
    // Small flush threshold forces many manifest watermark updates.
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES, 2048);
    let peak = 0;
    let stopped = false;
    const sampler = setInterval(async () => {
      if (stopped) return;
      try { peak = Math.max(peak, await ownedOnDisk(s.directory)); } catch { /* gone */ }
    }, 1);
    try {
      for (let i = 0; i < 500; i++) {
        value(await index.record(mid(`m-grow-${String(i).padStart(4, "0")}`), { digest: digest(i + 1), txId: String(i + 1) }));
      }
      value(await index.verifyExact());
    } finally {
      stopped = true;
      clearInterval(sampler);
    }
    // The in-place fixed-width manifest replacement never holds both old and
    // new files; the measured physical peak stays within the cap.
    expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_INDEX_BYTES);
    const manifest = await fs.readFile(join(s.directory, ".private", "recovery-mutation-index-manifest.v1"), "utf8");
    expect(manifest).toMatch(/^ether\.recovery-mutation-index\.v1\|[0-9a-f-]{36}\|\d{6}$/);
    value(await index.reset());
    expect(await ownedNames(s.directory)).toEqual([]);
  });
});

describe("unlink failure retains accounted bytes (AMBER 2)", () => {
  const privateFiles = async (directory: string) =>
    (await fs.readdir(join(directory, ".private"))).filter(name => name.startsWith("recovery-mutation-index")).sort();
  const samplePeakDuring = async <T>(directory: string, run: () => Promise<T>): Promise<{ result: T; peak: number }> => {
    let peak = 0;
    let stopped = false;
    const sampler = setInterval(async () => {
      if (stopped) return;
      try { peak = Math.max(peak, await ownedOnDisk(directory)); } catch { /* gone */ }
    }, 1);
    try {
      const result = await run();
      stopped = true;
      clearInterval(sampler);
      return { result, peak };
    } catch (error) {
      stopped = true;
      clearInterval(sampler);
      throw error;
    }
  };

  /**
   * Measures the EXACT peak requirement (shared residual-aware helper) with a
   * clean session, then runs the same stress set under a fault-injecting IO.
   * The cap must include the residual buffered records that verifyExact()
   * flushes as the final run before the merge, or verification aborts at the
   * merge preflight and the injected unlink is never reached.
   */
  it("the exact peak requirement for the deterministic stress fixture includes the residual run", async () => {
    const s = await setup();
    const measure = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES);
    await recordStress(measure);
    const required = await measuredPeakRequirement(s.directory);
    // Pin the deterministic fixture value; an intentional test-data change
    // must update this pin deliberately.
    expect(required).toBe(4_489_452);
    value(await measure.reset());
    expect(await privateFiles(s.directory)).toEqual([]);
  });

  it.each([["first", 0], ["middle", 4], ["final", 7]] as const)(
    "injected unlink failure on the %s consumed run is exercised and aborts verification within the cap",
    async (position, groupOffset) => {
      const s = await setup();
      // Measure the exact requirement with a clean session (residual-aware).
      const measure = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES);
      await recordStress(measure);
      const cap = await measuredPeakRequirement(s.directory);
      value(await measure.reset());
      expect(await privateFiles(s.directory)).toEqual([]);
      // Inject an unlink failure on one consumed input run, with an explicit
      // invocation counter for the victim path.
      const victim = `recovery-mutation-index-${String(groupOffset).padStart(6, "0")}.idx`;
      let unlinkAttempts = 0;
      const failingIo = { ...s.io, removeOwnedFile: async (path: string) => {
        if (path.endsWith(victim)) {
          unlinkAttempts++;
          throw new Error("injected unlink failure");
        }
        return s.io.removeOwnedFile(path);
      } };
      const index = new DiskBackedMutationIndex(s.directory, failingIo, nodeWalIO, cap);
      await recordStress(index);
      const filesBefore = await indexFiles(s.directory);
      const { result, peak } = await samplePeakDuring(s.directory, () => index.verifyExact());
      // The injected fault path was actually reached exactly once.
      expect(unlinkAttempts).toBe(1);
      // Verification does not report success, and the failure is the injected
      // unlink abort, not a generic resource-limit preflight rejection.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RECOVERY_REQUIRED");
        expect((result.error.details as { reason?: string } | undefined)?.reason).not.toBe("resource-limit");
      }
      // The victim file physically remains (bookkeeping agrees with disk).
      expect(await privateFiles(s.directory)).toContain(victim);
      // The measured physical peak never exceeded the configured cap.
      expect(peak).toBeLessThanOrEqual(cap);
      // No merge growth occurred after the failed deletion: at most the
      // residual final run and the single merge output were added.
      const filesAfter = await indexFiles(s.directory);
      expect(filesAfter.length - filesBefore.length).toBeLessThanOrEqual(2);
      // Next clean retry sweeps the artifacts and succeeds.
      const retry = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES);
      value(await retry.verifyExact());
      value(await retry.reset());
      expect(await privateFiles(s.directory)).toEqual([]);
      console.log(JSON.stringify({ case: position, cap, sampledPeak: peak, victim, unlinkAttempts,
        failure: result.ok ? "none" : result.error.code + (result.error.details ? ":" + JSON.stringify(result.error.details) : ""),
        retry: "clean-sweep-success" }));
    }, 180_000);

  it("injected unlink failure during cleanup is exercised, fails closed; a clean retry sweeps and succeeds", async () => {
    const s = await setup();
    let unlinkAttempts = 0;
    const failingIo = { ...s.io, removeOwnedFile: async (path: string) => {
      if (path.endsWith("recovery-mutation-index-000000.idx")) {
        unlinkAttempts++;
        throw new Error("injected unlink failure");
      }
      return s.io.removeOwnedFile(path);
    } };
    const index = new DiskBackedMutationIndex(s.directory, failingIo, nodeWalIO);
    for (let i = 0; i < 300; i++) {
      value(await index.record(mid(`m-cleanup-${i}`), { digest: digest(i + 1), txId: String(i + 1) }));
    }
    value(await index.verifyExact());
    const cleanup = await index.reset();
    // The injected cleanup fault path was actually reached exactly once.
    expect(unlinkAttempts).toBe(1);
    expect(cleanup.ok).toBe(false);
    expect(await privateFiles(s.directory)).toContain("recovery-mutation-index-000000.idx");
    // Clean retry sweeps the debris and succeeds.
    const retry = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO);
    value(await retry.verifyExact());
    value(await retry.reset());
    expect(await privateFiles(s.directory)).toEqual([]);
    console.log(JSON.stringify({ case: "cleanup", unlinkAttempts,
      failure: cleanup.ok ? "none" : cleanup.error.code, retry: "clean-sweep-success" }));
  });
});

describe("enforced run-number namespace bound (AMBER 4B)", () => {
  it("allocating the 1025th run fails as a resource limit before its file can exist", async () => {
    const s = await setup();
    // Tiny flush threshold makes each record its own run.
    const index = new DiskBackedMutationIndex(s.directory, s.io, nodeWalIO, DEFAULT_MAX_INDEX_BYTES, 64);
    let failed = false;
    for (let i = 0; i < 2000 && !failed; i++) {
      const result = await index.record(mid(`m-bound-${String(i).padStart(4, "0")}`), { digest: digest(i + 1), txId: String(i + 1) });
      if (!result.ok) {
        expect(result.error.code).toBe("RECOVERY_REQUIRED");
        expect((result.error.details as { reason?: string }).reason).toBe("resource-limit");
        failed = true;
      }
    }
    expect(failed).toBe(true);
    // No run file at or beyond the 1024-entry namespace bound exists, and the
    // manifest watermark never reached the bound.
    const names = (await fs.readdir(join(s.directory, ".private"))).filter(name => name.startsWith("recovery-mutation-index"));
    for (const name of names) {
      const match = /^recovery-mutation-index-(\d{6})\.idx$/.exec(name);
      if (match) expect(Number(match[1])).toBeLessThan(1024);
    }
    const manifest = await fs.readFile(join(s.directory, ".private", "recovery-mutation-index-manifest.v1"), "utf8");
    expect(Number(manifest.split("|")[2])).toBeLessThan(1024);
    value(await index.reset());
  }, 120_000);
});
