import { err, ok, type Result } from "../utils/result.js";
import type { PersistedStoreHead } from "./codecs.js";
import { WAL_LIMITS } from "./wal.js";
import { sameWalStamp, type WalFileHandle, type WalFileStamp, type WalIO } from "./walIO.js";
import type { ReplayRegistry } from "./walOperations.js";
import { WalStreamScanner, type WalBatch, type WalContinuation } from "./walStream.js";

/** Internal trusted source contract, not a caller assertion of physical immutability. */
export type WalScanSource = { readonly mode: "advisory" }
  | { readonly mode: "authority-held"; readonly verifyAuthority: () => Promise<void> };

/** Authority excludes conforming writers. Stamps only detect some out-of-band changes. */
export class WalFileScan {
  private failed = false;
  private busy = false;
  private constructor(private readonly scanner: WalStreamScanner, private readonly handle: WalFileHandle,
    private readonly path: string, readonly stamp: WalFileStamp, private readonly io: WalIO, private readonly chunkBytes: number,
    private readonly source: WalScanSource) {}

  get mode(): WalScanSource["mode"] { return this.source.mode; }

  static async open(path: string, handle: WalFileHandle, head: PersistedStoreHead, registry: ReplayRegistry,
    io: WalIO, source: WalScanSource, chunkBytes = 64 * 1024): Promise<Result<WalFileScan>> {
    if (!source || (source.mode !== "advisory" && (source.mode !== "authority-held" || typeof source.verifyAuthority !== "function"))) {
      return err("RECOVERY_REQUIRED", "Explicit advisory source or held authority verifier required.");
    }
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > WAL_LIMITS.streamBytes) return err("INVALID_INPUT", "Invalid WAL scan chunk bound.");
    const scanner = WalStreamScanner.create(head, registry);
    if (!scanner.ok) return scanner;
    try {
      const captured = Object.freeze({ ...source });
      if (captured.mode === "authority-held") await captured.verifyAuthority();
      const scan = new WalFileScan(scanner.value, handle, path, await handle.stat(), io, chunkBytes, captured);
      return (await scan.checkSource()).ok ? ok(scan) : err("RECOVERY_REQUIRED", "WAL source check failed during scan open.");
    } catch { return err("RECOVERY_REQUIRED", "WAL scan could not establish file identity."); }
  }

  cursor(): WalContinuation { return this.scanner.cursor(); }

  /** Checks authority and observable stamps, not the current contents of historical bytes. */
  async checkSource(): Promise<Result<void>> {
    try {
      if (this.source.mode === "authority-held") await this.source.verifyAuthority();
      if (this.failed || !sameWalStamp(this.stamp, await this.handle.stat())
        || !sameWalStamp(this.stamp, await this.io.stamp(this.path))) throw new Error("changed");
      return ok(undefined);
    } catch { this.failed = true; return err("RECOVERY_REQUIRED", "WAL authority or observed file stamps changed during validation."); }
  }

  async next(cursor: WalContinuation): Promise<Result<WalBatch>> {
    if (this.busy || this.failed || cursor !== this.scanner.cursor() || cursor.ended) return err("RECOVERY_REQUIRED", "Invalid or concurrent file continuation.");
    this.busy = true;
    try {
      const before = await this.checkSource();
      if (!before.ok) return before;
      const bytes = Buffer.alloc(Math.min(this.chunkBytes, this.stamp.size - cursor.offset));
      let read = 0;
      while (read < bytes.length) {
        const count = await this.handle.read(bytes.subarray(read), cursor.offset + read);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - read) throw new Error("short read");
        read += count;
      }
      const after = await this.checkSource();
      if (!after.ok) return after;
      const batch = this.scanner.next(cursor, bytes, cursor.offset + read === this.stamp.size);
      if (!batch.ok) this.failed = true;
      return batch;
    } catch { this.failed = true; return err("RECOVERY_REQUIRED", "WAL scan failed; continuation invalidated."); }
    finally { this.busy = false; }
  }
}
