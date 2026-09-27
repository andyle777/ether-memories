import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import type { CommittedTip, MutationIdentity, WalOperation, WriterAuthorityIdentity } from "../types/persistence.js";
import { parseTransactionSequenceId, sameCommittedTip } from "../utils/durablePersistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { decodeStoreHead, PERSISTENCE_LIMITS, verifyCheckpoint, WAL_FORMAT, WAL_VERSION, type PersistedStoreHead } from "./codecs.js";
import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";
import { encodeWalFrame, WAL_LIMITS, type WalTransaction } from "./wal.js";
import { WalFileScan } from "./walFileScan.js";
import { nodeWalIO, sameWalStamp, type WalFileHandle, type WalFileStamp, type WalIO } from "./walIO.js";
import { canonicalJson, decodeCanonicalJson, freezeJson, type JsonObject } from "./walJson.js";
import type { ReplayRegistry } from "./walOperations.js";

export const MUTATION_CACHE_ENTRIES = 4096;
const DIRECTORY_BYTES = 4096;
export interface CommitRequest {
  readonly expectedBase: CommittedTip;
  readonly mutation: MutationIdentity;
  readonly operations: readonly WalOperation[];
}
export interface CommitReceipt {
  readonly status: "committed" | "already-committed";
  readonly identity: CommittedTip;
  readonly mutation: MutationIdentity;
  readonly durability: "confirmed";
}
interface MutationRecord { readonly identity: CommittedTip; readonly mutation: MutationIdentity; readonly operationsDigest: string }
interface History {
  readonly stamp?: WalFileStamp;
  readonly tip: CommittedTip;
  readonly entries: Map<string, MutationRecord>;
  readonly completeIndex: boolean;
  readonly found?: MutationRecord;
}
interface Cache extends History { readonly headBytes: Buffer; readonly stamp: WalFileStamp }
interface Attempt {
  phase: string;
  outcome: "not-committed" | "reconciliation-required";
  visibility: "none" | "possible" | "complete";
  durability: "unconfirmed" | "confirmed";
}
const jsonBounds = { bytes: WAL_LIMITS.frameBytes, depth: WAL_LIMITS.metadataDepth + 2, nodes: WAL_LIMITS.jsonNodes };
const operationsDigest = (operations: readonly WalOperation[]): string => {
  const bytes = canonicalJson(operations, jsonBounds);
  if (!bytes.ok) throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Invalid captured operations.");
  return createHash("sha256").update(bytes.value).digest("hex");
};
const failure = (error: unknown, state: Attempt): Result<never> => {
  const native = (error as NodeJS.ErrnoException)?.code;
  const code = state.outcome === "reconciliation-required" ? "RECOVERY_REQUIRED"
    : error instanceof DirectoryIoError ? error.code
    : native === "EEXIST" ? "WRITER_BUSY"
    : ["EACCES", "EPERM", "EROFS"].includes(native ?? "") ? "READ_ONLY_LOCKED" : "RECOVERY_REQUIRED";
  return err(code, "WAL operation did not complete its acknowledgment protocol.", { ...state });
};
function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new DirectoryIoError(result.error.code as DirectoryIoError["code"], result.error.message);
  return result.value;
}

/** Internal commit substrate only. Does not implement StoragePort or publish/recover Core state. */
export class FsWalStore {
  private readonly directory: string;
  private cache?: Cache;
  constructor(options: { directory: string; registry: ReplayRegistry }, private readonly directoryIO: DirectoryIO = nodeDirectoryIO,
    private readonly walIO: WalIO = nodeWalIO) {
    this.directory = typeof options.directory === "string" && options.directory.trim()
      && options.directory.length <= DIRECTORY_BYTES ? resolve(options.directory) : "";
    this.registry = options.registry;
  }
  private readonly registry: ReplayRegistry;

