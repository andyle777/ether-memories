import { createHash } from "node:crypto";
import type { CommittedTip, DurableTransaction, MutationId, TransactionSequenceId, WalOperation } from "../types/persistence.js";
import { parseTransactionSequenceId, sameCommittedTip } from "../utils/durablePersistence.js";
import { err, ok, type Result } from "../utils/result.js";
import { encodeStoreHead, WAL_FORMAT, WAL_VERSION, type PersistedStoreHead } from "./codecs.js";
import { canonicalJson, decodeCanonicalJson, freezeJson, isRecord, walCorruption, type JsonObject } from "./walJson.js";
import { operationType, operationVersion, type ReplayRegistry } from "./walOperations.js";

export const WAL_LIMITS = Object.freeze({
  frameBytes: 1024 * 1024, metadataBytes: 4096, operationListBytes: 768 * 1024,
  operations: 128, payloadBytes: 64 * 1024, aggregatePayloadBytes: 512 * 1024,
  mutationIdBytes: 128, identifierBytes: 64, transactionDigits: 128,
  metadataDepth: 16, jsonNodes: 65536, streamBytes: 8 * 1024 * 1024, frames: 1024
});
export const WAL_PREFIX_BYTES = 24;
const MAGIC = Buffer.from([0xff, 0x45, 0x57, 0x41, 0x4c, 0x0d, 0x0a, 0x1a]);
const END = Buffer.from("EWALDONE", "ascii");
const DOMAIN = Buffer.from("ether.wal/1\0", "ascii");
const TRAILER_BYTES = 32 + END.length;
const bounds = (bytes: number) => ({ bytes, depth: WAL_LIMITS.metadataDepth, nodes: WAL_LIMITS.jsonNodes });
const keys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const identifier = (value: unknown, limit: number = WAL_LIMITS.identifierBytes): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= limit && /^[a-z0-9]/.test(value) && !/[^a-z0-9_-]/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
const sequence = (value: unknown): value is TransactionSequenceId =>
  typeof value === "string" && value.length <= WAL_LIMITS.transactionDigits && parseTransactionSequenceId(value).ok;
const tip = (value: unknown): value is CommittedTip =>
  isRecord(value) && keys(value, ["epochId", "txId", "digest"]) && identifier(value.epochId) && sequence(value.txId) && digest(value.digest);
const successor = (base: TransactionSequenceId, next: TransactionSequenceId) => (BigInt(base) + 1n).toString() === next;

export interface WalTransaction extends DurableTransaction {
  /** Reserved canonical audit location. No destructive operation semantics are defined in v1 yet. */
  readonly audit: null;
}
export type WalTransactionInput = Omit<WalTransaction, "identity"> & {
  readonly identity: Pick<CommittedTip, "epochId" | "txId">;
};
interface Header {
  readonly format: typeof WAL_FORMAT;
  readonly version: typeof WAL_VERSION;
  readonly storeId: string;
  readonly epochId: string;
  readonly txId: TransactionSequenceId;
  readonly base: CommittedTip;
  readonly mutation: DurableTransaction["mutation"];
  readonly operationCount: number;
  readonly audit: null;
}
type FrameRead =
  | { readonly kind: "incomplete" }
  | { readonly kind: "complete"; readonly transaction: WalTransaction; readonly bytes: number };

function validateHeader(value: unknown): Result<Header> {
  if (!isRecord(value)) return walCorruption("WAL metadata must be an object.");
  if (typeof value.format !== "string" || typeof value.version !== "string") return walCorruption("Missing WAL format/version.");
  if (value.format !== WAL_FORMAT || value.version !== WAL_VERSION) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported WAL format/version.");
  if (!keys(value, ["format", "version", "storeId", "epochId", "txId", "base", "mutation", "operationCount", "audit"])
    || !identifier(value.storeId) || !identifier(value.epochId) || !sequence(value.txId) || !tip(value.base)
    || !isRecord(value.mutation) || !keys(value.mutation, ["mutationId", "digest"])
    || !identifier(value.mutation.mutationId, WAL_LIMITS.mutationIdBytes) || !digest(value.mutation.digest)
    || !Number.isSafeInteger(value.operationCount) || (value.operationCount as number) < 1
    || (value.operationCount as number) > WAL_LIMITS.operations || value.audit !== null) return walCorruption("Invalid WAL metadata.");
  if (value.epochId !== value.base.epochId || !successor(value.base.txId, value.txId)) return walCorruption("WAL epoch/sequence does not extend its declared base.");
  return ok({
    format: WAL_FORMAT, version: WAL_VERSION, storeId: value.storeId, epochId: value.epochId,
    txId: value.txId, base: { ...value.base },
    mutation: { mutationId: value.mutation.mutationId as MutationId, digest: value.mutation.digest },
    operationCount: value.operationCount as number, audit: null
  });
}

