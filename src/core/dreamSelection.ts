import type { MemoryNote } from "../types/index.js";
import { canonicalJson } from "../persistence/walJson.js";
import { inspectionNotes } from "./inspectionSources.js";
import { codeUnitCompare, tokenize } from "./Tokenizer.js";
import { DreamInputError, dreamEpoch, dreamScalar, type DreamRequest } from "./dreamRequest.js";

export interface DreamNoteDependency {
  id: string; content: string; tags: string[]; status: "active"; createdAt: number; expiresAt: number | null;
}
export interface DreamSelection { notes: DreamNoteDependency[]; knownCount: number; selectionTruncated: boolean; dependencyBytes: number }
export const dreamBytes = (value: unknown, limit: number): Uint8Array => {
  const result = canonicalJson(value, { bytes: limit, depth: 16, nodes: 65536 });
  if (!result.ok) throw new DreamInputError("Dream dependency encoding exceeds its bounds or is invalid.");
  return result.value;
};
const epoch = (date: Date): number => {
  if (!(date instanceof Date)) throw new DreamInputError("Invalid canonical Dream timestamp.");
  return dreamEpoch(date.getTime());
};
const eligible = (note: MemoryNote, asOf: number): boolean => note.status === "active"
  && epoch(note.createdAt) <= asOf && (note.expiresAt === undefined || epoch(note.expiresAt) > asOf);
const content = (note: MemoryNote, request: DreamRequest): string => {
  if (typeof note.content !== "string" || note.content.length > request.budgets.maxContentBytes
    || Buffer.byteLength(note.content, "utf8") > request.budgets.maxContentBytes) throw new DreamInputError("Dream source content exceeds its byte ceiling.");
  return note.content;
};
const tags = (note: MemoryNote, request: DreamRequest): string[] => {
  if (!Array.isArray(note.tags) || note.tags.length > request.budgets.maxTags) throw new DreamInputError("Dream canonical tag count exceeds its ceiling.");
  return [...new Set(note.tags.map(tag => dreamScalar(tag)))].sort(codeUnitCompare);
};
export function selectDreamNotes(owner: object, request: DreamRequest): DreamSelection {
  const source = inspectionNotes(owner), { selector, budgets, asOf } = request;
  let workBytes = 0;
  const charge = (text: string) => { workBytes += Buffer.byteLength(text, "utf8"); if (workBytes > budgets.maxSelectionBytes) throw new DreamInputError("Dream selector work byte ceiling exceeded."); };
  let ids: string[];
  if (selector.kind === "ids") ids = selector.ids;
  else {
    if (source.size > budgets.maxPopulation) throw new DreamInputError("Dream population work ceiling exceeded; use explicit bounded IDs.");
    ids = [];
    for (const id of source.keys()) { dreamScalar(id); charge(id); ids.push(id); }
    ids.sort(codeUnitCompare);
  }
  const matched: string[] = [];
  const queryTokens = selector.kind === "query" ? tokenize(selector.query) : [];
  for (const id of ids) {
    const note = source.get(id);
    if (!note) throw new DreamInputError("A requested Memory Note does not exist.", "NOT_FOUND");
    if (!eligible(note, asOf)) {
      if (selector.kind === "ids") throw new DreamInputError("A requested Memory Note is not eligible at asOf.");
      continue;
    }
    if (selector.kind === "tags") {
      const canonical = tags(note, request); for (const tag of canonical) charge(tag);
      if (!selector.tags.every(tag => canonical.includes(tag))) continue;
    } else if (selector.kind === "query") {
      const text = content(note, request); charge(text);
      const tokens = new Set(tokenize(text));
      if (!queryTokens.every(token => tokens.has(token))) continue;
    } else if (selector.kind === "date-window" && (epoch(note.createdAt) < selector.from || epoch(note.createdAt) >= selector.to)) continue;
    if (selector.kind === "ids") charge(id);
    matched.push(id);
  }
  let dependencyBytes = 0;
  const notes = matched.slice(0, budgets.maxSources).map(id => {
    const note = source.get(id)!;
    if (note.id !== id) throw new DreamInputError("Canonical Dream note identity does not match its key.");
    const dependency: DreamNoteDependency = { id: dreamScalar(id), content: content(note, request), tags: tags(note, request),
      status: "active", createdAt: epoch(note.createdAt), expiresAt: note.expiresAt === undefined ? null : epoch(note.expiresAt) };
    dependencyBytes += dreamBytes(dependency, budgets.maxNoteDependencyBytes).byteLength;
    if (dependencyBytes > budgets.maxDependencyBytes) throw new DreamInputError("Dream aggregate source dependency byte ceiling exceeded.");
    return dependency;
  });
  return { notes, knownCount: matched.length, selectionTruncated: matched.length > notes.length, dependencyBytes };
}
