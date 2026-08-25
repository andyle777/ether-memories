import { promises as fs } from "node:fs";
import type { EtherSnapshot, StoragePort } from "../types/index.js";

export class FsJsonStorage implements StoragePort {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown> {
    return JSON.parse(await fs.readFile(this.path, "utf8"));
  }

  async save(snapshot: EtherSnapshot): Promise<void> {
    await fs.writeFile(this.path, JSON.stringify(snapshot, null, 2), "utf8");
  }
}

export const hydrateDate = (value: unknown): Date | undefined => {
  if (value == null) return undefined;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d;
};
