import type { EtherSnapshot } from "../types/index.js";
import { prepareSnapshot } from "../core/snapshotPreparation.js";
import { ok, err, type Result } from "../utils/result.js";
import { STORE_SCHEMA_VERSION } from "../version.js";
import { encodeEtherData, decodeEtherData, type EtherData } from "./etherData.js";
import { encodeCheckpoint, type CheckpointMetadata } from "./codecs.js";

export const SNAPSHOT_PAYLOAD_PROFILE = "ether.snapshot.payload.v1" as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Only schema-owned Dates/absent optional fields are projected. User metadata is
// already persisted JSON data; unsupported live JS values are not silently lost.
function fields(value: object, dates: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, dates.includes(k) && v instanceof Date ? v.toISOString() : v]));
}

/**
 * Check if provenance matches the default that would be computed from source.
 * During hydration: provenance: n.provenance ?? { kind: n.source === "diary" ? "diary_extract" : n.source === "imported" ? "imported" : "user_explicit" }
 */
function isDefaultProvenance(provenance: unknown, source: unknown): boolean {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return false;
  const prov = provenance as Record<string, unknown>;
  if (!prov.kind || typeof prov.kind !== "string") return false;
  
  // Check if this matches the default computed from source
  const expectedKind = source === "diary" ? "diary_extract" : source === "imported" ? "imported" : "user_explicit";
  if (prov.kind !== expectedKind) return false;
  
  // Only omit provenance if it has exactly the fields that would be added by default
  // The default provenance from hydration has only the kind field
  if (Object.keys(prov).length === 1 && prov.kind === expectedKind) return true;
  
  return false;
}

/**
 * Note-specific canonical projection: omit default-only fields that are reconstructively
 * determined during hydration. This ensures historical checkpoints without these fields
 * produce the same canonical representation.
 */
function canonicalNoteFields(note: object, dates: readonly string[]): Record<string, unknown> {
  const raw = fields(note, dates);
  const result: Record<string, unknown> = {};
  const source = raw.source as string | undefined;
  
  for (const [k, v] of Object.entries(raw)) {
    // Omit defaults that would be added by hydrateNote
    if (k === "tags" && Array.isArray(v) && v.length === 0) continue;
    if (k === "metadata" && typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (k === "status" && v === "active") continue;
    if (k === "importance" && v === 0.5) continue;
    if (k === "confidence" && v === 0.75) continue;
    if (k === "pinned" && v === false) continue;
    if (k === "provenance" && isDefaultProvenance(v, source)) continue;
    result[k] = v;
  }
  return result;
}

/**
 * Diary entry-specific canonical projection
 */
function canonicalDiaryFields(diary: object, dates: readonly string[]): Record<string, unknown> {
  const raw = fields(diary, dates);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    // Omit defaults that would be added by hydrateDiary
    if (k === "tags" && Array.isArray(v) && v.length === 0) continue;
    if (k === "metadata" && typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    result[k] = v;
  }
  return result;
}
export function persistedSnapshot(snapshot: EtherSnapshot): unknown {
  // For identity, omit optional fields with default values
  const identityFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields(snapshot.identity, ["createdAt", "lastActive"]))) {
    // displayName is historical data, not an elidable default: the frozen Core
    // preserves an explicit empty string, so only null normalizes to absent.
    // displayName === undefined never appears here (fields drops undefined).
    if (k === "displayName" && (v === undefined || v === null)) continue;
    // preferences defaults to {} in hydration; an explicit {} is equivalent.
    if (k === "preferences" && typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    identityFields[k] = v;
  }
  
  return { schemaVersion: snapshot.schemaVersion,
    identity: identityFields,
    memoryNotes: snapshot.memoryNotes.map(n => canonicalNoteFields(n, ["createdAt", "updatedAt", "expiresAt"])),
    diary: snapshot.diary.map(d => canonicalDiaryFields(d, ["createdAt", "updatedAt"])),
    graph: { nodes: snapshot.graph.nodes.map(n => fields(n, [])), edges: snapshot.graph.edges.map(e => fields(e, [])) } };
}
export function hydrateSnapshot(raw: unknown, userId: string): Result<EtherSnapshot> {
  const result = prepareSnapshot(raw, userId);
  if (!result.ok) return result;
  const p = result.value;
  return ok({ schemaVersion: STORE_SCHEMA_VERSION, identity: p.identity, memoryNotes: p.notes, diary: p.diary,
    graph: { nodes: p.nodes, edges: p.edges } });
}
export function encodeSnapshotPayload(snapshot: EtherSnapshot): Result<Uint8Array> {
  try {
    const bytes = encodeEtherData({ profile: SNAPSHOT_PAYLOAD_PROFILE, data: persistedSnapshot(snapshot) });
    if (!bytes.ok) return bytes;
    const valid = hydrateSnapshot(snapshot, snapshot.identity.userId);
    return valid.ok ? bytes : valid;
  } catch { return err("INVALID_INPUT", "Invalid production snapshot."); }
}
/**
 * Production decode only. The payload must carry the exact current application
 * profile discriminator; unknown or missing profiles fail closed here.
 */
