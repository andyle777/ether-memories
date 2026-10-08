import type { AbstractGraph, Attributes } from "graphology-types";
import type { MemoryNote } from "../types/index.js";

// Internal access to owned state avoids public getters that clone arbitrary
// metadata or the complete store. No derived cache, persisted state, or public API.
const notes = new WeakMap<object, ReadonlyMap<string, MemoryNote>>();
const graphs = new WeakMap<object, AbstractGraph<Attributes, Attributes, Attributes>>();
export const registerInspectionNotes = (owner: object, source: ReadonlyMap<string, MemoryNote>): void => { notes.set(owner, source); };
export const registerInspectionGraph = (owner: object, source: AbstractGraph<Attributes, Attributes, Attributes>): void => { graphs.set(owner, source); };
export const inspectionNotes = (owner: object): ReadonlyMap<string, MemoryNote> => {
  const source = notes.get(owner);
  if (!source) throw new Error("Inspection note source unavailable.");
  return source;
};
export const inspectionGraph = (owner: object): AbstractGraph<Attributes, Attributes, Attributes> => {
  const source = graphs.get(owner);
  if (!source) throw new Error("Inspection graph source unavailable.");
  return source;
};
