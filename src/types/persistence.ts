import type { Result } from "../utils/result.js";

export type StoreId = string;
export type EpochId = string;
export type TransactionDigest = string;
export type CheckpointId = string;
export type CheckpointDigest = string;
export type WriterAuthorityId = string;
export type WalFormatId = string;
export type WalFormatVersion = string;
export type WalOperationType = string;
export type WalOperationVersion = string;

declare const transactionSequenceId: unique symbol;

/** Canonical unsigned decimal text; never a JS number. Parse at input boundaries. */
export type TransactionSequenceId = string & { readonly [transactionSequenceId]: true };

export interface CommittedTip {
  readonly epochId: EpochId;
  readonly txId: TransactionSequenceId;
  readonly digest: TransactionDigest;
}

/** Retries are identified by the entire tuple, not txId alone. */
export type DurableTransactionIdentity = CommittedTip;

export interface CheckpointIdentity {
  readonly checkpointId: CheckpointId;
  /** Integrity of the persisted checkpoint, separate from the WAL chain digest. */
  readonly digest: CheckpointDigest;
  /** Coherent committed boundary represented by the checkpoint. */
  readonly tip: CommittedTip;
}

export interface WalFormatIdentifier {
  readonly format: WalFormatId;
  readonly version: WalFormatVersion;
}

/** Authority metadata is separate from EtherSnapshot. HEAD is not the WAL tip ledger. */
export interface StoreHead {
  readonly version: string;
  readonly storeId: StoreId;
  readonly epochId: EpochId;
  /** Must belong to epochId; may trail the current tip if WAL continuity is intact. */
  readonly checkpoint: CheckpointIdentity;
  readonly walFormat: WalFormatIdentifier;
}

export interface WalOperationIdentifier {
  readonly type: WalOperationType;
  /** Historical operation versions retain immutable reducer semantics. */
  readonly version: WalOperationVersion;
}

export interface WalOperation extends WalOperationIdentifier {
  /** Validated deterministic delta data, not a store snapshot or a live callback. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DurableTransaction {
  readonly storeId: StoreId;
  readonly format: WalFormatIdentifier;
  readonly expectedBase: CommittedTip;
  readonly identity: DurableTransactionIdentity;
  /** Ordered deltas; whole-transaction identity is the retry deduplication unit. */
  readonly operations: readonly WalOperation[];
}

/** Identifies adapter-held authority; possession of this value does not grant a lock. */
export interface WriterAuthorityIdentity {
  readonly storeId: StoreId;
  readonly authorityId: WriterAuthorityId;
}

export type PersistenceErrorCode =
  | "STALE_TRANSACTION_BASE"
  | "PERSISTENCE_CORRUPTION"
  | "WRITER_BUSY"
  | "READ_ONLY_LOCKED"
  | "RECOVERY_REQUIRED"
  | "UNSUPPORTED_PERSISTENCE_FORMAT"
  | "DURABILITY_UNAVAILABLE";

/** Operations are valid only during the enclosing withWriter callback. */
export interface DurableWriterOperations {
  readonly authority: WriterAuthorityIdentity;
  readHead(): Promise<Result<StoreHead>>;
  /** Returns a validated committed tip, or RECOVERY_REQUIRED until recovery completes. */
  readTip(): Promise<Result<CommittedTip>>;
  /**
   * Under this same writer authority, validate the store, epoch, exact base and
   * operation versions, then append the complete transaction and cross the
   * required durability barrier before returning success. Never auto-rebase.
   * An identical committed retry succeeds without appending again; the same
   * epoch/txId with another digest is PERSISTENCE_CORRUPTION. A stale new
   * transaction returns STALE_TRANSACTION_BASE. An uncertain durable outcome
   * requires recovery before another commit. This does not publish live state.
   */
  appendTransaction(transaction: DurableTransaction): Promise<Result<DurableTransactionIdentity>>;
}

/**
 * Optional contract for a future durable path; legacy Core mutators do not use it.
 * Presence alone is not proof of recovery or durability: operation results govern.
 */
export interface DurableStorageOperations {
  /**
   * Acquire exclusive writer authority, scope it to the callback, and release it
   * even on failure. Ambiguous ownership fails closed; never break a stale lock
   * automatically. WRITER_BUSY and READ_ONLY_LOCKED are distinct from corruption.
   * Keep long-running analysis outside this callback. Retained writer operations
   * must fail after it ends. Unsupported formats/versions fail before mutation.
   */
  withWriter<T>(operation: (writer: DurableWriterOperations) => Promise<Result<T>>): Promise<Result<T>>;
}