export function decodeSnapshotPayload(bytes: Uint8Array, userId: string): Result<EtherSnapshot> {
  const raw = decodeEtherData(bytes, false);
  if (!raw.ok) return raw;
  if (!record(raw.value) || !record(raw.value.data)) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported snapshot payload.");
  if (Object.keys(raw.value).sort().join(",") !== "data,profile") return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Malformed snapshot profile envelope.");
  if (raw.value.profile !== SNAPSHOT_PAYLOAD_PROFILE) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unknown snapshot payload profile.");
  const snapshot = hydrateSnapshot(raw.value.data, userId);
  if (!snapshot.ok) return snapshot;
  const canonical = encodeSnapshotPayload(snapshot.value);
  return canonical.ok ? snapshot : canonical;
}
/**
 * Explicit legacy decode path for historical plain v0.3 JSON payloads.
 * Callers must first verify the generic checkpoint digest over the original
 * bytes; this path never accepts the production profile envelope.
 */
export function decodeLegacySnapshotPayload(bytes: Uint8Array, userId: string): Result<EtherSnapshot> {
  const raw = decodeEtherData(bytes, false);
  if (!raw.ok) return raw;
  if (!record(raw.value)) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported legacy snapshot payload.");
  if (raw.value.profile !== undefined || raw.value.data !== undefined) {
    return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Profile envelope requires the production decode path.");
  }
  const snapshot = hydrateSnapshot(raw.value, userId);
  if (!snapshot.ok) return snapshot;
  const canonical = encodeSnapshotPayload(snapshot.value);
  return canonical.ok ? snapshot : canonical;
}
/**
 * Checkpoint dispatch after raw integrity verification: self-describing
 * production envelopes use the profile decode; historical plain payloads use
 * the explicit legacy path. Envelope-shaped payloads with an unknown profile
 * fail closed and never fall back to legacy.
 */
export function decodeCheckpointSnapshotPayload(bytes: Uint8Array, userId: string): Result<EtherSnapshot> {
  const raw = decodeEtherData(bytes, false);
  if (!raw.ok) return raw;
  if (!record(raw.value)) return err("UNSUPPORTED_PERSISTENCE_FORMAT", "Unsupported checkpoint payload.");
  const envelope = record(raw.value) && typeof raw.value.profile === "string" && record(raw.value.data)
    && Object.keys(raw.value).length === 2;
  return envelope ? decodeSnapshotPayload(bytes, userId) : decodeLegacySnapshotPayload(bytes, userId);
}
export function prepareProductionCheckpoint(metadata: CheckpointMetadata, snapshot: EtherSnapshot) {
  const payload = encodeSnapshotPayload(snapshot);
  return payload.ok ? encodeCheckpoint(metadata, payload.value) : payload;
}
/** Plain canonical persisted state (without the transport profile envelope). */
export function snapshotData(snapshot: EtherSnapshot): Result<EtherData> {
  const encoded = encodeEtherData(persistedSnapshot(snapshot));
  return encoded.ok ? decodeEtherData(encoded.value) : encoded;
}
