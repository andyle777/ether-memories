import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { err, ok, type Result } from "../utils/result.js";
import { STORE_SCHEMA_VERSION } from "../version.js";
import { decodeStoreHead, encodeStoreHead, persistenceLimits, verifyCheckpoint,
  type PersistedStoreHead, type PersistenceLimitOptions, type PersistenceLimits } from "./codecs.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";

export interface FsDurableStoreOptions {
  /** Explicit local directory; never interpreted as legacy storagePath. Parent must already exist. */
  readonly directory: string;
  readonly limits?: PersistenceLimitOptions;
}

export type DurableStoreInspection =
  | { readonly state: "missing" }
  | { readonly state: "legacy-json" }
  | { readonly state: "active"; readonly head: PersistedStoreHead; readonly recovery: "required" };

export interface HeadActivationReceipt {
  readonly head: PersistedStoreHead;
  readonly activation: "atomic";
  readonly durability: "confirmed";
}

/** Metadata foundation only. Not a StoragePort, recovered store, or durable memory mutator. */
export class FsDurableStore {
  private readonly directory: string;
  private readonly limits: Result<PersistenceLimits>;

  constructor(options: FsDurableStoreOptions, private readonly io: DirectoryIO = nodeDirectoryIO) {
    this.directory = typeof options.directory === "string" && options.directory.trim() !== "" ? resolve(options.directory) : "";
    this.limits = persistenceLimits(options.limits);
  }

  private async pathChain(): Promise<void> {
    if (this.directory === "" || this.directory.startsWith("\\\\")) {
      throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "An explicit local durable-store directory is required.");
    }
    const root = parse(this.directory).root;
    let path = dirname(this.directory);
    const ancestors = [];
    while (path !== root) { ancestors.push(path); path = dirname(path); }
    ancestors.push(root);
    for (const ancestor of ancestors.reverse()) {
      if (await this.io.kind(ancestor) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Durable-store parent is missing or unsafe.");
    }
  }

  private checkpointPath(head: PersistedStoreHead): string {
    return join(this.directory, "checkpoints", `checkpoint-${head.checkpoint.checkpointId}.bin`);
  }

  private failure(error: unknown, phase: string, activation = "not-attempted"): Result<never> {
    const nativeCode = (error as NodeJS.ErrnoException | null)?.code;
    const code = error instanceof DirectoryIoError ? error.code
      : nativeCode === "EACCES" || nativeCode === "EPERM" || nativeCode === "EROFS" ? "READ_ONLY_LOCKED"
      : nativeCode === "EEXIST" ? "WRITER_BUSY" : "RECOVERY_REQUIRED";
    return err(code, "Durable-store operation could not establish its required guarantees.", { phase, activation, durability: "unconfirmed" });
  }

  private authorityFailure<T>(result: Result<T>): Result<T> {
    if (result.ok || result.error.code !== "PERSISTENCE_CORRUPTION") return result;
    return err("RECOVERY_REQUIRED", "Active durable-store authority is malformed or inconsistent.", { cause: result.error.code });
  }

  /** Read-only metadata/integrity inspection. Never promotes, replays, repairs, or cleans up. */
  async inspect(): Promise<Result<DurableStoreInspection>> {
    if (!this.limits.ok) return this.limits;
    const limits = this.limits.value;
    try {
      await this.pathChain();
      const kind = await this.io.kind(this.directory);
      if (kind === "missing") return ok({ state: "missing" });
      if (kind === "file") {
        const bytes = await this.io.readBounded(this.directory, limits.checkpointPayloadBytes);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { return err("RECOVERY_REQUIRED", "Existing path is not a recognized legacy snapshot."); }
        if (typeof value === "object" && value !== null && "schemaVersion" in value) {
          if (value.schemaVersion === STORE_SCHEMA_VERSION) return ok({ state: "legacy-json" });
          if (typeof value.schemaVersion === "string" && value.schemaVersion.startsWith("ether.memory_store.")) {
            return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported legacy snapshot schema.");
          }
        }
        return err("RECOVERY_REQUIRED", "Existing file is not a recognized legacy snapshot.");
      }
      if (await this.io.kind(join(this.directory, "writer.lock")) !== "missing") return err("WRITER_BUSY", "Writer authority is present; it will not be broken automatically.");
      for (const name of ["checkpoints", "wal", ".private"]) {
        if (await this.io.kind(join(this.directory, name)) !== "directory") return err("RECOVERY_REQUIRED", "Incomplete durable-store layout.");
      }
      const headBytes = await this.io.readBounded(join(this.directory, "HEAD"), limits.headBytes);
      const head = this.authorityFailure(decodeStoreHead(headBytes, limits));
      if (!head.ok) return head;
      const checkpoint = await this.io.readBounded(this.checkpointPath(head.value), limits.checkpointHeaderBytes + 1 + limits.checkpointPayloadBytes);
      const verified = this.authorityFailure(verifyCheckpoint(checkpoint, head.value, limits));
      if (!verified.ok) return verified;
      // Do not return an authority assembled across concurrent bootstrap/activation.
      if (await this.io.kind(join(this.directory, "writer.lock")) !== "missing"
        || !Buffer.from(await this.io.readBounded(join(this.directory, "HEAD"), limits.headBytes)).equals(Buffer.from(headBytes))) {
        return err("RECOVERY_REQUIRED", "Authority changed during inspection.");
      }
      return ok({ state: "active", head: head.value, recovery: "required" });
    } catch (error) { return this.failure(error, "inspection"); }
  }

