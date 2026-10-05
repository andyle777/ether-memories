import type { CommittedTip } from "../types/persistence.js";
import { sameCommittedTip } from "../utils/durablePersistence.js";
import { err, ok, type Result } from "../utils/result.js";
import type { PersistedStoreHead } from "./codecs.js";
import { checkpointWalAnchor, decodeWalFrame, WAL_LIMITS, WAL_PREFIX_BYTES, type WalTransaction } from "./wal.js";
import type { ReplayRegistry } from "./walOperations.js";

export interface WalContinuation {
  readonly offset: number;
  readonly completeBytes: number;
  readonly tip: CommittedTip;
  readonly tail: "none" | "pending" | "incomplete";
  readonly ended: boolean;
}
export interface WalBatch {
  readonly continuation: WalContinuation;
  readonly consumed: number;
  readonly transactions: readonly WalTransaction[];
  readonly duplicates: number;
}

/** Single-use, instance-bound tokens. A copied, altered, stale or foreign token grants no authority. */
export class WalStreamScanner {
  private current: WalContinuation;
  private pending = Buffer.alloc(WAL_LIMITS.frameBytes);
  private used = 0;
  private target = WAL_PREFIX_BYTES;
  private previous: Buffer | undefined;
  private failed = false;

  private constructor(private readonly storeId: string, anchor: CommittedTip, private readonly registry: ReplayRegistry) {
    this.current = Object.freeze({ offset: 0, completeBytes: 0, tip: anchor, tail: "none", ended: false });
  }

  static create(head: PersistedStoreHead, registry: ReplayRegistry): Result<WalStreamScanner> {
    const anchor = checkpointWalAnchor(head);
    return anchor.ok ? ok(new WalStreamScanner(head.storeId, anchor.value, registry)) : anchor;
  }

  cursor(): WalContinuation { return this.current; }

  /** Caller retains unconsumed input when the physical-frame budget is exhausted. */
  next(cursor: WalContinuation, input: Uint8Array, final = false): Result<WalBatch> {
    if (this.failed || cursor !== this.current || cursor.ended) return err("RECOVERY_REQUIRED", "Invalid or expired WAL continuation.");
    if (!(input instanceof Uint8Array) || input.byteLength > WAL_LIMITS.streamBytes
      || !Number.isSafeInteger(cursor.offset + input.byteLength)) return err("PERSISTENCE_CORRUPTION", "WAL processing/offset bound exceeded.");
    const bytes = Buffer.from(input);
    let consumed = 0;
    let physical = 0;
    let duplicates = 0;
    let tip = cursor.tip;
    let completeBytes = cursor.completeBytes;
    const transactions: WalTransaction[] = [];
    const reject = (result: Result<never>): Result<WalBatch> => { this.failed = true; return result; };
    while (consumed < bytes.length && physical < WAL_LIMITS.frames) {
      const take = Math.min(this.target - this.used, bytes.length - consumed);
      bytes.copy(this.pending, this.used, consumed, consumed + take);
      this.used += take;
      consumed += take;
      if (this.used < this.target) break;
      if (this.target === WAL_PREFIX_BYTES) {
        const prefix = decodeWalFrame(this.pending.subarray(0, this.used), this.registry);
        if (prefix.ok || prefix.error.code !== "RECOVERY_REQUIRED") return reject(prefix.ok
          ? err("PERSISTENCE_CORRUPTION", "Invalid WAL prefix.") : prefix);
        this.target = this.pending.readUInt32BE(16);
        continue;
      }
      const original = this.pending.subarray(0, this.used);
      const decoded = decodeWalFrame(original, this.registry);
      if (!decoded.ok) return reject(decoded);
      const tx = decoded.value;
      if (tx.storeId !== this.storeId || tx.identity.epochId !== tip.epochId) return reject(err("PERSISTENCE_CORRUPTION", "Foreign WAL store/epoch."));
      if (sameCommittedTip(tx.identity, tip) && this.previous?.equals(original)) duplicates++;
      else {
        if (!sameCommittedTip(tx.expectedBase, tip)) return reject(err("PERSISTENCE_CORRUPTION", "WAL fork or broken predecessor chain."));
        transactions.push(tx);
        tip = tx.identity;
        this.previous = Buffer.from(original);
      }
      physical++;
      completeBytes = cursor.offset + consumed;
      this.used = 0;
      this.target = WAL_PREFIX_BYTES;
    }
    // Validate all available partial bytes too; corruption is never downgraded to EOF.
    if (this.used) {
      const partial = decodeWalFrame(this.pending.subarray(0, this.used), this.registry);
      if (partial.ok || partial.error.code !== "RECOVERY_REQUIRED") return reject(partial.ok
        ? err("PERSISTENCE_CORRUPTION", "Invalid partial WAL frame.") : partial);
    }
    const ended = final && consumed === bytes.length;
    this.current = Object.freeze({ offset: cursor.offset + consumed, completeBytes, tip,
      tail: this.used ? (ended ? "incomplete" : "pending") : "none", ended });
    return ok(Object.freeze({ continuation: this.current, consumed, transactions: Object.freeze(transactions), duplicates }));
  }
}
