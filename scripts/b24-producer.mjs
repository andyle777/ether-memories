import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const producerArchiveSha256 = "aa9d978e97d0fdbe68d7f79d9d430d91009ba5a98f09be753e32e1107f3a89e4";
const release = "https://registry.npmjs.org/ether-memories/-/ether-memories-0.7.0.tgz";
const run = promisify(execFile);
export function verifyProducerArchive(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== producerArchiveSha256) {
    throw new Error("Released producer archive integrity mismatch");
  }
}
export async function prepareProducer(root) {
  const tmp = await mkdtemp(path.join(root, "node_modules", ".b24-producer-"));
  try {
    const response = await fetch(release, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Producer download failed: HTTP " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyProducerArchive(bytes);
    const archive = path.join(tmp, "producer.tgz");
    await writeFile(archive, bytes);
    await run("tar", ["-xzf", archive, "-C", tmp], { timeout: 30000 });
    const module = await import(pathToFileURL(path.join(tmp, "package", "dist", "index.js")).href);
    return { archive, openProducer: module.openDurableEtherMemories, cleanup: () => rm(tmp, { recursive: true, force: true }) };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}
