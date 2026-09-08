import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EtherSnapshot, StoragePort } from "../types/index.js";

export class FsJsonStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown> {
    return JSON.parse(await fs.readFile(this.path, "utf8"));
  }

  async save(snapshot: EtherSnapshot): Promise<void> {
    const dir = dirname(this.path);
    const temp = join(dir, `.${this.path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await fs.open(temp, "w");
      try {
        await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      let last: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await fs.rename(temp, this.path); last = undefined; break; }
        catch (e) { last = e; if (!(e instanceof Error && ["EPERM", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? ""))) throw e; await new Promise(r => setTimeout(r, 10 * (attempt + 1))); }
      }
      if (last) throw last;
      try { const dh = await fs.open(dir, "r"); await dh.sync(); await dh.close(); } catch { /* directory fsync unsupported */ }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}

export const hydrateDate = (value: unknown): Date | undefined => {
  if (value == null) return undefined;
  const d = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "number"
      ? new Date(value)
      : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d;
};