  /** Capture and validate before awaiting authority. No txId is supplied by a caller. */
  private prepare(request: CommitRequest): Result<CommitRequest> {
    const bytes = canonicalJson(request, jsonBounds);
    if (!bytes.ok) return bytes;
    const captured = decodeCanonicalJson(bytes.value, jsonBounds);
    if (!captured.ok) return captured;
    const input = captured.value as CommitRequest;
    if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "expectedBase,mutation,operations"
      || !input.expectedBase || typeof input.expectedBase.txId !== "string" || input.expectedBase.txId.length > WAL_LIMITS.transactionDigits
      || !parseTransactionSequenceId(input.expectedBase.txId).ok) return err("PERSISTENCE_CORRUPTION", "Invalid commit preparation input.");
    const next = parseTransactionSequenceId((BigInt(input.expectedBase.txId) + 1n).toString());
    if (!next.ok) return next;
    const checked = encodeWalFrame({ ...input, storeId: "preparation", format: { format: WAL_FORMAT, version: WAL_VERSION },
      identity: { epochId: input.expectedBase.epochId, txId: next.value }, audit: null }, this.registry);
    return checked.ok ? ok(freezeJson(input as unknown as JsonObject) as unknown as CommitRequest) : checked;
  }

  async commit(request: CommitRequest): Promise<Result<CommitReceipt>> {
    const prepared = this.prepare(request);
    if (!prepared.ok) return err(prepared.error.code, prepared.error.message,
      { phase: "prepare", outcome: "not-committed", visibility: "none", durability: "unconfirmed" });
    return this.run(prepared.value) as Promise<Result<CommitReceipt>>;
  }

  /** Acquires authority and crosses barriers; not a read-only observation or Core recovery. */
  async readTip(): Promise<Result<CommittedTip>> { return this.run() as Promise<Result<CommittedTip>>; }

  private async layout(): Promise<void> {
    if (!this.directory || this.directory.startsWith("\\\\") || Buffer.byteLength(this.directory, "utf8") > DIRECTORY_BYTES) {
      throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Explicit bounded local directory required.");
    }
    const root = parse(this.directory).root;
    let path = this.directory;
    const chain: string[] = [];
    while (path !== root) { chain.push(path); path = dirname(path); }
    chain.push(root);
    for (const entry of chain.reverse()) if (await this.directoryIO.kind(entry) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Unsafe store path.");
    for (const name of ["checkpoints", "wal", ".private"]) if (await this.directoryIO.kind(join(this.directory, name)) !== "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "Incomplete store layout.");
  }

  private async history(path: string, file: WalFileHandle, head: PersistedStoreHead, headBytes: Buffer,
    verifyAuthority: () => Promise<void>, mutationId?: string): Promise<History> {
    await verifyAuthority();
    const stamp = await file.stat();
    if (!sameWalStamp(stamp, await this.walIO.stamp(path))) throw new DirectoryIoError("RECOVERY_REQUIRED", "WAL changed before validation.");
    const cached = this.cache;
    // Safe for conforming append-only writers: changed history grows or changes HEAD.
    // Equal stamps do not certify bytes against external rewrites or storage corruption.
    if (cached && cached.headBytes.equals(headBytes) && sameWalStamp(cached.stamp, stamp)
      && (!mutationId || cached.completeIndex || cached.entries.has(mutationId))) {
      return { ...cached, found: mutationId ? cached.entries.get(mutationId) : undefined };
    }
    const scanner = requireValue(await WalFileScan.open(path, file, head, this.registry, this.walIO,
      { mode: "authority-held", verifyAuthority }));
    let cursor = scanner.cursor();
    const entries = new Map<string, MutationRecord>();
    let completeIndex = true;
    let found: MutationRecord | undefined;
    do {
      const batch = requireValue(await scanner.next(cursor));
      cursor = batch.continuation;
      for (const tx of batch.transactions) {
        if (entries.has(tx.mutation.mutationId) || (tx.mutation.mutationId === mutationId && found)) {
          throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Logical mutation appears under multiple transactions.");
        }
        const record = { identity: tx.identity, mutation: tx.mutation, operationsDigest: operationsDigest(tx.operations) };
        if (tx.mutation.mutationId === mutationId) found = record;
        if (entries.size < MUTATION_CACHE_ENTRIES) entries.set(tx.mutation.mutationId, record);
        else completeIndex = false;
      }
    } while (!cursor.ended);
    if (cursor.tail !== "none") throw new DirectoryIoError("RECOVERY_REQUIRED", "Incomplete WAL tail; this tranche never truncates or repairs it.");
    requireValue(await scanner.checkSource());
    return { tip: cursor.tip, entries, completeIndex, found, stamp: scanner.stamp };
  }

  private async run(request?: CommitRequest): Promise<Result<CommitReceipt | CommittedTip>> {
    const state: Attempt = { phase: "preflight", outcome: "not-committed", visibility: "none", durability: "unconfirmed" };
    const lock = join(this.directory, "writer.lock");
    let lockBytes: Buffer | undefined;
    let ownsLock = false;
    let file: WalFileHandle | undefined;
    let result: Result<CommitReceipt | CommittedTip>;
    try {
      await this.layout();
      // Refuse unsupported barriers before creating even an authority artifact.
      await this.directoryIO.syncDirectory(this.directory);
      await this.directoryIO.syncDirectory(join(this.directory, "wal"));
      const headBytes = Buffer.from(await this.directoryIO.readBounded(join(this.directory, "HEAD"), PERSISTENCE_LIMITS.headBytes));
      const head = requireValue(decodeStoreHead(headBytes));
      const authority: WriterAuthorityIdentity = { storeId: head.storeId, authorityId: randomUUID() };
      lockBytes = Buffer.from(JSON.stringify(authority));
      state.phase = "writer-acquire";
      await this.directoryIO.writeExclusive(lock, lockBytes);
      ownsLock = true;
      await this.directoryIO.syncDirectory(this.directory);
      const verifyAuthority = async () => {
        if (!ownsLock) throw new DirectoryIoError("RECOVERY_REQUIRED", "Writer authority has ended.");
        await this.layout();
        if (!Buffer.from(await this.directoryIO.readBounded(lock, 1024)).equals(lockBytes!)
          || !Buffer.from(await this.directoryIO.readBounded(join(this.directory, "HEAD"), PERSISTENCE_LIMITS.headBytes)).equals(headBytes)) {
          throw new DirectoryIoError("RECOVERY_REQUIRED", "Writer authority or HEAD changed.");
        }
      };
      await verifyAuthority();
      state.phase = "checkpoint-verify";
      const checkpoint = await this.directoryIO.readBounded(join(this.directory, "checkpoints", `checkpoint-${head.checkpoint.checkpointId}.bin`),
        PERSISTENCE_LIMITS.checkpointHeaderBytes + 1 + PERSISTENCE_LIMITS.checkpointPayloadBytes);
      requireValue(verifyCheckpoint(checkpoint, head));
      // The checkpoint digest binds store/epoch/checkpoint; no filename ordering or extra authority ledger.
      const path = join(this.directory, "wal", `wal-${head.checkpoint.digest}.bin`);
      state.phase = "wal-open";
      const kind = await this.directoryIO.kind(path);
      if (kind === "directory") throw new DirectoryIoError("RECOVERY_REQUIRED", "WAL path is not a regular file.");
      if (kind === "file") file = await this.walIO.open(path, false);
      state.phase = "history-validate";
      const history: History = file ? await this.history(path, file, head, headBytes, verifyAuthority, request?.mutation.mutationId)
        : { tip: head.checkpoint.tip, entries: new Map(), completeIndex: true };
      const before = history.stamp;
      let validatedStamp = before;
      let receipt: CommitReceipt | undefined;
      let appended: WalTransaction | undefined;
      if (request) {
        const previous = history.found;
        if (previous) {
          state.outcome = "reconciliation-required";
          state.visibility = "complete";
          if (previous.mutation.digest !== request.mutation.digest || previous.operationsDigest !== operationsDigest(request.operations)) {
            throw new DirectoryIoError("PERSISTENCE_CORRUPTION", "Incompatible mutation identity reuse.");
          }
          receipt = { status: "already-committed", identity: previous.identity, mutation: previous.mutation, durability: "confirmed" };
        } else {
          state.phase = "exact-base";
          if (!sameCommittedTip(request.expectedBase, history.tip)) throw new DirectoryIoError("STALE_TRANSACTION_BASE", "Expected base differs; automatic rebase is forbidden.");
          // Assign only from the validated tip while authority is held.
          const next = requireValue(parseTransactionSequenceId((BigInt(history.tip.txId) + 1n).toString()));
          const prepared = requireValue(encodeWalFrame({ ...request, expectedBase: history.tip, storeId: head.storeId,
            format: head.walFormat, identity: { epochId: history.tip.epochId, txId: next }, audit: null }, this.registry));
          await verifyAuthority();
          if (file && (!sameWalStamp(before!, await file.stat()) || !sameWalStamp(before!, await this.walIO.stamp(path)))) {
            throw new DirectoryIoError("RECOVERY_REQUIRED", "WAL changed between scan and append.");
          }
          state.phase = "wal-create";
          if (!file) file = await this.walIO.open(path, true);
          const offset = before?.size ?? 0;
          if (!Number.isSafeInteger(offset + prepared.bytes.byteLength)) throw new DirectoryIoError("RECOVERY_REQUIRED", "Physical WAL offset exhausted.");
          state.phase = "write";
          state.outcome = "reconciliation-required";
          state.visibility = "possible";
          let written = 0;
          while (written < prepared.bytes.byteLength) {
            const count = await file.write(prepared.bytes.subarray(written), offset + written);
            if (!Number.isSafeInteger(count) || count <= 0 || count > prepared.bytes.byteLength - written) throw new Error("Invalid partial-write result.");
            written += count;
          }
          state.visibility = "complete";
          validatedStamp = await file.stat();
          if (validatedStamp.size !== offset + prepared.bytes.byteLength) throw new Error("Unexpected WAL length after append.");
          appended = prepared.transaction;
          receipt = { status: "committed", identity: appended.identity, mutation: appended.mutation, durability: "confirmed" };
        }
      }
      // Visible complete bytes (including a lost-ack retry) must cross fresh barriers.
      state.phase = "wal-sync";
      if (file) await file.sync();
      state.phase = "wal-directory-sync";
      await this.directoryIO.syncDirectory(join(this.directory, "wal"));
      state.durability = "confirmed";
      await verifyAuthority();
      const after = file ? await file.stat() : undefined;
      if (file && !sameWalStamp(after!, await this.walIO.stamp(path))) throw new Error("WAL path changed after sync.");
      if (file && validatedStamp && !sameWalStamp(validatedStamp, after!)) throw new Error("WAL changed during durability barriers.");
      state.phase = "wal-close";
      if (file) { await file.close(); file = undefined; }
      if (after) {
        if (appended && history.entries.size < MUTATION_CACHE_ENTRIES) history.entries.set(appended.mutation.mutationId,
          { identity: appended.identity, mutation: appended.mutation, operationsDigest: operationsDigest(appended.operations) });
        this.cache = { ...history, tip: appended?.identity ?? history.tip, headBytes, stamp: after,
          completeIndex: history.completeIndex && (!appended || history.entries.has(appended.mutation.mutationId)) };
      }
      result = ok(receipt ? Object.freeze(receipt) : history.tip);
    } catch (error) {
      this.cache = undefined;
      result = failure(error, state);
      // Logical conflicts remain corruption even if the original mutation is committed.
      if (error instanceof DirectoryIoError && error.code === "PERSISTENCE_CORRUPTION") result = err(error.code, error.message, { ...state });
    }
    if (file) {
      try { await file.close(); }
      catch { this.cache = undefined; result = err("RECOVERY_REQUIRED", "WAL close failed.", { ...state, phase: "wal-close" }); }
    }
    if (ownsLock) {
      ownsLock = false;
      try {
        state.phase = "writer-release";
        if (!Buffer.from(await this.directoryIO.readBounded(lock, 1024)).equals(lockBytes!)) throw new Error("Authority changed");
        await this.directoryIO.removeOwnedFile(lock);
        await this.directoryIO.syncDirectory(this.directory);
      } catch {
        this.cache = undefined;
        result = err("RECOVERY_REQUIRED", "Writer release/barrier failed; reconcile before retry.", { ...state });
      }
    }
    return result;
  }
}
