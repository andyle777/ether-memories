import { err, ok, type Result } from "../utils/result.js";
import { PERSISTENCE_LIMITS } from "./codecs.js";

export const ETHER_DATA_PROFILE = "ether.data-json.v1" as const;
export type EtherData = null | boolean | number | string | EtherData[] | { [key: string]: EtherData };
export const MAX_ETHER_DATA_BYTES = PERSISTENCE_LIMITS.checkpointPayloadBytes;
const invalid = () => err("INVALID_INPUT", "Invalid production Ether data value.");
const excessive = () => err("RECOVERY_REQUIRED", "Production data exceeds its checkpoint-compatible bound.", { reason: "resource-limit" });

/**
 * Persisted JSON values, not arbitrary JavaScript. Iterative traversal avoids a
 * call-stack limit. Depth/node ceilings follow the minimum JSON bytes they need.
 * Dates are projected by the snapshot layer, never coerced through user toJSON.
 */
export function encodeEtherData(value: unknown, maxBytes = MAX_ETHER_DATA_BYTES): Result<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ETHER_DATA_BYTES) return invalid();
  type Task = { value: unknown; depth: number } | { text: string } | { leave: object };
  const tasks: Task[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let length = 0, nodes = 0;
  const append = (s: string) => {
    length += Buffer.byteLength(s, "utf8");
    if (length > maxBytes) throw "bound";
    chunks.push(s);
  };
  try {
    while (tasks.length) {
      const task = tasks.pop()!;
      if ("text" in task) { append(task.text); continue; }
      if ("leave" in task) { ancestors.delete(task.leave); continue; }
      if (++nodes > maxBytes || task.depth > Math.floor(maxBytes / 2)) throw "bound";
      const item = task.value;
      if (item === null || typeof item === "boolean") { append(JSON.stringify(item)); continue; }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) throw "invalid";
        append(JSON.stringify(item)); continue;
      }
      if (typeof item === "string") {
        if (item.length > maxBytes) throw "bound";
        // Well-formed ECMAScript JSON escapes lone surrogates, preserving code units.
        append(JSON.stringify(item)); continue;
      }
      if (typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw "invalid";
      const array = Array.isArray(item);
      const prototype = Object.getPrototypeOf(item);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw "invalid";
      const keys = Object.getOwnPropertyNames(item);
      if (keys.length > maxBytes) throw "bound";
      if (array && (keys.length !== item.length + 1 || Object.keys(item).length !== item.length)) throw "invalid";
      const names = array ? keys.filter(k => k !== "length") : keys.sort();
      // Check descriptors before traversal; never invoke accessors or prototype setters.
      const values = names.map((key, i) => {
        if (array && key !== String(i)) throw "invalid";
        const d = Object.getOwnPropertyDescriptor(item, key)!;
        if (!d.enumerable || !("value" in d)) throw "invalid";
        return d.value;
      });
      ancestors.add(item);
      tasks.push({ leave: item }, { text: array ? "]" : "}" });
      for (let i = names.length - 1; i >= 0; i--) {
        tasks.push({ value: values[i], depth: task.depth + 1 });
        if (!array) tasks.push({ text: ":" }, { value: names[i], depth: task.depth + 1 });
        if (i) tasks.push({ text: "," });
      }
      append(array ? "[" : "{");
    }
    return ok(Buffer.from(chunks.join(""), "utf8"));
  } catch (e) { return e === "bound" ? excessive() : invalid(); }
}

/** JSON.parse creates own __proto__ data properties without invoking setters. */
export function decodeEtherData(bytes: Uint8Array, canonical = true, maxBytes = MAX_ETHER_DATA_BYTES): Result<EtherData> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return excessive();
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    const encoded = encodeEtherData(value, maxBytes);
    if (!encoded.ok) return encoded;
    if (canonical && !Buffer.from(bytes).equals(encoded.value)) return err("INVALID_INPUT", "Noncanonical production data encoding.");
    return ok(value as EtherData);
  } catch { return err("INVALID_INPUT", "Invalid production UTF-8 JSON payload."); }
}
