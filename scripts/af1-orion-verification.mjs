import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * Durable ORION verification receipt.
 *
 * Runs every mapped suite from docs/af1-tranche5-recovery.md, verifies the
 * five frozen fixtures byte-for-byte, executes the checked-in Tranche 5
 * production recovery probe at its default 1,050 transactions, and prints a
 * fourteen-row PASS/FAIL receipt. The mapping lists the exact test names so
 * any single property can also be traced with:
 *   npx vitest run <suite> -t "<test name>"
 */

const FIXTURE_HASHES = {
  "tests/fixtures/persistence-wire-v1.json": "ecc0d9b2276c9569bec4a3a139fb0ea3da12186459330c292dfb9c04255524af",
  "tests/fixtures/portable-record-v1.json": "76cd743be21116d864a7e2cc7c040a7dc4bad96a1090851e7f9414f5508966d5",
  "tests/fixtures/retrieval-golden-v1.json": "d0d3dd009f496cac22a38f1e5945ed3600026cbd2ba4b6d56bccb4c8fa77a6d1",
  "tests/fixtures/store-v0.3.json": "f8d9947a800fb65c1d20385a2ec9090b0e384625cef65325bb4a00f7b358607c",
  "tests/fixtures/wal-wire-v1.json": "04c980368c39c9506bd40d314ee1ef1f590ab169a09cff022b0f4a115133050c"
};

const PROPERTIES = [
  [1, "no candidate visibility", ["tests/startup-recovery.test.ts"]],
  [2, "state/tip atomicity", ["tests/startup-recovery.test.ts"]],
  [3, "deterministic restart", ["tests/startup-recovery.test.ts", "tests/graph-consistency.test.ts", "tests/recovery-mutation-index.test.ts"]],
  [4, "lost-ACK idempotency", ["tests/startup-recovery.test.ts", "tests/production-roundtrip.test.ts", "PROBE:tranche4"]],
  [5, "object immutability", ["tests/startup-recovery.test.ts"]],
  [6, "missing-object failure", ["tests/startup-recovery.test.ts"]],
  [7, "prototype safety", ["tests/ether-data.test.ts"]],
  [8, "surrogate fidelity", ["tests/ether-data.test.ts"]],
  [9, "StateRoot bound + historical compatibility", ["tests/startup-recovery.test.ts", "tests/snapshot-profile.test.ts"]],
  [10, "generic 1 MiB replay preservation", ["tests/wal-stream.test.ts", "tests/wal.test.ts"]],
  [11, "incomplete tail vs complete corruption", ["tests/startup-recovery.test.ts", "tests/wal.test.ts"]],
  [12, "authority through publication", ["tests/startup-recovery.test.ts", "tests/recovery-mutation-index.test.ts"]],
  [13, "8 MiB / >1,024 history", ["tests/startup-recovery.test.ts", "tests/recovery-mutation-index.test.ts", "PROBE:tranche5"]],
  [14, "frozen WAL compatibility", ["tests/wal-wire-fixture.test.ts", "FIXTURES"]]
];

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { code: result.status, output: (result.stdout || "") + (result.stderr || "") };
};

// The vitest CLI lives in the nearest ancestor node_modules (this worktree
// may share the parent checkout's dependency tree).
const findVitestCli = () => {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "node_modules", "vitest", "vitest.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("vitest CLI not found in any ancestor node_modules");
    dir = parent;
  }
};
const vitestCli = findVitestCli();

const suiteResults = new Map();
const suiteQueue = [...new Set(PROPERTIES.flatMap(([, , suites]) => suites.filter(s => s.endsWith(".test.ts"))))];
console.log(JSON.stringify({ step: "running mapped suites", suites: suiteQueue }));
for (const suite of suiteQueue) {
  const vitest = run(process.execPath, [vitestCli, "run", suite]);
  suiteResults.set(suite, vitest.code === 0);
  if (vitest.code !== 0) console.log(vitest.output.split("\n").slice(-25).join("\n"));
  console.log(JSON.stringify({ suite, pass: vitest.code === 0 }));
}

let fixturesPass = true;
for (const [file, expected] of Object.entries(FIXTURE_HASHES)) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) fixturesPass = false;
  console.log(JSON.stringify({ fixture: file, sha256: actual, pass: actual === expected }));
}

const simulate = process.argv.includes("--simulate-directory-barriers");
if (process.platform === "win32" && !simulate) throw new Error("Select --simulate-directory-barriers for protocol testing on win32.");
const probeArgs = simulate ? ["--simulate-directory-barriers"] : [];
const tranche4 = run(process.execPath, ["scripts/af1-tranche4-probe.mjs", ...probeArgs]);
console.log(JSON.stringify({ probe: "tranche4", pass: tranche4.code === 0 }));
const tranche5 = run(process.execPath, ["scripts/af1-tranche5-recovery-probe.mjs", ...probeArgs]);
console.log(tranche5.output.trim().split("\n").slice(-14).join("\n"));
console.log(JSON.stringify({ probe: "tranche5", transactions: 1050, pass: tranche5.code === 0 }));

const receipt = PROPERTIES.map(([id, name, suites]) => {
  const pass = suites.every(suite => suite === "PROBE:tranche4" ? tranche4.code === 0
    : suite === "PROBE:tranche5" ? tranche5.code === 0
    : suite === "FIXTURES" ? fixturesPass
    : suiteResults.get(suite) === true);
  return { property: id, name, evidence: suites, pass };
});
console.log("\nORION VERIFICATION RECEIPT");
for (const row of receipt) console.log(`${row.pass ? "PASS" : "FAIL"}  ${String(row.property).padStart(2)}  ${row.name}  [${row.evidence.join(", ")}]`);
const failed = receipt.filter(row => !row.pass);
console.log(failed.length === 0
  ? "\nORION: ALL FOURTEEN PROPERTIES PASS"
  : `\nORION: ${failed.length} PROPERTY(IES) FAILED: ${failed.map(r => r.property).join(", ")}`);
assert.equal(failed.length, 0);
