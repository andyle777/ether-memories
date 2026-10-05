import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import { ETHER_DATA_PROFILE, MAX_ETHER_DATA_BYTES, decodeEtherData } from "./etherData.js";
import { DirectoryIoError, type DirectoryIO } from "./directoryIO.js";
import type { WalIO } from "./walIO.js";
import type { RecoveryAuthority } from "./recoveryAuthority.js";
import { required } from "./recoveryAuthority.js";
import type { JsonObject } from "./walJson.js";

export const OBJECT_REFERENCE = "ether.data-ref.v1" as const;
export interface PayloadReference extends JsonObject {
  encoding: typeof OBJECT_REFERENCE;
  profile: typeof ETHER_DATA_PROFILE;
  digest: string;
  byteLength: number;
}
export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const referenceFor = (bytes: Uint8Array): PayloadReference => Object.freeze({
  encoding: OBJECT_REFERENCE, profile: ETHER_DATA_PROFILE, digest: digestBytes(bytes), byteLength: bytes.byteLength
});
export function validateReference(value: unknown): Result<PayloadReference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("INVALID_INPUT", "Invalid payload reference.");
  const v = value as Record<string, unknown>;
  if (v.encoding !== OBJECT_REFERENCE || v.profile !== ETHER_DATA_PROFILE) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported semantic object profile.");
  if (Object.keys(v).sort().join(",") !== "byteLength,digest,encoding,profile"
    || typeof v.digest !== "string" || !/^[a-f0-9]{64}$/.test(v.digest) || !Number.isSafeInteger(v.byteLength)
    || (v.byteLength as number) < 1 || (v.byteLength as number) > MAX_ETHER_DATA_BYTES) return err("INVALID_INPUT", "Invalid bounded payload reference.");
  return ok(v as PayloadReference);
}
export class PayloadObjects {
  constructor(private readonly io: DirectoryIO, private readonly files: WalIO) {}
  private async directory(authority: RecoveryAuthority, create: boolean): Promise<string> {
    const path = join(authority.directory, "objects");
    const kind = await this.io.kind(path);
    if (kind === "missing" && create) { await this.io.mkdirExclusive(path); await this.io.syncDirectory(authority.directory); }
    else if (kind !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Missing or unsafe payload-object directory.");
    return path;
  }
  async read(authority: RecoveryAuthority, input: PayloadReference): Promise<Uint8Array> {
    const ref = required(validateReference(input));
    await authority.verify();
    const directory = await this.directory(authority, false);
    const bytes = await this.io.readBounded(join(directory, ref.digest + ".bin"), ref.byteLength);
    if (bytes.byteLength !== ref.byteLength || digestBytes(bytes) !== ref.digest) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Referenced object integrity failed.");
    required(decodeEtherData(bytes));
    await authority.verify();
    return bytes;
  }
  async install(authority: RecoveryAuthority, bytes: Uint8Array): Promise<PayloadReference> {
    required(decodeEtherData(bytes));
    const ref = required(validateReference(referenceFor(bytes)));
    await authority.verify();
    const directory = await this.directory(authority, true);
    const destination = join(directory, ref.digest + ".bin");
    if (await this.io.kind(destination) === "missing") {
      const temporary = join(authority.directory, ".private", "object-" + randomUUID() + ".tmp");
      const file = await this.files.open(temporary, true);
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = await file.write(bytes.subarray(offset), offset);
          if (!Number.isSafeInteger(written) || written < 1 || written > bytes.byteLength - offset) throw new DirectoryIoError("RECOVERY_REQUIRED", "Invalid object partial-write result.");
          offset += written;
        }
        if ((await file.stat()).size !== bytes.byteLength) throw new DirectoryIoError("RECOVERY_REQUIRED", "Object length changed.");
        try { await file.sync(); } catch { throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Object file sync failed."); }
      } finally { await file.close(); }
      await authority.verify();
      // All conforming installers hold writer authority. Never overwrite an existing digest path.
      if (await this.io.kind(destination) !== "missing") throw new DirectoryIoError("RECOVERY_REQUIRED", "Object destination appeared during install.");
      if (await this.io.activateFile(temporary, destination) !== "atomic") throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Object install was not atomic.");
      await this.io.syncDirectory(join(authority.directory, ".private"));
    } else {
      await this.read(authority, ref);
      const existing = await this.files.open(destination, false);
      try { await existing.sync(); } finally { await existing.close(); }
    }
    await this.io.syncDirectory(directory);
    const persisted = await this.read(authority, ref);
    if (!Buffer.from(persisted).equals(bytes)) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Object bytes differ.");
    return ref;
  }
}
