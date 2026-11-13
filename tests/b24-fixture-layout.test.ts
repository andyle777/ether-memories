import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("initializes only known fixture directories and leaves other stores unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "b24-layout-"));
  const fixture = path.join(root, "tests/fixtures/b24-t3-v070/store");
  const negative = path.join(root, "negative/store");
  await fs.mkdir(fixture, {recursive:true});
  await fs.mkdir(negative, {recursive:true});
  await fs.writeFile(path.join(fixture, "HEAD"), "fixture bytes");
  await fs.writeFile(path.join(negative, "HEAD"), "negative bytes");
  const run = spawnSync(process.execPath, [path.resolve("scripts/prepare-b24-fixtures.mjs"), root], {encoding:"utf8"});
  expect(run.status, run.stderr).toBe(0);
  expect((await fs.readdir(fixture)).sort()).toEqual([".private", "HEAD", "wal"]);
  expect(await fs.readFile(path.join(fixture, "HEAD"), "utf8")).toBe("fixture bytes");
  expect(await fs.readdir(negative)).toEqual(["HEAD"]);
});
