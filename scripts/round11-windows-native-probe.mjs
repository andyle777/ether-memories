import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "ether-round11-"));
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  versions: process.versions,
  root,
  observations: {},
  assertions: []
};

const note = (name, value) => { report.observations[name] = value; };
const check = (name, condition, details = undefined) => {
  report.assertions.push({ name, ok: Boolean(condition), details });
  assert.ok(condition, `${name}${details ? `: ${JSON.stringify(details)}` : ""}`);
};
const capture = async fn => {
  try { return { ok: true, value: await fn() }; }
  catch (error) {
    return { ok: false, code: error?.code, name: error?.name, message: error?.message };
  }
};

try {
  check("probe runs on Windows", process.platform === "win32", { platform: process.platform });

  const { openDurableEtherMemories } = await import("../dist/index.js");
  const { nodeDirectoryIO } = await import("../dist/persistence/directoryIO.js");

  // Baseline RED: v0.6.0 intentionally refuses native Windows durable activation.
  const strictDir = join(root, "strict-store");
  const strictOpen = await openDurableEtherMemories({ userId: "round11", directory: strictDir });
  note("strictOpen", strictOpen.ok ? { ok: true } : { ok: false, code: strictOpen.error.code, message: strictOpen.error.message });
  check("v0.6 strict durable open fails closed on Windows", !strictOpen.ok && strictOpen.error.code === "DURABILITY_UNAVAILABLE", report.observations.strictOpen);

  // File sync is the recoverable-profile write barrier candidate.
  const syncFile = join(root, "sync-file.bin");
  const syncHandle = await fs.open(syncFile, "w+");
  try {
    await syncHandle.writeFile(Buffer.from("round11"));
    const fileSync = await capture(() => syncHandle.sync());
    note("fileSync", fileSync);
    check("FileHandle.sync succeeds for a regular file", fileSync.ok, fileSync);
  } finally { await syncHandle.close(); }

  // Measure the exact directory barrier primitive used by the v0.6 backend.
  const directorySync = await capture(async () => {
    const h = await fs.open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { await h.sync(); } finally { await h.close(); }
    return "synced";
  });
  note("directorySync", directorySync);

  // Existing destination replacement is what HEAD activation needs at process-recovery level.
  const renameDir = join(root, "rename");
  await fs.mkdir(renameDir);
  const destination = join(renameDir, "HEAD");
  const candidate = join(renameDir, "HEAD.candidate");
  await fs.writeFile(destination, "old");
  await fs.writeFile(candidate, "new");
  const replace = await capture(() => fs.rename(candidate, destination));
  note("renameReplace", replace);
  const destinationAfter = await capture(() => fs.readFile(destination, "utf8"));
  const candidateAfter = await capture(() => fs.lstat(candidate));
  note("renameReplacePostState", { destinationAfter, candidateExists: candidateAfter.ok });
  check("rename replacement leaves new destination visible", replace.ok && destinationAfter.ok && destinationAfter.value === "new" && !candidateAfter.ok, report.observations.renameReplacePostState);

  // Held-open destination behavior is relevant to EPERM/EBUSY reconciliation.
  await fs.writeFile(destination, "held-old");
  await fs.writeFile(candidate, "held-new");
  const held = await fs.open(destination, "r");
  let heldRename;
  try { heldRename = await capture(() => fs.rename(candidate, destination)); }
  finally { await held.close(); }
  const heldPost = await capture(() => fs.readFile(destination, "utf8"));
  note("heldDestinationRename", { rename: heldRename, destination: heldPost });
  check("held destination rename has a coherent success or refusal state", heldPost.ok
    && heldPost.value === (heldRename.ok ? "held-new" : "held-old"), report.observations.heldDestinationRename);

  // NTFS file identity must remain exact; Ether uses bigint stats for this purpose.
  const identityPath = join(root, "identity.bin");
  await fs.writeFile(identityPath, "id");
  const identity = await fs.lstat(identityPath, { bigint: true });
  note("bigintIdentity", {
    devType: typeof identity.dev,
    inoType: typeof identity.ino,
    mtimeNsType: typeof identity.mtimeNs,
    ctimeNsType: typeof identity.ctimeNs,
    nlink: identity.nlink.toString()
  });
  check("Windows file identity values are bigint", typeof identity.dev === "bigint" && typeof identity.ino === "bigint" && typeof identity.mtimeNs === "bigint" && typeof identity.ctimeNs === "bigint", report.observations.bigintIdentity);

  // Reserved-name aliases: characterize NTFS behavior rather than guessing.
  const aliasesDir = join(root, "aliases");
  await fs.mkdir(aliasesDir);
  const canonicalHead = join(aliasesDir, "HEAD");
  await fs.writeFile(canonicalHead, "head");
  const aliasResults = {};
  for (const alias of ["head", "Head", "HEAD.", "HEAD "]) {
    aliasResults[alias] = await capture(async () => {
      const s = await fs.lstat(join(aliasesDir, alias), { bigint: true });
      return { dev: s.dev.toString(), ino: s.ino.toString(), size: s.size.toString() };
    });
  }
  note("reservedNameAliases", aliasResults);

  // ADS is dangerous only if caller-controlled values become raw internal path components.
  const adsBase = join(root, "ads-base.txt");
  await fs.writeFile(adsBase, "base");
  const adsPath = `${adsBase}:round11`;
  const adsWrite = await capture(() => fs.writeFile(adsPath, "stream"));
  const adsRead = await capture(() => fs.readFile(adsPath, "utf8"));
  note("alternateDataStream", { write: adsWrite, read: adsRead });

  // Junction/reparse points must fail closed at Ether's storage boundary.
  const junctionTarget = join(root, "junction-target");
  const junctionPath = join(root, "junction-link");
  await fs.mkdir(junctionTarget);
  const junctionCreate = await capture(() => fs.symlink(junctionTarget, junctionPath, "junction"));
  let junctionKind;
  if (junctionCreate.ok) junctionKind = await capture(() => nodeDirectoryIO.kind(junctionPath));
  note("junction", { create: junctionCreate, kind: junctionKind });
  if (junctionCreate.ok) check("nodeDirectoryIO refuses a junction/reparse point", !junctionKind.ok && junctionKind.code === "RECOVERY_REQUIRED", report.observations.junction);

  // Probe the known Node-22 Windows U+10FFFF path edge in a child so a native abort cannot kill this harness.
  const unicodeChild = String.raw`
    import * as fs from 'node:fs/promises';
    import { join } from 'node:path';
    try {
      const p = join(process.env.ROUND11_TMP, 'u-' + String.fromCodePoint(0x10ffff));
      await fs.writeFile(p, 'x');
      await fs.unlink(p);
      process.exit(0);
    } catch (e) {
      console.error(JSON.stringify({ code: e?.code, name: e?.name, message: e?.message }));
      process.exit(2);
    }
  `;
  const unicode = spawnSync(process.execPath, ["--input-type=module", "-e", unicodeChild], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ROUND11_TMP: root }
  });
  note("unicodeU10FFFF", { status: unicode.status, signal: unicode.signal, error: unicode.error?.message, stderr: unicode.stderr, stdout: unicode.stdout });

  // Spaces + non-ASCII path sanity.
  const fancyDir = join(root, "Ether Café 測試 space");
  const fancy = await capture(async () => {
    await fs.mkdir(fancyDir);
    const p = join(fancyDir, "mémoire.txt");
    await fs.writeFile(p, "ok");
    return await fs.readFile(p, "utf8");
  });
  note("unicodeSpacesPath", fancy);
  check("spaces and ordinary Unicode paths work", fancy.ok && fancy.value === "ok", fancy);

  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = { name: error?.name, code: error?.code, message: error?.message, stack: error?.stack };
  process.exitCode = 1;
} finally {
  const reportPath = join(process.cwd(), `round11-report-${process.version.replaceAll('.', '_')}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
