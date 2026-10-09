import { readFileSync } from "node:fs";

// Offline floors for the known advisories; fresh npm audits remain freeze gates.
const floors = new Map([
  ["vitest", [4, 1, 11]], ["@vitest/mocker", [4, 1, 11]],
  ["tinypool", [2, 1, 2]], ["source-map-js", [1, 2, 2]]
]);
const lock = JSON.parse(readFileSync(process.argv[2] ?? new URL("../package-lock.json", import.meta.url), "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages) throw Error("Expected a v3 package lock with package entries.");
const checked = [], failures = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  const name = entry.name ?? path.split("node_modules/").at(-1);
  const floor = floors.get(name);
  if (!floor) continue;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.version ?? "");
  if (!match) { failures.push(`${path}: invalid or prerelease version ${entry.version}`); continue; }
  const version = match.slice(1).map(Number);
  const first = version.findIndex((part, i) => part !== floor[i]);
  if (first !== -1 && version[first] < floor[first]) failures.push(`${path}: version ${entry.version} is below fixed baseline ${floor.join(".")}`);
  checked.push({ path, name, version: entry.version });
}
for (const name of ["vitest", "@vitest/mocker"]) {
  if (!checked.some(entry => entry.name === name)) failures.push(`Missing required ${name} tooling entry.`);
}
if (failures.length) throw Error(`Known-advisory toolchain check failed:\n${failures.join("\n")}`);
console.log(JSON.stringify({ knownAdvisoryBaseline: "passed", checked }));
