import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { err, type Result } from "../utils/result.js";
import { decodeStoreHead, PERSISTENCE_LIMITS, type PersistedStoreHead } from "./codecs.js";
import { DirectoryIoError, type DirectoryIO } from "./directoryIO.js";

export function required<T>(r: Result<T>): T {
  if (!r.ok) throw new DirectoryIoError(r.error.code as DirectoryIoError["code"], r.error.message, r.error.details);
  return r.value;
}
export interface RecoveryAuthority {
  readonly directory: string;
  readonly head: PersistedStoreHead;
  verify(): Promise<void>;
}
/** Internal trusted coordinator boundary. Same writer.lock protocol as Tranche 4. */
export async function withRecoveryAuthority<T>(directory: string, io: DirectoryIO,
  run: (authority: RecoveryAuthority) => Promise<Result<T>>): Promise<Result<T>> {
  let owned = false;
  let bytes: Buffer | undefined;
  let lock = "";
  let result: Result<T>;
  try {
    if (!directory.trim() || directory.startsWith("\\\\") || Buffer.byteLength(directory) > 4096) {
      throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Bounded local store path required.");
    }
    directory = resolve(directory);
    lock = join(directory, "writer.lock");
    const layout = async () => {
      const root = parse(directory).root;
      let path = directory;
      while (true) {
        if (await io.kind(path) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe store path.");
        if (path === root) break;
        path = dirname(path);
      }
      for (const name of ["checkpoints", "wal", ".private"]) {
        if (await io.kind(join(directory, name)) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Incomplete store layout.");
      }
    };
    await layout();
    await io.syncDirectory(directory);
    await io.syncDirectory(join(directory, "wal"));
    const original = Buffer.from(await io.readBounded(join(directory, "HEAD"), PERSISTENCE_LIMITS.headBytes));
    const head = required(decodeStoreHead(original));
    bytes = Buffer.from(JSON.stringify({ storeId: head.storeId, authorityId: randomUUID() }));
    await io.writeExclusive(lock, bytes);
    owned = true;
    await io.syncDirectory(directory);
    const verify = async () => {
      await layout();
      if (!owned || !Buffer.from(await io.readBounded(lock, 1024)).equals(bytes!)
        || !Buffer.from(await io.readBounded(join(directory, "HEAD"), PERSISTENCE_LIMITS.headBytes)).equals(original)) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Recovery authority or HEAD changed.");
      }
    };
    await verify();
    result = await run(Object.freeze({ directory, head, verify }));
  } catch (e) {
    const native = (e as NodeJS.ErrnoException)?.code;
    const code = e instanceof DirectoryIoError ? e.code : native === "EEXIST" ? "WRITER_BUSY"
      : ["EPERM", "EACCES", "EROFS"].includes(native ?? "") ? "READ_ONLY_LOCKED" : "RECOVERY_REQUIRED";
    result = err(code, e instanceof DirectoryIoError ? e.message : "Recovery authority operation failed.",
      e instanceof DirectoryIoError ? e.details : undefined);
  }
  if (owned) {
    try {
      if (!Buffer.from(await io.readBounded(lock, 1024)).equals(bytes!)) throw new Error("Lost authority");
      await io.removeOwnedFile(lock);
      owned = false;
      await io.syncDirectory(directory);
    } catch { result = err("RECOVERY_REQUIRED", "Recovery authority release/barrier failed."); }
  }
  return result;
}
