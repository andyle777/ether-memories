import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { PersistenceErrorCode } from "../types/persistence.js";

export class DirectoryIoError extends Error {
  readonly details?: unknown;
  constructor(readonly code: PersistenceErrorCode, message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

/** Internal trusted backend boundary. Tests may replace operations, not capability booleans. */
export interface DirectoryIO {
  /** Internal capability; absent preserves the v0.6 strict test boundary. */
  readonly guarantee?: "strict" | "recoverable";
  kind(path: string): Promise<"missing" | "file" | "directory">;
  readBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * Stream exactly the entry NAMES of one directory to `visit`, one at a time.
   * Never materializes a name array, never stats or reads entries, never follows
   * entry symlinks (names only; callers validate entries through kind()).
   * A missing directory is zero names; every other failure is observable.
   */
  readNames(path: string, visit: (name: string) => Promise<void> | void): Promise<void>;
  mkdirExclusive(path: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  activateFile(candidate: string, destination: string): Promise<"atomic" | "process-recoverable">;
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
  async readNames(path, visit) {
    let dir: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      dir = await fs.opendir(path);
    } catch (error) {
      const native = (error as NodeJS.ErrnoException).code;
      if (native === "ENOENT") return;
      if (native === "EACCES" || native === "EPERM" || native === "EROFS") {
        throw new DirectoryIoError("READ_ONLY_LOCKED", "Directory enumeration is unavailable.");
      }
      throw new DirectoryIoError("RECOVERY_REQUIRED", "Directory enumeration failed.");
    }
    try {
      // dir.read() yields one entry at a time: names stream with no array
      // accumulation regardless of directory size.
      for (;;) {
        const entry = await dir.read();
        if (entry === null) return;
        await visit(entry.name);
      }
    } finally { await dir.close(); }
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

/** Weak acknowledgment deliberately has no strict durability field. Never persisted. */
export type InternalAcknowledgment = { readonly durability: "confirmed" }
  | { readonly acknowledgment: "process-recoverable" };
export const acknowledgmentFor = (io: DirectoryIO): InternalAcknowledgment =>
  io.guarantee === "recoverable" ? { acknowledgment: "process-recoverable" } : { durability: "confirmed" };
export const activationMatches = (io: DirectoryIO, activation: string): boolean =>
  activation === (io.guarantee === "recoverable" ? "process-recoverable" : "atomic");

/** Capture capability and operations once, before any runtime IO. */
export const captureDirectoryIO = (io: DirectoryIO): DirectoryIO => Object.freeze({
  guarantee: io.guarantee ?? "strict",
  kind: io.kind.bind(io), readBounded: io.readBounded.bind(io), readNames: io.readNames.bind(io),
  mkdirExclusive: io.mkdirExclusive.bind(io), writeExclusive: io.writeExclusive.bind(io),
  syncDirectory: io.syncDirectory.bind(io), activateFile: io.activateFile.bind(io), removeOwnedFile: io.removeOwnedFile.bind(io)
});

export function assertWindowsRecoverablePath(path: string): void {
  // Guard before native IO: Node 22/libuv can abort on U+10FFFF. Reject namespace,
  // ADS, DOS device and trailing-dot/space aliases rather than certifying them.
  if (path.includes(String.fromCodePoint(0x10ffff)) || path.startsWith("\\\\")
    || path.startsWith("//") || /^[\\/]\?\?/.test(path)) {
    throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Unsupported Windows recoverable path.");
  }
  const local = path.replace(/^[a-zA-Z]:/, "");
  for (const part of local.split(/[\\/]/)) {
    if (part === "." || part === ".." || part === "") continue;
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Unsupported Windows recoverable path component.");
    }
  }
}

/** Local Windows process-failure contract only; regular-file sync is retained. */
export const windowsRecoverableDirectoryIO: DirectoryIO = Object.freeze({
  guarantee: "recoverable",
  async kind(path: string) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.kind(path); },
  async readBounded(path: string, maxBytes: number) {
    assertWindowsRecoverablePath(path);
    // Windows file identifiers can exceed Number precision: compare exact bigint stamps.
    const before = await fs.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe or oversized persistence file.");
    }
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Persistence file changed during open.");
      }
      const bytes = Buffer.alloc(Number(stat.size) + 1);
      let read = 0;
      while (read < bytes.length) {
        const part = await handle.read(bytes, read, bytes.length - read, read);
        if (!part.bytesRead) break;
        read += part.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (BigInt(read) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Persistence file changed during read.");
      }
      return bytes.subarray(0, read);
    } finally { await handle.close(); }
  },
  async readNames(path: string, visit: (name: string) => Promise<void> | void) {
    assertWindowsRecoverablePath(path); return nodeDirectoryIO.readNames(path, visit);
  },
  async mkdirExclusive(path: string) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.mkdirExclusive(path); },
  async writeExclusive(path: string, bytes: Uint8Array) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.writeExclusive(path, bytes); },
  async syncDirectory(path: string) {
    assertWindowsRecoverablePath(path);
    if (await nodeDirectoryIO.kind(path) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Persistence directory is unavailable.");
    // Existence/entry validation only. No directory flush or power-loss claim.
  },
  async activateFile(candidate: string, destination: string) {
    assertWindowsRecoverablePath(candidate); assertWindowsRecoverablePath(destination);
    await fs.rename(candidate, destination);
    return "process-recoverable" as const;
  },
  async removeOwnedFile(path: string) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.removeOwnedFile(path); }
});