function validateOperations(value: unknown, count: number, registry: ReplayRegistry): Result<readonly WalOperation[]> {
  if (!Array.isArray(value) || value.length !== count || value.length > WAL_LIMITS.operations) return walCorruption("WAL operation count differs.");
  // Capture the complete list before invoking validators; reject hidden fields/accessors
  // instead of projecting them away or observing caller changes between operations.
  const capturedBytes = canonicalJson(value, bounds(WAL_LIMITS.operationListBytes));
  if (!capturedBytes.ok) return capturedBytes;
  const captured = decodeCanonicalJson(capturedBytes.value, bounds(WAL_LIMITS.operationListBytes));
  if (!captured.ok) return captured;
  let payloadBytes = 0;
  const operations: WalOperation[] = [];
  for (const operation of captured.value as unknown[]) {
    if (!isRecord(operation) || !keys(operation, ["type", "version", "payload"])
      || !operationType(operation.type) || !operationVersion(operation.version) || !isRecord(operation.payload)) return walCorruption("Invalid WAL operation shape.");
    const payload = canonicalJson(operation.payload, bounds(WAL_LIMITS.payloadBytes));
    if (!payload.ok) return payload;
    payloadBytes += payload.value.byteLength;
    if (payloadBytes > WAL_LIMITS.aggregatePayloadBytes) return walCorruption("WAL aggregate payload bound exceeded.");
    const owned = decodeCanonicalJson(payload.value, bounds(WAL_LIMITS.payloadBytes));
    if (!owned.ok) return owned;
    const normalized = Object.freeze({ type: operation.type, version: operation.version, payload: freezeJson(owned.value as JsonObject) });
    const supported = registry.validate(normalized);
    if (!supported.ok) return supported;
    operations.push(normalized);
  }
  return ok(Object.freeze(operations));
}

function prefix(headerBytes: number, operationBytes: number): Buffer {
  const result = Buffer.alloc(WAL_PREFIX_BYTES);
  MAGIC.copy(result);
  result.writeUInt32BE(headerBytes, 8);
  result.writeUInt32BE(operationBytes, 12);
  const total = WAL_PREFIX_BYTES + headerBytes + operationBytes + TRAILER_BYTES;
  result.writeUInt32BE(total, 16);
  result.writeUInt32BE((~total) >>> 0, 20);
  return result;
}
const frameDigest = (prefixBytes: Uint8Array, metadata: Uint8Array, operations: Uint8Array) =>
  createHash("sha256").update(DOMAIN).update(prefixBytes).update(metadata).update(operations).update(END).digest();

function transaction(header: Header, operations: readonly WalOperation[], hash: string): WalTransaction {
  return freezeJson({
    storeId: header.storeId, format: { format: header.format, version: header.version },
    expectedBase: header.base, identity: { epochId: header.epochId, txId: header.txId, digest: hash },
    mutation: header.mutation, operations, audit: null
  } as unknown as JsonObject) as unknown as WalTransaction;
}

