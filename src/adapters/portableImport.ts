import type {
  DiaryEntry, MemoryNote, MemorySource, MemoryStatus, PortableImportIssue,
  PortableImportReceipt, PortableRecord
} from "../types/index.js";
import { PORTABLE_RECORD_SCHEMA_VERSION } from "../version.js";

export interface PortableImportLimits {
  maxBytes: number;
  maxRecords: number;
  maxStringLength: number;
  maxAggregateStringLength: number;
  maxDepth: number;
}

export const DEFAULT_PORTABLE_IMPORT_LIMITS: PortableImportLimits = {
  maxBytes: 1024 * 1024,
  maxRecords: 10000,
  maxStringLength: 100000,
  maxAggregateStringLength: 5000000,
  maxDepth: 8
};

export type PortableImportInput =
  | unknown
  | string
  | Uint8Array
  | AsyncIterable<string | Uint8Array>;

export interface PreparedPortableImport {
  notes: MemoryNote[];
  diary: DiaryEntry[];
  receipt: PortableImportReceipt;
}

export const preparePortableImport = async (
  input: PortableImportInput,
  existingNoteIds: ReadonlySet<string>,
  existingDiaryIds: ReadonlySet<string>,
  limits: Partial<PortableImportLimits> = {}
): Promise<PreparedPortableImport> => {
  const effective = { ...DEFAULT_PORTABLE_IMPORT_LIMITS, ...limits };
  const issues: PortableImportIssue[] = [];
  const raw = await materialize(input, effective, issues);
  if (raw === undefined) return { notes: [], diary: [], receipt: { imported: 0, issues: sortIssues(issues) } };
  const payload = parsePayload(raw, issues);
  if (!Array.isArray(payload)) {
    issues.push(issue("MALFORMED_RECORD", "Input must be an array of Portable Records.", { fieldPath: "$" }));
    return { notes: [], diary: [], receipt: { imported: 0, issues: sortIssues(issues) } };
  }
  if (payload.length > effective.maxRecords) {
    issues.push(issue("INPUT_LIMIT_EXCEEDED", "Portable Record count exceeds the configured limit.", { fieldPath: "$" }));
  }
  const notes: MemoryNote[] = [];
  const diary: DiaryEntry[] = [];
  const seen = new Set<string>();
  let aggregate = 0;
  payload.forEach((value, index) => {
    const record = isRecord(value) ? value : undefined;
    if (!record) {
      issues.push(issue("MALFORMED_RECORD", "Record must be an object.", { recordIndex: index }));
      return;
    }
    if (maxObjectDepth(record) > effective.maxDepth) {
      issues.push(issue("INPUT_LIMIT_EXCEEDED", "Portable Record nesting exceeds the configured limit.", { recordIndex: index, fieldPath: "$" }));
      return;
    }
    aggregate += collectStringSize(record);
    if (aggregate > effective.maxAggregateStringLength) {
      issues.push(issue("INPUT_LIMIT_EXCEEDED", "Aggregate Portable Record string size exceeds the configured limit.", { recordIndex: index }));
      return;
    }
    validateRecord(record, index, seen, existingNoteIds, existingDiaryIds, effective, issues, notes, diary);
  });
  const sorted = sortIssues(issues);
  return { notes: sorted.some(item => item.blocking) ? [] : notes, diary: sorted.some(item => item.blocking) ? [] : diary, receipt: { imported: sorted.some(item => item.blocking) ? 0 : notes.length + diary.length, issues: sorted } };
};

export const preflightPortableRecords = preparePortableImport;

