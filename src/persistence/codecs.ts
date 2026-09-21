import { createHash } from "node:crypto";
import type { CheckpointIdentity, CommittedTip, StoreHead } from "../types/persistence.js";
import { parseTransactionSequenceId, sameCommittedTip } from "../utils/durablePersistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { STORE_SCHEMA_VERSION } from "../version.js";

export const HEAD_FORMAT = "ether.store_head" as const;
export const CHECKPOINT_FORMAT = "ether.checkpoint" as const;
export const PERSISTENCE_VERSION = "1" as const;
export const WAL_FORMAT = "ether.wal" as const;
export const DIGEST_ALGORITHM = "sha256" as const;

/** Wire-only compatibility metadata; no changes to StoreHead or EtherSnapshot. */
export interface PersistedStoreHead extends StoreHead {
  readonly format: typeof HEAD_FORMAT;
  readonly version: typeof PERSISTENCE_VERSION;
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly digestAlgorithm: typeof DIGEST_ALGORITHM;
}

export const PERSISTENCE_LIMITS = Object.freeze({
  headBytes: 16 * 1024,
  checkpointHeaderBytes: 4 * 1024,
  checkpointPayloadBytes: 8 * 1024 * 1024,
  identifierBytes: 64,
  transactionDigits: 128,
  metadataDepth: 8
});
export type PersistenceLimits = { readonly [K in keyof typeof PERSISTENCE_LIMITS]: number };
export type PersistenceLimitOptions = Partial<PersistenceLimits>;

export function persistenceLimits(options: PersistenceLimitOptions = {}): Result<PersistenceLimits> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return err("INVALID_INPUT", "Persistence limits must be an object.");
  }
  const limits: { -readonly [K in keyof PersistenceLimits]: number } = { ...PERSISTENCE_LIMITS };
  for (const key of Object.keys(options) as (keyof PersistenceLimits)[]) {
    const value = options[key];
    if (!Object.hasOwn(PERSISTENCE_LIMITS, key) || !Number.isSafeInteger(value) || value! < 1 || value! > PERSISTENCE_LIMITS[key]) {
      return err("INVALID_INPUT", "Persistence limits must be positive integers within the format bounds.");
    }
    limits[key] = value!;
  }
  return ok(limits);
}

const corrupt = (message: string) => err("PERSISTENCE_CORRUPTION", message);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const identifier = (value: unknown, limits: PersistenceLimits): value is string =>
  typeof value === "string" && value.length <= limits.identifierBytes && /^[a-z0-9]/.test(value) && !/[^a-z0-9_-]/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function tip(value: unknown, limits: PersistenceLimits): Result<CommittedTip> {
  if (!record(value) || !keys(value, ["epochId", "txId", "digest"]) || !identifier(value.epochId, limits)
    || !digest(value.digest) || typeof value.txId !== "string" || value.txId.length > limits.transactionDigits) {
    return corrupt("Invalid committed tip.");
  }
  const txId = parseTransactionSequenceId(value.txId);
  if (!txId.ok) return corrupt("Invalid exact transaction ID.");
  return ok({ epochId: value.epochId, txId: txId.value, digest: value.digest });
}

function parseMetadata(bytes: Uint8Array, maxBytes: number, limits: PersistenceLimits): Result<unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return corrupt("Persistence metadata exceeds its byte bounds.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    // Bound nesting before JSON.parse, including adversarial arrays in unknown fields.
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        if (++depth > limits.metadataDepth) return corrupt("Persistence metadata exceeds its nesting bound.");
      } else if (char === "}" || char === "]") depth--;
    }
    return ok(JSON.parse(text));
  } catch {
    return corrupt("Invalid UTF-8 JSON persistence metadata.");
  }
}