  /** Bootstrap an absent directory from a prepared checkpoint. No overwrite, migration or recovery. */
  async initialize(input: { readonly head: PersistedStoreHead; readonly checkpointBytes: Uint8Array }): Promise<Result<HeadActivationReceipt>> {
    if (!this.limits.ok) return this.limits;
    const limits = this.limits.value;
    const encoded = encodeStoreHead(input.head, limits);
    if (!encoded.ok) return encoded;
    if (!(input.checkpointBytes instanceof Uint8Array)
      || input.checkpointBytes.byteLength > limits.checkpointHeaderBytes + 1 + limits.checkpointPayloadBytes) {
      return err("PERSISTENCE_CORRUPTION", "Checkpoint exceeds its byte bound.");
    }
    // Own all bytes before the first await; caller mutation cannot change what is verified/written.
    const checkpoint = Buffer.from(input.checkpointBytes);
    const head = decodeStoreHead(encoded.value, limits);
    if (!head.ok) return head;
    const verified = verifyCheckpoint(checkpoint, head.value, limits);
    if (!verified.ok) return verified;
    const lock = join(this.directory, "writer.lock");
    const candidate = join(this.directory, ".private", "HEAD.candidate");
    let ownsLock = false;
    let phase = "preflight";
    let activation = "not-attempted";
    let result: Result<HeadActivationReceipt>;
    try {
      await this.pathChain();
      const existing = await this.inspect();
      if (!existing.ok) return existing;
      if (existing.value.state !== "missing") return err("RECOVERY_REQUIRED", "Initialization requires an absent directory; existing storage is never overwritten.");
      // Test the required directory barrier before creating any store artifacts.
      await this.io.syncDirectory(dirname(this.directory));
      phase = "layout";
      await this.io.mkdirExclusive(this.directory);
      phase = "writer-authority";
      await this.io.writeExclusive(lock, Buffer.from(JSON.stringify({ storeId: head.value.storeId, authorityId: randomUUID() }), "utf8"));
      ownsLock = true;
      for (const name of ["checkpoints", "wal", ".private"]) await this.io.mkdirExclusive(join(this.directory, name));
      phase = "checkpoint";
      await this.io.writeExclusive(this.checkpointPath(head.value), checkpoint);
      await this.io.syncDirectory(join(this.directory, "checkpoints"));
      await this.io.syncDirectory(join(this.directory, "wal"));
      await this.io.syncDirectory(this.directory);
      await this.io.syncDirectory(dirname(this.directory));
      phase = "candidate-persist";
      await this.io.writeExclusive(candidate, encoded.value);
      await this.io.syncDirectory(join(this.directory, ".private"));
      phase = "candidate-verify";
      const persisted = await this.io.readBounded(candidate, limits.headBytes);
      const decoded = decodeStoreHead(persisted, limits);
      if (!decoded.ok || !Buffer.from(persisted).equals(Buffer.from(encoded.value))) {
        throw new DirectoryIoError("RECOVERY_REQUIRED", "Candidate HEAD verification failed.");
      }
      const storedCheckpoint = await this.io.readBounded(this.checkpointPath(head.value), limits.checkpointHeaderBytes + 1 + limits.checkpointPayloadBytes);
      if (!verifyCheckpoint(storedCheckpoint, head.value, limits).ok) throw new DirectoryIoError("RECOVERY_REQUIRED", "Checkpoint verification failed.");
      phase = "activation";
      activation = "unconfirmed";
      const activated = await this.io.activateFile(candidate, join(this.directory, "HEAD"));
      if (activated !== "atomic") throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Backend did not confirm atomic activation.");
      activation = "atomic-visible";
      phase = "activation-barrier";
      await this.io.syncDirectory(join(this.directory, ".private"));
      await this.io.syncDirectory(this.directory);
      phase = "authority-release";
      await this.io.removeOwnedFile(lock);
      ownsLock = false;
      await this.io.syncDirectory(this.directory);
      result = ok({ head: head.value, activation: "atomic", durability: "confirmed" });
    } catch (error) { result = this.failure(error, phase, activation); }
    if (ownsLock) {
      try { await this.io.removeOwnedFile(lock); }
      catch { return err("RECOVERY_REQUIRED", "Writer authority could not be released.", { phase: "authority-release", activation, durability: "unconfirmed" }); }
    }
    return result;
  }
}