/** Encodes bytes in memory only; it neither writes a WAL nor acknowledges durability. */
export function encodeWalFrame(input: WalTransactionInput, registry: ReplayRegistry): Result<{ bytes: Uint8Array; transaction: WalTransaction }> {
  if (!isRecord(input) || !keys(input, ["storeId", "format", "expectedBase", "identity", "mutation", "operations", "audit"])
    || !isRecord(input.identity) || !keys(input.identity, ["epochId", "txId"])
    || !isRecord(input.format) || !keys(input.format, ["format", "version"]) || !Array.isArray(input.operations)) return walCorruption("Invalid WAL transaction input.");
  const header = validateHeader({
    format: input.format.format, version: input.format.version, storeId: input.storeId, epochId: input.identity.epochId,
    txId: input.identity.txId, base: input.expectedBase, mutation: input.mutation, operationCount: input.operations.length, audit: input.audit
  });
  if (!header.ok) return header;
  const validated = validateOperations(input.operations, header.value.operationCount, registry);
  if (!validated.ok) return validated;
  const metadata = canonicalJson(header.value, bounds(WAL_LIMITS.metadataBytes));
  if (!metadata.ok) return metadata;
  const operations = canonicalJson(validated.value, bounds(WAL_LIMITS.operationListBytes));
  if (!operations.ok) return operations;
  const preamble = prefix(metadata.value.byteLength, operations.value.byteLength);
  if (preamble.readUInt32BE(16) > WAL_LIMITS.frameBytes) return walCorruption("WAL frame bound exceeded.");
  const hash = frameDigest(preamble, metadata.value, operations.value);
  return ok({ bytes: Buffer.concat([preamble, metadata.value, operations.value, hash, END]),
    transaction: transaction(header.value, validated.value, hash.toString("hex")) });
}

function partialUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }); return true; }
  catch { return false; }
}

/** Reject excessive outer-array items before JSON.parse allocates the operation array. */
function operationCountWithinBound(bytes: Uint8Array): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let commas = 0;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 91 || byte === 123) depth++;
    else if (byte === 93 || byte === 125) depth--;
    else if (byte === 44 && depth === 1 && ++commas >= WAL_LIMITS.operations) return false;
  }
  return true;
}

function readFrame(bytes: Uint8Array, registry: ReplayRegistry): Result<FrameRead> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!data.subarray(0, Math.min(data.length, MAGIC.length)).equals(MAGIC.subarray(0, Math.min(data.length, MAGIC.length)))) return walCorruption("Invalid WAL magic or trailing garbage.");
  if (data.length >= 12 && (data.readUInt32BE(8) < 1 || data.readUInt32BE(8) > WAL_LIMITS.metadataBytes)) return walCorruption("Invalid declared WAL metadata length.");
  if (data.length >= 16 && (data.readUInt32BE(12) < 2 || data.readUInt32BE(12) > WAL_LIMITS.operationListBytes)) return walCorruption("Invalid declared WAL operation length.");
  if (data.length >= 20 && data.readUInt32BE(16) > WAL_LIMITS.frameBytes) return walCorruption("Invalid declared WAL frame length.");
  if (data.length < WAL_PREFIX_BYTES) return ok({ kind: "incomplete" });
  const headerLength = data.readUInt32BE(8);
  const operationLength = data.readUInt32BE(12);
  const total = WAL_PREFIX_BYTES + headerLength + operationLength + TRAILER_BYTES;
  if (data.readUInt32BE(16) !== total || data.readUInt32BE(20) !== ((~total) >>> 0)) return walCorruption("Inconsistent WAL frame lengths.");
  const headerEnd = WAL_PREFIX_BYTES + headerLength;
  const bodyEnd = headerEnd + operationLength;
  const headerBytes = data.subarray(WAL_PREFIX_BYTES, Math.min(headerEnd, data.length));
  if (data.length < headerEnd) return partialUtf8(headerBytes) ? ok({ kind: "incomplete" }) : walCorruption("Invalid UTF-8 inside an incomplete WAL header.");
  const metadata = decodeCanonicalJson(headerBytes, bounds(WAL_LIMITS.metadataBytes));
  if (!metadata.ok) return metadata;
  const header = validateHeader(metadata.value);
  if (!header.ok) return header;
  const operationBytes = data.subarray(headerEnd, Math.min(bodyEnd, data.length));
  if (!operationCountWithinBound(operationBytes)) return walCorruption("Excessive WAL operation count.");
  if (data.length < bodyEnd) return partialUtf8(operationBytes) ? ok({ kind: "incomplete" }) : walCorruption("Invalid UTF-8 inside an incomplete WAL body.");
  const parsed = decodeCanonicalJson(operationBytes, bounds(WAL_LIMITS.operationListBytes));
  if (!parsed.ok) return parsed;
  const hash = frameDigest(data.subarray(0, WAL_PREFIX_BYTES), headerBytes, operationBytes);
  const trailer = Buffer.concat([hash, END]);
  const availableTrailer = data.subarray(bodyEnd, Math.min(total, data.length));
  if (!availableTrailer.equals(trailer.subarray(0, availableTrailer.length))) return walCorruption("WAL transaction digest or trailer mismatch.");
  const operations = validateOperations(parsed.value, header.value.operationCount, registry);
  if (!operations.ok) return operations;
  if (data.length < total) return ok({ kind: "incomplete" });
  return ok({ kind: "complete", transaction: transaction(header.value, operations.value, hash.toString("hex")), bytes: total });
}

