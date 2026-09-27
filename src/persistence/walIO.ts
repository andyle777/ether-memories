import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { DirectoryIoError } from "./directoryIO.js";

/** Change indicators only: even all-equal nanosecond stamps do not prove equal bytes. */
export interface WalFileStamp {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtime: bigint;
  readonly ctime: bigint;
}
export interface WalFileHandle {
  stat(): Promise<WalFileStamp>;
  read(bytes: Uint8Array, position: number): Promise<number>;
  write(bytes: Uint8Array, position: number): Promise<number>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** Trusted syscall boundary, not application callbacks or durability capability flags. */
export interface WalIO {
  stamp(path: string): Promise<WalFileStamp>;
  open(path: string, create: boolean): Promise<WalFileHandle>;
}

function stamp(stat: BigIntStats): WalFileStamp {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe WAL file or unsupported exact physical offset.");
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtime: stat.mtimeNs, ctime: stat.ctimeNs });
}
export const sameWalStamp = (a: WalFileStamp, b: WalFileStamp): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;

export const nodeWalIO: WalIO = {
  async stamp(path) { return stamp(await fs.lstat(path, { bigint: true })); },
  async open(path, create) {
    const before = create ? undefined : await this.stamp(path);
    // Positional writes, never O_APPEND or truncation. Exclusive authority serializes writers.
    const handle = await fs.open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try {
      const opened = stamp(await handle.stat({ bigint: true }));
      if ((before && !sameWalStamp(before, opened)) || !sameWalStamp(opened, await this.stamp(path))) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "WAL changed during open.");
      }
    } catch (error) { await handle.close(); throw error; }
    return {
      async stat() { return stamp(await handle.stat({ bigint: true })); },
      async read(bytes, position) { return (await handle.read(bytes, 0, bytes.byteLength, position)).bytesRead; },
      async write(bytes, position) { return (await handle.write(bytes, 0, bytes.byteLength, position)).bytesWritten; },
      async sync() { await handle.sync(); },
      async close() { await handle.close(); }
    };
  }
};