function compatibility(value: Record<string, unknown>, format: string): Result<void> {
  if (typeof value.format !== "string" || typeof value.version !== "string") return corrupt("Missing format/version.");
  if (value.format !== format || value.version !== PERSISTENCE_VERSION) {
    return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported persistence format/version.");
  }
  if (typeof value.schemaVersion !== "string" || typeof value.digestAlgorithm !== "string") return corrupt("Missing compatibility metadata.");
  if (value.schemaVersion !== STORE_SCHEMA_VERSION || value.digestAlgorithm !== DIGEST_ALGORITHM) {
    return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported schema or digest algorithm.");
  }
  return ok(undefined);
}

function validateHead(value: unknown, limits: PersistenceLimits): Result<PersistedStoreHead> {
  if (!record(value)) return corrupt("HEAD must be an object.");
  const supported = compatibility(value, HEAD_FORMAT);
  if (!supported.ok) return supported;
  if (!keys(value, ["format", "version", "storeId", "epochId", "schemaVersion", "digestAlgorithm", "checkpoint", "walFormat"])
    || !identifier(value.storeId, limits) || !identifier(value.epochId, limits)
    || !record(value.checkpoint) || !keys(value.checkpoint, ["checkpointId", "digest", "tip"])
    || !identifier(value.checkpoint.checkpointId, limits) || !digest(value.checkpoint.digest)
    || !record(value.walFormat) || !keys(value.walFormat, ["format", "version"])) return corrupt("Invalid HEAD structure.");
  if (typeof value.walFormat.format !== "string" || typeof value.walFormat.version !== "string") return corrupt("Invalid WAL identifier.");
  if (value.walFormat.format !== WAL_FORMAT || value.walFormat.version !== PERSISTENCE_VERSION) {
    return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported WAL format/version.");
  }
  const checkpointTip = tip(value.checkpoint.tip, limits);
  if (!checkpointTip.ok) return checkpointTip;
  if (checkpointTip.value.epochId !== value.epochId) return corrupt("HEAD and checkpoint epochs differ.");
  // Fixed field projection defines the wire order, independently of caller insertion order.
  return ok({ format: HEAD_FORMAT, version: PERSISTENCE_VERSION, storeId: value.storeId, epochId: value.epochId,
    schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM,
    checkpoint: { checkpointId: value.checkpoint.checkpointId, digest: value.checkpoint.digest, tip: checkpointTip.value },
    walFormat: { format: WAL_FORMAT, version: PERSISTENCE_VERSION } });
}

export function encodeStoreHead(head: PersistedStoreHead, options: PersistenceLimitOptions = {}): Result<Uint8Array> {
  const limits = persistenceLimits(options);
  if (!limits.ok) return limits;
  const validated = validateHead(head, limits.value);
  if (!validated.ok) return validated;
  const bytes = Buffer.from(JSON.stringify(validated.value), "utf8");
  const bounded = parseMetadata(bytes, limits.value.headBytes, limits.value);
  return bounded.ok ? ok(bytes) : bounded;
}

export function decodeStoreHead(bytes: Uint8Array, options: PersistenceLimitOptions = {}): Result<PersistedStoreHead> {
  const limits = persistenceLimits(options);
  if (!limits.ok) return limits;
  const parsed = parseMetadata(bytes, limits.value.headBytes, limits.value);
  if (!parsed.ok) return parsed;
  const head = validateHead(parsed.value, limits.value);
  if (!head.ok) return head;
  // Canonical bytes reject duplicate keys, whitespace variants and escaped aliases, not repair them.
  if (!Buffer.from(bytes).equals(Buffer.from(JSON.stringify(head.value), "utf8"))) return corrupt("Noncanonical HEAD encoding.");
  return head;
}

export interface CheckpointMetadata {
  readonly storeId: string;
  readonly checkpointId: string;
  readonly tip: CommittedTip;
}

