import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDurableEtherMemoriesInternal, openDurableEtherMemories } from "../dist/core/DurableEtherMemories.js";
import { windowsRecoverableDirectoryIO } from "../dist/persistence/directoryIO.js";
import { nodeWalIO } from "../dist/persistence/walIO.js";

const value = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const userId = "round11-crash";

const options = directory => ({ userId, directory, durabilityGuarantee: "recoverable", openMode: "existing" });

const signalAndBlock = phase => {
  setInterval(() => {}, 1000); // Keep the child alive until the parent terminates it.
  process.stdout.write(`ROUND11_REACHED:${phase}\n`);
  return new Promise(() => {});
};

const makeCrashFiles = phase => {
  let armed = false;
  const files = {
    ...nodeWalIO,
    open: async (path, create) => {
      const h = await nodeWalIO.open(path, create);
      const isWal = /[\\/]wal[\\/]wal-[a-f0-9]{64}\.bin$/.test(path);
      let wrote = false;
      return {
        ...h,
        write: async (bytes, position) => {
          if (armed && isWal && phase === "partial-wal-write") {
            await h.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), position);
            await signalAndBlock(phase);
          }
          const n = await h.write(bytes, position);
          wrote = true;
          if (armed && isWal && phase === "after-wal-write" && n === bytes.length) await signalAndBlock(phase);
          return n;
        },
        sync: async () => {
          await h.sync();
          // Lookup also syncs the old WAL before append; stop only after this write.
          if (armed && isWal && wrote && phase === "after-wal-sync") await signalAndBlock(phase);
        }
      };
    }
  };
  return { files, arm: () => { armed = true; } };
};

async function childMode() {
  const directory = process.env.ROUND11_DIRECTORY;
  const phase = process.env.ROUND11_PHASE;
  assert.ok(directory && phase);
  const crash = makeCrashFiles(phase);
  const io = { ...windowsRecoverableDirectoryIO,
    activateFile: async (candidate, destination) => {
      if (phase === "before-head-rename" && destination.endsWith("HEAD")) await signalAndBlock(phase);
      const result = await windowsRecoverableDirectoryIO.activateFile(candidate, destination);
      if (phase === "after-head-rename" && destination.endsWith("HEAD")) await signalAndBlock(phase);
      return result;
    }
  };
  const runtime = value(await openDurableEtherMemoriesInternal(
    options(directory), { io, files: crash.files }));
  crash.arm();
  const result = await runtime.addMemory({ content: `crash-${phase}` }, `round11-${phase}`);
  if (phase.endsWith("head-rename")) value(await runtime.rotate());
  if (phase === "after-ack") { value(result); await signalAndBlock(phase); }
  process.stdout.write(`ROUND11_COMPLETED:${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 2);
}

const waitForMarkerAndKill = (directory, phase) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    env: { ...process.env, ROUND11_DIRECTORY: directory, ROUND11_PHASE: phase },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`Timed out waiting for ${phase}; stdout=${stdout}; stderr=${stderr}`));
  }, 30000);
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    if (!killed && stdout.includes(`ROUND11_REACHED:${phase}`)) {
      killed = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("exit", (exitCode, signal) => {
    clearTimeout(timer);
    if (!killed) return reject(new Error(`Child exited before marker for ${phase}; code=${exitCode}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
    resolve({ exitCode, signal, stdout, stderr });
  });
});

async function removeStaleAuthority(directory) {
  const lock = join(directory, "writer.lock");
  const text = await fs.readFile(lock, "utf8");
  assert.match(text, /storeId/);
  await fs.unlink(lock);
}

const openExisting = directory => openDurableEtherMemories(options(directory));

async function verifyCrashScenario(directory, phase) {
  const before = value(await openExisting(directory));
  const beforeCount = value(before.exportData()).memoryNotes.length;
  value(await before.close());

  const killed = await waitForMarkerAndKill(directory, phase);
  assert.ok(killed.signal || killed.exitCode !== 0, `child must be terminated at ${phase}`);

  if (phase !== "after-ack") {
    const blocked = await openExisting(directory);
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error.code, "WRITER_BUSY", JSON.stringify(blocked));
    // Test harness only, after the known child has exited. Production never breaks locks.
    await removeStaleAuthority(directory);
  }

  const recovered = value(await openExisting(directory));
  const afterRecovery = value(recovered.exportData());
  const matching = afterRecovery.memoryNotes.filter(n => n.content === `crash-${phase}`);
  assert.ok(matching.length <= 1, "recovery must never duplicate the logical mutation");
  assert.equal(matching.length, phase === "partial-wal-write" ? 0 : 1, `${phase}: complete writes survive process termination; partial tails are repaired`);

  const retry = value(await recovered.addMemory({ content: `crash-${phase}` }, `round11-${phase}`));
  assert.equal(retry.content, `crash-${phase}`);
  const afterRetry = value(recovered.exportData());
  assert.equal(afterRetry.memoryNotes.filter(n => n.content === `crash-${phase}`).length, 1);
  assert.equal(afterRetry.memoryNotes.length, beforeCount + 1);
  value(await recovered.close());

  return {
    phase,
    crashExit: { code: killed.exitCode, signal: killed.signal },
    staleLockRefused: phase !== "after-ack",
    presentImmediatelyAfterRecovery: matching.length === 1,
    stableRetryConvergedExactlyOnce: true
  };
}

async function parentMode() {
  assert.equal(process.platform, "win32", "Round 11 crash probe is native-Windows only");
  const parent = await fs.mkdtemp(join(tmpdir(), "ether-round11-crash-"));
  const directory = join(parent, "store");
  const report = { platform: process.platform, node: process.version, uv: process.versions.uv, scenarios: [] };
  try {
    const runtime = value(await openDurableEtherMemories({ userId, directory, durabilityGuarantee: "recoverable" }));
    value(await runtime.addMemory({ content: "baseline" }, "round11-baseline"));
    value(await runtime.close());

    const normal = value(await openExisting(directory));
    value(await normal.addMemory({ content: "normal-control" }, "round11-normal"));
    value(await normal.close());
    const normalReopen = value(await openExisting(directory));
    assert.ok(value(normalReopen.exportData()).memoryNotes.some(n => n.content === "normal-control"));
    value(await normalReopen.close());
    report.normalControl = true;

    for (const phase of ["partial-wal-write", "after-wal-write", "after-wal-sync", "after-ack", "before-head-rename", "after-head-rename"]) {
      report.scenarios.push(await verifyCrashScenario(directory, phase));
    }
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    console.log("ROUND11 WINDOWS CRASH PROBE: PASS");
  } finally {
    await fs.writeFile(`round11-report-crash-${process.version.replaceAll('.', '_')}.json`, JSON.stringify(report, null, 2));
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv.includes("--child")) await childMode();
else await parentMode();