export function decodeWalFrame(bytes: Uint8Array, registry: ReplayRegistry): Result<WalTransaction> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WAL_LIMITS.frameBytes) return walCorruption("WAL frame byte bound exceeded.");
  const frame = readFrame(Buffer.from(bytes), registry);
  if (!frame.ok) return frame;
  if (frame.value.kind === "incomplete") return err("RECOVERY_REQUIRED", "Incomplete physical WAL frame.");
  if (frame.value.bytes !== bytes.byteLength) return walCorruption("Extra bytes after a single WAL frame.");
  return ok(frame.value.transaction);
}

export function checkpointWalAnchor(head: PersistedStoreHead): Result<CommittedTip> {
  const valid = encodeStoreHead(head);
  return valid.ok ? ok(Object.freeze({ ...head.checkpoint.tip })) : valid;
}
export interface WalScan {
  readonly transactions: readonly WalTransaction[];
  readonly tip: CommittedTip;
  readonly duplicates: number;
  readonly completeBytes: number;
  readonly tail: "none" | "incomplete";
  readonly tailBytes: number;
}

/** Bounded, read-only batch scanner; no file repair, mutation dedup index or Core recovery. */
export function scanWal(bytes: Uint8Array, head: PersistedStoreHead, registry: ReplayRegistry): Result<WalScan> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WAL_LIMITS.streamBytes) return walCorruption("WAL scan byte bound exceeded.");
  bytes = Buffer.from(bytes);
  const anchor = checkpointWalAnchor(head);
  if (!anchor.ok) return anchor;
  let current = anchor.value;
  let offset = 0;
  let physicalFrames = 0;
  let duplicates = 0;
  let previous: Uint8Array | undefined;
  const transactions: WalTransaction[] = [];
  while (offset < bytes.byteLength) {
    if (++physicalFrames > WAL_LIMITS.frames) return walCorruption("WAL scan frame-count bound exceeded.");
    const frame = readFrame(bytes.subarray(offset), registry);
    if (!frame.ok) return err(frame.error.code, frame.error.message, { offset });
    if (frame.value.kind === "incomplete") return ok(Object.freeze({
      transactions: Object.freeze(transactions), tip: current, duplicates, completeBytes: offset,
      tail: "incomplete", tailBytes: bytes.byteLength - offset
    }));
    const next = frame.value.transaction;
    const original = bytes.subarray(offset, offset + frame.value.bytes);
    if (next.storeId !== head.storeId || next.identity.epochId !== current.epochId) return walCorruption("WAL history belongs to another store/epoch.");
    if (sameCommittedTip(next.identity, current) && previous && Buffer.from(previous).equals(Buffer.from(original))) duplicates++;
    else {
      if (!sameCommittedTip(next.expectedBase, current) || !successor(current.txId, next.identity.txId)) return walCorruption("WAL fork, reused transaction identity, or broken predecessor chain.");
      transactions.push(next);
      current = next.identity;
      previous = original;
    }
    offset += frame.value.bytes;
  }
  return ok(Object.freeze({ transactions: Object.freeze(transactions), tip: current, duplicates, completeBytes: offset, tail: "none", tailBytes: 0 }));
}
