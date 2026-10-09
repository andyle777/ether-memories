import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Run after tests in an isolated checkout. Observe only; never kill or hide leaks.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const normalizedRoot = root.replaceAll("\\", "/").toLowerCase();
const leaked = [];
if (process.platform === "win32") {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ], { encoding: "utf8" }).trim();
  const records = raw ? JSON.parse(raw) : [];
  for (const entry of Array.isArray(records) ? records : [records]) {
    if (entry.ProcessId !== process.pid && entry.CommandLine?.replaceAll("\\", "/").toLowerCase().includes(normalizedRoot)) leaked.push(entry.ProcessId);
  }
} else if (process.platform === "linux") {
  const ancestors = new Set([process.pid]);
  let parent = process.ppid;
  while (parent > 0 && !ancestors.has(parent)) {
    ancestors.add(parent);
    const stat = readFileSync(`/proc/${parent}/stat`, "utf8");
    parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  for (const value of readdirSync("/proc")) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0 || ancestors.has(pid)) continue;
    try {
      if (!/^node(?:\b|js)/.test(readFileSync(`/proc/${pid}/comm`, "utf8"))) continue;
      if (resolve(readlinkSync(`/proc/${pid}/cwd`)) === root) leaked.push(pid);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
} else throw Error(`Worker-exit verification is not implemented for ${process.platform}.`);
if (leaked.length) throw Error(`Node processes remain in the test checkout: ${leaked.join(", ")}`);
console.log(JSON.stringify({ testWorkerExit: "passed", checkout: root, leakedNodeProcesses: leaked }));