const validateRecord = (
  record: Record<string, unknown>,
  index: number,
  seen: Set<string>,
  existingNotes: ReadonlySet<string>,
  existingDiary: ReadonlySet<string>,
  limits: PortableImportLimits,
  issues: PortableImportIssue[],
  notes: MemoryNote[],
  diary: DiaryEntry[]
): void => {
  const id = record.id;
  const kind = record.kind;
  if (record.schema !== PORTABLE_RECORD_SCHEMA_VERSION) issues.push(issue(typeof record.schema === "string" ? "UNSUPPORTED_SCHEMA" : "MALFORMED_RECORD", "Unsupported Portable Record schema.", { recordIndex: index, fieldPath: "schema", incomingValue: record.schema }));
  if (kind !== "note" && kind !== "diary") issues.push(issue("INVALID_KIND", "Record kind must be note or diary.", { recordIndex: index, fieldPath: "kind", incomingValue: kind }));
  if (typeof id !== "string" || !id.trim()) {
    issues.push(issue("INVALID_ID", "Record ID must be a non-empty string.", { recordIndex: index, fieldPath: "id", incomingValue: id }));
    return;
  }
  if (id !== id.trim() || seen.has(id)) issues.push(issue(seen.has(id) ? "DUPLICATE_PAYLOAD_ID" : "INVALID_ID", "Record IDs must be unique and unchanged.", { recordIndex: index, recordId: id, fieldPath: "id" }));
  seen.add(id);
  const existing = kind === "note" ? existingNotes.has(id) : existingDiary.has(id);
  if (existing) issues.push(issue("EXISTING_ID_CONFLICT", "Record ID already exists in the target store.", { recordIndex: index, recordId: id, fieldPath: "id" }));
  const text = typeof record.text === "string" ? record.text : undefined;
  if (text === undefined || !text.trim() || text.length > limits.maxStringLength) {
    issues.push(issue(text !== undefined && text.length > limits.maxStringLength ? "INPUT_LIMIT_EXCEEDED" : "MALFORMED_RECORD", "Record text must be non-whitespace text within the configured limit.", { recordIndex: index, recordId: id, fieldPath: "text" }));
  }
  const created = parseTimestamp(record.createdAt, index, id, "createdAt", issues);
  const updated = parseTimestamp(record.updatedAt, index, id, "updatedAt", issues);
  if (created && updated && updated < created) issues.push(issue("INVALID_CHRONOLOGY", "updatedAt must not precede createdAt.", { recordIndex: index, recordId: id, fieldPath: "updatedAt" }));
  validateCitation(record.citation, kind, id, index, issues);
  const validTags = Array.isArray(record.tags) && record.tags.every(tag => typeof tag === "string");
  if (!validTags) issues.push(issue("MALFORMED_RECORD", "tags must be an array of strings.", { recordIndex: index, recordId: id, fieldPath: "tags" }));
  if (record.category !== undefined && typeof record.category !== "string") issues.push(issue("MALFORMED_RECORD", "category must be a string when supplied.", { recordIndex: index, recordId: id, fieldPath: "category" }));
  if (kind === "note") {
    const status = record.status === undefined ? "active" : record.status;
    const source = record.source === undefined ? "imported" : record.source;
    if (!isStatus(status)) issues.push(issue("INVALID_STATUS", "Invalid Note status.", { recordIndex: index, recordId: id, fieldPath: "status", incomingValue: status }));
    if (!isSource(source)) issues.push(issue("INVALID_SOURCE", "Invalid Note source.", { recordIndex: index, recordId: id, fieldPath: "source", incomingValue: source }));
    const confidence = record.confidence === undefined ? 0.75 : record.confidence;
    if (!isUnitNumber(confidence)) issues.push(issue("MALFORMED_RECORD", "Confidence must be a finite number from 0 through 1.", { recordIndex: index, recordId: id, fieldPath: "confidence" }));
    if (created && updated && isStatus(status) && isSource(source) && text !== undefined && text.trim() && isUnitNumber(confidence)) notes.push({
      id, content: text.trim(), category: typeof record.category === "string" ? record.category : undefined,
      tags: validTags ? [...record.tags as string[]] : [],
      source, provenance: { kind: "imported", lastEditKind: "import" }, importance: 0.5,
      confidence, pinned: false, status,
      createdAt: created, updatedAt: updated, metadata: {}
    });
  } else if (kind === "diary" && created && updated && text !== undefined && text.trim()) {
    diary.push({
      id, content: text.trim(), createdAt: created, updatedAt: updated,
      tags: validTags ? [...record.tags as string[]] : [], metadata: {}
    });
  }
};

