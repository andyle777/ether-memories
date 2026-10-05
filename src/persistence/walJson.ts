import { err, ok, type Result } from "../utils/result.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const walCorruption = (message: string) => err("PERSISTENCE_CORRUPTION", message);

export interface JsonBounds { readonly bytes: number; readonly depth: number; readonly nodes: number }

/** WAL v1 canonical JSON: sorted UTF-16 keys, ECMAScript scalar encoding, no coercion. */
export function canonicalJson(value: unknown, bounds: JsonBounds): Result<Uint8Array> {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > bounds.bytes) throw new Error("JSON byte bound exceeded.");
    chunks.push(text);
  };
  const string = (text: string) => {
    if (text.length > bounds.bytes) throw new Error("JSON string bound exceeded.");
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Unpaired surrogate.");
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Unpaired surrogate.");
    }
    append(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > bounds.nodes || depth > bounds.depth) throw new Error("JSON traversal bound exceeded.");
    if (item === null) { append("null"); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { append(item ? "true" : "false"); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        throw new Error("Noncanonical JSON number.");
      }
      append(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("Non-JSON value or cycle.");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Symbol properties are not JSON.");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > bounds.nodes
        || Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) throw new Error("Sparse or extended array.");
      append("[");
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !("value" in descriptor)) throw new Error("Array accessor.");
        if (i) append(",");
        visit(descriptor.value, depth + 1);
      }
      append("]");
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Non-plain JSON object.");
      const keys = Object.getOwnPropertyNames(item).sort();
      if (keys.length > bounds.nodes) throw new Error("Object member bound exceeded.");
      append("{");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Reserved JSON key.");
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Object accessor or hidden field.");
        if (i) append(",");
        string(key);
        append(":");
        visit(descriptor.value, depth + 1);
      }
      append("}");
    }
    ancestors.delete(item);
  };
  try { visit(value, 0); return ok(Buffer.from(chunks.join(""), "utf8")); }
  catch { return walCorruption("Invalid or excessive canonical WAL JSON."); }
}

export function decodeCanonicalJson(bytes: Uint8Array, bounds: JsonBounds): Result<unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > bounds.bytes) return walCorruption("WAL JSON byte bound exceeded.");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        if (++depth > bounds.depth + 1) return walCorruption("WAL JSON nesting bound exceeded.");
      } else if (char === "}" || char === "]") depth--;
    }
    const value: unknown = JSON.parse(text);
    const canonical = canonicalJson(value, bounds);
    if (!canonical.ok) return canonical;
    if (!Buffer.from(bytes).equals(Buffer.from(canonical.value))) return walCorruption("Noncanonical WAL JSON bytes.");
    return ok(value);
  } catch { return walCorruption("Malformed WAL UTF-8/JSON."); }
}

export function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
