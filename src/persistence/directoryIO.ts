import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { PersistenceErrorCode } from "../types/persistence.js";

export class DirectoryIoError extends Error {
  constructor(readonly code: PersistenceErrorCode, message: string) { super(message); }
}

/** Internal trusted backend boundary. Tests may replace operations, not capability booleans. */
export interface DirectoryIO {
  kind(path: string): Promise<"missing" | "file" | "directory">;
  readBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  mkdirExclusive(path: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  activateFile(candidate: string, destination: string): Promise<"atomic">;
  removeOwnedFile(path: string): Promise<void>;
}

export const nodeDirectoryIO: DirectoryIO = {
  async kind(path) {
    try {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe filesystem entry.");
      }
      return stat.isDirectory() ? "directory" : "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  },
  async readBounded(path, maxBytes) {
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
      throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe or oversized persistence file.");
    }
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino
        || stat.size !== before.size || stat.size > maxBytes) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Persistence file changed during open.");
      }
      // Never readFile an unbounded/growing file: allocate at most limit + one overflow byte.
      const bytes = Buffer.alloc(stat.size + 1);
      let read = 0;
      while (read < bytes.byteLength) {
        const part = await handle.read(bytes, read, bytes.byteLength - read, read);
        if (part.bytesRead === 0) break;
        read += part.bytesRead;
      }
      const after = await handle.stat();
      if (read !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Persistence file changed during read.");
      }
      return bytes.subarray(0, read);
    } finally { await handle.close(); }
  },
  async mkdirExclusive(path) { await fs.mkdir(path, { mode: 0o700 }); },
  async writeExclusive(path, bytes) {
    const handle = await fs.open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      try { await handle.sync(); }
      catch { throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "File durability barrier failed."); }
    } finally { await handle.close(); }
  },
  async syncDirectory(path) {
    try {
      const handle = await fs.open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try { await handle.sync(); } finally { await handle.close(); }
    } catch { throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Directory durability barrier unavailable or failed."); }
  },
  async activateFile(candidate, destination) {
    // No portable Windows directory-barrier/atomic-replace guarantee is claimed.
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Atomic activation is unsupported on this platform.");
    }
    await fs.rename(candidate, destination);
    return "atomic";
  },
  async removeOwnedFile(path) { await fs.unlink(path); }
};