const validateCitation = (value: unknown, kind: unknown, id: string, index: number, issues: PortableImportIssue[]): void => {
  if (!isRecord(value) || value.kind !== kind || value.id !== id || value.ref !== `${kind}:${id}`) {
    issues.push(issue("INVALID_CITATION", "Citation must match the canonical kind, ID, and ref.", { recordIndex: index, recordId: id, fieldPath: "citation" }));
  }
};

const parseTimestamp = (value: unknown, index: number, id: string, fieldPath: string, issues: PortableImportIssue[]): Date | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    issues.push(issue("INVALID_TIMESTAMP", "Timestamp must be canonical UTC ISO with milliseconds.", { recordIndex: index, recordId: id, fieldPath, incomingValue: value }));
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    issues.push(issue("INVALID_TIMESTAMP", "Timestamp is not a valid canonical UTC instant.", { recordIndex: index, recordId: id, fieldPath, incomingValue: value }));
    return undefined;
  }
  return parsed;
};

const materialize = async (input: PortableImportInput, limits: PortableImportLimits, issues: PortableImportIssue[]): Promise<unknown> => {
  if (typeof input === "string") {
    if (byteLength(input) > limits.maxBytes) { issues.push(issue("INPUT_LIMIT_EXCEEDED", "Raw input exceeds the configured byte limit.", { fieldPath: "$" })); return undefined; }
    return parsePayload(input, issues);
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > limits.maxBytes) { issues.push(issue("INPUT_LIMIT_EXCEEDED", "Raw input exceeds the configured byte limit.", { fieldPath: "$" })); return undefined; }
    return parsePayload(new TextDecoder().decode(input), issues);
  }
  if (isAsyncIterable(input)) {
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of input) {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      total += bytes.byteLength;
      if (total > limits.maxBytes) { issues.push(issue("INPUT_LIMIT_EXCEEDED", "Raw input exceeds the configured byte limit.", { fieldPath: "$" })); return undefined; }
      chunks.push(bytes);
    }
    const combined = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    return parsePayload(new TextDecoder().decode(combined), issues);
  }
  return input;
};

const parsePayload = (value: unknown, issues: PortableImportIssue[]): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { issues.push(issue("MALFORMED_RECORD", "Input is not valid JSON.", { fieldPath: "$" })); return undefined; }
};
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isAsyncIterable = (value: unknown): value is AsyncIterable<string | Uint8Array> => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as AsyncIterable<string | Uint8Array>;
  return typeof candidate[Symbol.asyncIterator] === "function";
};
const isUnitNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isStatus = (value: unknown): value is MemoryStatus => ["candidate", "active", "archived", "rejected"].includes(String(value));
const isSource = (value: unknown): value is MemorySource => ["user", "conversation", "diary", "ai", "imported", "system"].includes(String(value));
const collectStringSize = (value: unknown, depth = 0): number => {
  if (depth > 8) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + collectStringSize(item, depth + 1), 0);
  if (isRecord(value)) return Object.entries(value).reduce((sum, [key, item]) => sum + key.length + collectStringSize(item, depth + 1), 0);
  return 0;
};
const issue = (code: PortableImportIssue["code"], message: string, details: Partial<PortableImportIssue> = {}): PortableImportIssue => ({ code, message, blocking: true, ...details });
const maxObjectDepth = (value: unknown, depth = 0): number => {
  if (Array.isArray(value)) return Math.max(depth, ...value.map(item => maxObjectDepth(item, depth + 1)));
  if (isRecord(value)) return Math.max(depth, ...Object.values(value).map(item => maxObjectDepth(item, depth + 1)));
  return depth;
};
const codeUnitCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sortIssues = (items: PortableImportIssue[]): PortableImportIssue[] => [...items].sort((a, b) => (a.recordIndex ?? Number.MAX_SAFE_INTEGER) - (b.recordIndex ?? Number.MAX_SAFE_INTEGER) || codeUnitCompare(a.fieldPath ?? "", b.fieldPath ?? "") || codeUnitCompare(a.code, b.code));
