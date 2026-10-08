import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDurableEtherMemories } from "../dist/index.js";

const record = (name, value) => console.log(`[round11] ${name}:`, value);
const root = mkdtempSync(join(tmpdir(), "ether-round11-"));

try {
  record("platform", { platform: process.platform, node: process.version, arch: process.arch });
  assert.equal(process.platform, "win32", "Round 11 preflight must run natively on Windows.");

  const syncFile = join(root, "sync.bin");
  const file = await fs.open(syncFile, "wx");
  try { await file.writeFile(Buffer.from("ether")); await file.sync(); }
  finally { await file.close(); }
  record("file-sync", "ok");

  try {
    const dir = await fs.open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await dir.sync(); record("directory-sync", "ok"); }
    finally { await dir.close(); }
  } catch (error) {
    record("directory-sync", { code: error?.code ?? null, message: String(error?.message ?? error) });
  }

  const destination = join(root, "HEAD");
  const candidate = join(root, "HEAD.candidate");
  await fs.writeFile(destination, "old");
  await fs.writeFile(candidate, "new");
  await fs.rename(candidate, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "new");
  record("rename-replace-existing", "ok");

  const heldCandidate = join(root, "HEAD.held.candidate");
  await fs.writeFile(heldCandidate, "held-new");
  const held = await fs.open(destination, "r");
  try {
    try {
      await fs.rename(heldCandidate, destination);
      record("rename-held-destination", { result: "ok", content: await fs.readFile(destination, "utf8") });
    } catch (error) {
      record("rename-held-destination", { result: "error", code: error?.code ?? null, message: String(error?.message ?? error) });
    }
  } finally { await held.close(); }

  const identity = await fs.lstat(destination, { bigint: true });
  record("bigint-identity", {
    devType: typeof identity.dev,
    inoType: typeof identity.ino,
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    mtimeNsType: typeof identity.mtimeNs,
    ctimeNsType: typeof identity.ctimeNs
  });
  assert.equal(typeof identity.dev, "bigint");
  assert.equal(typeof identity.ino, "bigint");

  const aliases = {};
  for (const name of ["head", "HEAD.", "HEAD "]) {
    try {
      const s = await fs.lstat(join(root, name), { bigint: true });
      aliases[name] = { exists: true, ino: s.ino.toString() };
    } catch (error) { aliases[name] = { exists: false, code: error?.code ?? null }; }
  }
  record("reserved-aliases", aliases);

  try {
    await fs.writeFile(join(root, "ads-base"), "base");
    await fs.writeFile(join(root, "ads-base:round11"), "stream");
    record("ads", { result: "created", stream: await fs.readFile(join(root, "ads-base:round11"), "utf8") });
  } catch (error) {
    record("ads", { result: "error", code: error?.code ?? null, message: String(error?.message ?? error) });
  }

  try {
    const target = join(root, "junction-target");
    const link = join(root, "junction-link");
    await fs.mkdir(target);
    await fs.symlink(target, link, "junction");
    const linkStat = await fs.lstat(link);
    record("junction", { created: true, isSymbolicLink: linkStat.isSymbolicLink() });
  } catch (error) {
    record("junction", { created: false, code: error?.code ?? null, message: String(error?.message ?? error) });
  }

  const weird = String.fromCodePoint(0x10ffff);
  const childCode = `const fs=require('node:fs'); const p=process.argv[1]+${JSON.stringify(weird)}; try { fs.existsSync(p); process.exit(0); } catch { process.exit(3); }`;
  const weirdChild = spawnSync(process.execPath, ["-e", childCode, root], { encoding: "utf8" });
  record("u10ffff-child", { status: weirdChild.status, signal: weirdChild.signal, stderr: weirdChild.stderr?.trim() ?? "" });

  const strictDir = join(root, "strict-store");
  const strict = await openDurableEtherMemories({ userId: "round11-strict", directory: strictDir, openMode: "create" });
  record("strict-open", strict.ok ? { ok: true } : { ok: false, code: strict.error.code, message: strict.error.message });
  assert.equal(strict.ok, false, "Strict profile unexpectedly opened on native Windows.");
  assert.equal(strict.error.code, "DURABILITY_UNAVAILABLE", "Strict Windows failure must stay explicit and fail-closed.");

  const recoverableDir = join(root, "recoverable-store");
  const recoverable = await openDurableEtherMemories({
    userId: "round11-recoverable",
    directory: recoverableDir,
    openMode: "create",
    durabilityGuarantee: "recoverable"
  });
  record("recoverable-open-red-test", recoverable.ok ? { ok: true } : { ok: false, code: recoverable.error.code, message: recoverable.error.message });
  assert.equal(recoverable.ok, true, "EXPECTED RED: recoverable Windows profile is not implemented yet.");
  await recoverable.value.close();
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