function checkpointHeader(value: unknown, limits: PersistenceLimits) {
  if (!record(value)) return corrupt("Checkpoint header must be an object.");
  const supported = compatibility(value, CHECKPOINT_FORMAT);
  if (!supported.ok) return supported;
  if (!keys(value, ["format", "version", "storeId", "checkpointId", "schemaVersion", "digestAlgorithm", "tip", "payloadBytes"])
    || !identifier(value.storeId, limits) || !identifier(value.checkpointId, limits)
    || typeof value.payloadBytes !== "number" || !Number.isSafeInteger(value.payloadBytes)
    || value.payloadBytes < 1 || value.payloadBytes > limits.checkpointPayloadBytes) return corrupt("Invalid checkpoint header.");
  const includedTip = tip(value.tip, limits);
  if (!includedTip.ok) return includedTip;
  return ok({ format: CHECKPOINT_FORMAT, version: PERSISTENCE_VERSION, storeId: value.storeId, checkpointId: value.checkpointId,
    schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM, tip: includedTip.value, payloadBytes: value.payloadBytes });
}

/** Payload bytes are opaque here: state validation/recovery is a later tranche. */
export function encodeCheckpoint(metadata: CheckpointMetadata, payload: Uint8Array, options: PersistenceLimitOptions = {}):
Result<{ bytes: Uint8Array; identity: CheckpointIdentity }> {
  const limits = persistenceLimits(options);
  if (!limits.ok) return limits;
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > limits.value.checkpointPayloadBytes) {
    return corrupt("Checkpoint payload exceeds its byte bounds.");
  }
  const header = checkpointHeader({ format: CHECKPOINT_FORMAT, version: PERSISTENCE_VERSION, storeId: metadata.storeId,
    checkpointId: metadata.checkpointId, schemaVersion: STORE_SCHEMA_VERSION, digestAlgorithm: DIGEST_ALGORITHM,
    tip: metadata.tip, payloadBytes: payload.byteLength }, limits.value);
  if (!header.ok) return header;
  const headerBytes = Buffer.from(JSON.stringify(header.value), "utf8");
  const bounded = parseMetadata(headerBytes, limits.value.checkpointHeaderBytes, limits.value);
  if (!bounded.ok) return bounded;
  // Identity hashes this one encoding: canonical header, one LF, then the original payload bytes.
  const bytes = Buffer.concat([headerBytes, Buffer.from([10]), payload]);
  return ok({ bytes, identity: { checkpointId: header.value.checkpointId, digest: hash(bytes), tip: header.value.tip } });
}

export function verifyCheckpoint(bytes: Uint8Array, head: PersistedStoreHead, options: PersistenceLimitOptions = {}): Result<void> {
  const limits = persistenceLimits(options);
  if (!limits.ok) return limits;
  const validHead = validateHead(head, limits.value);
  if (!validHead.ok) return validHead;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.value.checkpointHeaderBytes + 1 + limits.value.checkpointPayloadBytes) {
    return corrupt("Checkpoint exceeds its byte bound.");
  }
  const separator = bytes.subarray(0, limits.value.checkpointHeaderBytes + 1).indexOf(10);
  if (separator < 0) return corrupt("Missing bounded checkpoint header.");
  const headerBytes = bytes.subarray(0, separator);
  const parsed = parseMetadata(headerBytes, limits.value.checkpointHeaderBytes, limits.value);
  if (!parsed.ok) return parsed;
  const header = checkpointHeader(parsed.value, limits.value);
  if (!header.ok) return header;
  if (!Buffer.from(headerBytes).equals(Buffer.from(JSON.stringify(header.value), "utf8"))) return corrupt("Noncanonical checkpoint header.");
  if (bytes.byteLength - separator - 1 !== header.value.payloadBytes) return corrupt("Checkpoint payload length differs.");
  if (header.value.storeId !== head.storeId || header.value.checkpointId !== head.checkpoint.checkpointId
    || !sameCommittedTip(header.value.tip, head.checkpoint.tip)) return corrupt("Checkpoint identity differs from HEAD.");
  if (hash(bytes) !== head.checkpoint.digest) return corrupt("Checkpoint byte digest differs from HEAD.");
  return ok(undefined);
}
