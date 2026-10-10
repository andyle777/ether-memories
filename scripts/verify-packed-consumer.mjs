import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
assert.ok(process.argv.length <= 3, "Usage: npm run verify:packed -- [tarball]");
const candidates = (await fs.readdir(root)).filter(name => name.startsWith(`${pkg.name}-`) && name.endsWith(".tgz"));
if (!process.argv[2]) assert.deepEqual(candidates, [`${pkg.name}-${pkg.version}.tgz`], "Run npm pack first; remove stale tarballs or supply an explicit path.");
const tarball = process.argv[2] ? resolve(process.argv[2]) : join(root, candidates[0]);
assert.ok(existsSync(tarball), `Missing tarball: ${tarball}`);
assert.ok(process.env.npm_execpath, "Run this gate through npm run verify:packed.");
const work = await fs.mkdtemp(join(tmpdir(), "ether-packed-consumer-"));
const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const files = async (directory, prefix = "") => {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${name}/`));
    else { assert.ok(entry.isFile(), `Unexpected package entry: ${name}`); result.push(name); }
  }
  return result.sort();
};

try {
  await fs.writeFile(join(work, "package.json"), JSON.stringify({ name: "ether-packed-consumer", private: true, type: "module" }));
  run([process.env.npm_execpath, "install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund", tarball]);
  const installed = join(work, "node_modules", pkg.name);
  const dist = await files(join(root, "dist"), "dist/");
  const expected = [...dist, "package.json", "README.md", "LICENSE", "CONTRIBUTORS.md"].sort();
  assert.deepEqual(await files(installed), expected, "Packed contents must contain only emitted dist and the published metadata/docs.");
  for (const name of expected) {
    assert.deepEqual(await fs.readFile(join(installed, name)), await fs.readFile(join(root, name)), `Packed file differs: ${name}`);
  }
  const internalModules = dist.filter(name => name.endsWith(".js")).map(name => `${pkg.name}/${name}`);
  await fs.writeFile(join(work, "consumer.mjs"), `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import * as api from "ether-memories";
    import { EtherMemoriesCore, openDurableEtherMemories, createMutationId } from "ether-memories";
    const snapshotPath = join(process.cwd(), "snapshot.json");
    const core = new EtherMemoriesCore({ userId: "packed-consumer", storagePath: snapshotPath });
    const note = core.addMemory({ content: "package consumer" });
    assert.ok(note.ok);
    const explanation = core.explainMemory(note.value.id, { asOf: 1893456000000 });
    assert.ok(explanation.ok);
    assert.equal(explanation.value.note.id, note.value.id);
    assert.equal(explanation.value.asOf, 1893456000000);
    assert.equal(explanation.value.note.content, undefined);
    const health = core.inspectMemoryHealth({ asOf: 1893456000000 });
    assert.ok(health.ok);
    assert.equal(health.value.coverage.inspectedCount, 1);
    const dream = core.previewDreamCycle({ kind: "ids", ids: [note.value.id] }, { asOf: 1893456000000 });
    assert.ok(dream.ok, JSON.stringify(dream));
    assert.equal(dream.value.algorithm, "ether.dream.v1");
    assert.deepEqual(dream.value.selectedSourceIds, [note.value.id]);
    assert.equal(JSON.stringify(dream.value).includes("package consumer"), false);
    assert.equal(core.runDreamCycle, undefined);
    assert.equal(api.previewDreamCycle, undefined, "Pure planning implementation must stay internal.");
    assert.equal(api.canonicalJson, undefined, "Hash encoding internals must stay internal.");
    assert.ok((await core.save()).ok);
    const loaded = new EtherMemoriesCore({ userId: "packed-consumer", storagePath: snapshotPath });
    assert.ok((await loaded.load()).ok);
    // Legacy JSON snapshots omit undefined optional fields by design.
    assert.deepEqual(JSON.parse(JSON.stringify(loaded.exportData())), JSON.parse(JSON.stringify(core.exportData())));
    const options = { userId: "packed-consumer", directory: join(process.cwd(), "durable-store") };
    const opened = await openDurableEtherMemories(options);
    let durable;
    if (process.platform === "win32") {
      assert.equal(opened.ok, false);
      assert.equal(opened.error.code, "DURABILITY_UNAVAILABLE");
      durable = "strict fails closed: DURABILITY_UNAVAILABLE";
    } else {
      assert.ok(opened.ok, JSON.stringify(opened));
      try { assert.ok((await opened.value.addMemory({ content: "durable consumer" }, createMutationId())).ok); }
      finally { assert.ok((await opened.value.close()).ok); }
      const reopened = await openDurableEtherMemories({ ...options, openMode: "existing" });
      assert.ok(reopened.ok, JSON.stringify(reopened));
      try {
        const exported = reopened.value.exportData();
        assert.ok(exported.ok);
        assert.ok(exported.value.memoryNotes.some(note => note.content === "durable consumer"));
        const logical = new EtherMemoriesCore({ userId: "packed-consumer" });
        assert.ok(logical.importData(exported.value).ok);
        assert.deepEqual(reopened.value.inspectMemoryHealth({ asOf: 1893456000000 }), logical.inspectMemoryHealth({ asOf: 1893456000000 }));
        assert.deepEqual(reopened.value.previewDreamCycle({ kind: "all_active" }, { asOf: 1893456000000 }), logical.previewDreamCycle({ kind: "all_active" }, { asOf: 1893456000000 }));
        for (const note of exported.value.memoryNotes) {
          assert.deepEqual(reopened.value.explainMemory(note.id, { asOf: 1893456000000 }), logical.explainMemory(note.id, { asOf: 1893456000000 }));
        }
      } finally { assert.ok((await reopened.value.close()).ok); }
      durable = "native strict write/reopen passed";
    }
    for (const name of ${JSON.stringify([...internalModules, `${pkg.name}/src/index.ts`])}) {
      assert.throws(() => import.meta.resolve(name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, name);
    }
    assert.ok(import.meta.resolve("ether-memories/package.json"));
    console.log(JSON.stringify({ exports: Object.keys(api).sort(), durable }));
  `);
  const runtime = JSON.parse(run(["consumer.mjs"]).trim());
  const reference = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  assert.deepEqual(runtime.exports, Object.keys(reference).sort(), "Installed named exports differ from the compiled package root.");
  await fs.writeFile(join(work, "consumer.mts"), `
    import { EtherMemoriesCore, openDurableEtherMemories, createMutationId, type DurableEtherMemories,
      type MemoryExplanation, type MemoryHealthReport, type MemoryInspectionOptions,
      type DreamSelector, type DreamBudgets, type DreamCyclePreviewOptions, type DreamPlan,
      type InspectionCoverage, type MemoryRelationshipEvidence, type MemoryHealthFinding,
      type MemoryHealthSuggestion, type Result } from "ether-memories";
    const core = new EtherMemoriesCore({ userId: "types" });
    core.addMemory({ content: "typed consumer" });
    const inspect: MemoryInspectionOptions = { asOf: 1893456000000 };
    const explanation: Result<MemoryExplanation> = core.explainMemory("note", inspect);
    const health: Result<MemoryHealthReport> = core.inspectMemoryHealth(inspect);
    const selector: DreamSelector = { kind: "all_active" };
    const dreamOptions: DreamCyclePreviewOptions = { asOf: 1893456000000, budgets: { maxSources: 1 } };
    const dream: Result<DreamPlan> = core.previewDreamCycle(selector, dreamOptions);
    if (dream.ok) { const budgets: DreamBudgets = dream.value.budgets; const ids: string[] = dream.value.selectedSourceIds; }
    // @ts-expect-error T4 execution is not available.
    core.runDreamCycle();
    if (explanation.ok) { const edges: MemoryRelationshipEvidence[] = explanation.value.relationships.entries; }
    if (health.ok) {
      const coverage: InspectionCoverage = health.value.coverage;
      const findings: MemoryHealthFinding[] = health.value.invariantFailures;
      const suggestions: MemoryHealthSuggestion[] = health.value.suggestions;
    }
    const opened = await openDurableEtherMemories({ userId: "types", directory: "./store" });
    if (opened.ok) {
      const runtime: DurableEtherMemories = opened.value;
      await runtime.addMemory({ content: "typed durable consumer" }, createMutationId());
      const e: Result<MemoryExplanation> = runtime.explainMemory("note", inspect);
      const h: Result<MemoryHealthReport> = runtime.inspectMemoryHealth(inspect);
      const p: Result<DreamPlan> = runtime.previewDreamCycle(selector, dreamOptions);
      await runtime.rotate(); await runtime.collectGarbage(); await runtime.runMaintenance(); await runtime.close();
    }
    // @ts-expect-error Internal backend is not a public root type.
    type IO = import("ether-memories").DirectoryIO;
    // @ts-expect-error Internal dependency injection is not public.
    type Dependencies = import("ether-memories").DurableDependencies;
    // @ts-expect-error Internal receipt type is not public.
    type Receipt = import("ether-memories").CommitReceipt;
    // @ts-expect-error Internal WAL implementation is not public.
    type WalStore = import("ether-memories").FsWalStore;
    // @ts-expect-error Internal activation receipt is not public.
    type Activation = import("ether-memories").HeadActivationReceipt;
    // @ts-expect-error Test instrumentation is not public.
    type Instrumentation = import("ether-memories").GcInstrumentation;
    // @ts-expect-error Internal factory is not public.
    import { openDurableEtherMemoriesInternal } from "ether-memories";
    // @ts-expect-error Snapshot builders are internal, not public root symbols.
    import { explanationSnapshot, healthSnapshot } from "ether-memories";
    // @ts-expect-error Trusted-state registration is internal.
    import { registerInspectionNotes, registerInspectionGraph } from "ether-memories";
    // @ts-expect-error Pure planning and hashing are not public root functions.
    import { previewDreamCycle, normalizeDreamRequest, canonicalJson } from "ether-memories";
    // @ts-expect-error Captured dependency snapshots are not public types.
    import type { DreamNoteDependency, DreamRequest } from "ether-memories";
    // @ts-expect-error Pure analysis implementation is internal.
    import { analyzeHealth, analyzeExplanation } from "ether-memories";
    // @ts-expect-error Package exports block internal declarations too.
    import type { DirectoryIO } from "ether-memories/dist/persistence/directoryIO.js";
  `);
  run([join(root, "node_modules", "typescript", "lib", "tsc.js"), "--noEmit", "--strict",
    "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022",
    "--typeRoots", join(root, "node_modules", "@types"), "consumer.mts"]);
  console.log(JSON.stringify({ package: `${pkg.name}@${pkg.version}`, files: expected.length,
    namedExports: runtime.exports.length, blockedModules: internalModules.length + 1,
    snapshot: "passed", durable: runtime.durable, declarations: "passed" }));
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
