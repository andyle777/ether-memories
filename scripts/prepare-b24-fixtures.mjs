import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Each root is an authentic fixture; only directories absent from Git are created.
const fixtureRoots = [
  "tests/fixtures/b24-t3-v070/store",
  "tests/fixtures/b24-abs-v070/store",
  ".b24-campaign-20261110/compat-v070/producer-originals/rotated-reclaimed"
];
export async function prepareFixtures(root) {
  for (const fixture of fixtureRoots) {
    const base = path.join(root, fixture);
    try { await access(path.join(base, "HEAD")); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const directory of [".private", "wal"]) {
      await mkdir(path.join(base, directory), { recursive: true });
    }
  }
}
export default async function setup() {
  await prepareFixtures(process.cwd());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareFixtures(path.resolve(process.argv[2] ?? process.cwd()));
}
