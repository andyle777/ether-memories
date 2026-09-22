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
declare const mutationId: unique symbol;

/** Canonical unsigned decimal text; never a JS number. Parse at input boundaries. */
export type TransactionSequenceId = string & { readonly [transactionSequenceId]: true };

/** Caller/coordinator-assigned logical command ID, stable before commit and across retries. */
export type MutationId = string & { readonly [mutationId]: true };
export type MutationDigest = string;

/**
 * Store-scoped logical retry identity, persisted with the eventual WAL transaction.
 * digest identifies the canonical versioned mutation, excluding assigned WAL identity
 * and attempt-specific metadata. Reuse the same ID and digest after an ambiguous ack.
 * Same ID + same canonical mutation may resolve to the original committed success;
 * same ID + incompatible mutation must fail closed (PERSISTENCE_CORRUPTION).
 * Canonical encoding and deduplication are future implementation, not supplied here.
 */
export interface MutationIdentity {
  readonly mutationId: MutationId;
  readonly digest: MutationDigest;
}

export interface CommittedTip {
  readonly epochId: EpochId;
  readonly txId: TransactionSequenceId;
  readonly digest: TransactionDigest;
}

/** WAL transaction/replay identity; distinct from pre-commit logical mutation identity. */
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
  readonly mutation: MutationIdentity;
  readonly format: WalFormatIdentifier;
  readonly expectedBase: CommittedTip;
  readonly identity: DurableTransactionIdentity;
  /** Ordered deltas for this logical mutation; not a substitute for its retry identity. */
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
   * Resolve logical retries using the persisted mutation identity: the same ID
   * and canonical mutation may return the original committed identity without
   * another append; incompatible reuse is PERSISTENCE_CORRUPTION. Separately, the same
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
