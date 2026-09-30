import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { StartupRecovery, normalizeSnapshotGraph } from "../src/persistence/StartupRecovery.js";
import { ProductionWalStore } from "../src/persistence/productionOperations.js";
import { prepareCoreMutation } from "../src/persistence/mutationPreparation.js";
import { encodeSnapshotPayload, hydrateSnapshot } from "../src/persistence/snapshotPayload.js";
import { STARTER_RELATIONS } from "../src/core/MindGraph.js";
import type { GraphRelation } from "../src/types/index.js";
import { value } from "./helpers/persistence.js";
import { bootstrap, mutationId, notePut, sourceSnapshot } from "./helpers/recovery.js";

const cleanup: string[] = [];
const setup = async (raw?: unknown) => { const store = await bootstrap(raw); cleanup.push(store.parent); return store; };
afterEach(async () => { for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true }); });

const normalizedRelationships = (bytes: Uint8Array) =>
  (JSON.parse(Buffer.from(bytes).toString("utf8")).data.graph.edges as { relationship: string }[])
    .map(edge => edge.relationship);

describe("graph consistency between published snapshot and runtime graph", () => {
  it("normalization is idempotent for supported, unsupported and historical relations", () => {
    const raw = sourceSnapshot();
    raw.graph.edges[0].relationship = "causes";
    raw.graph.edges.push({ id: "edge-plain", source: "memory:beta", target: "memory:candidate", relationship: "related_to", data: {} });
    const snapshot = value(hydrateSnapshot(raw, raw.identity.userId));
    const once = normalizeSnapshotGraph(snapshot);
    const twice = normalizeSnapshotGraph(once);
    expect(twice).toEqual(once);
    expect(normalizedRelationships(value(encodeSnapshotPayload(once)))).toEqual(["related_to", "related_to"]);
    expect(STARTER_RELATIONS).toContain("related_to" as GraphRelation);
  });
  it("one normalized graph feeds the published snapshot and the runtime representation", async () => {
    const raw = sourceSnapshot();
    raw.graph.edges[0].relationship = "causes";
    const s = await setup(raw);
    const runtime = new StartupRecovery(s.directory, raw.identity.userId, s.io);
    value(await runtime.recover());
    const read = value(runtime.read());
    // Historical unsupported relation is normalized to related_to.
    expect(read.snapshot.graph.edges.find(e => e.id === "edge-alpha-beta")!.relationship).toBe("related_to");
    // Published persisted bytes carry the same normalized relationships.
    const bytes = value(encodeSnapshotPayload(read.snapshot));
    expect(normalizedRelationships(bytes)).toEqual(["related_to"]);
    // The runtime representation is built from the same normalized graph:
    // retrieval returns graph evidence only for edges the runtime graph holds.
    const detailed = value(runtime.queryMemories("TypeScript project"));
    expect(detailed.length).toBeGreaterThan(0);
    // Idempotence through the published form: normalization applied again is a no-op.
    expect(normalizeSnapshotGraph(read.snapshot)).toEqual(read.snapshot);
  });
  it("explicit edge ids, several nodes/edges and FoundationLinker effects survive recovery identically", { timeout: 30_000 }, async () => {
    const s = await setup();
    // Detached Core execution: the linker's real effect set (including its
    // generated edge id) is captured exactly; replay reproduces it verbatim.
    const raw = sourceSnapshot();
    const base = value(hydrateSnapshot(raw, raw.identity.userId));
    const derived = value(prepareCoreMutation(base,
      { kind: "note.put", input: { content: "Committed derived", source: "diary", provenance: { kind: "diary_extract", parentDiaryId: "diary-one" } } }));
    const linkerEdge = derived.after.graph.edges.find(e => e.id.startsWith("edge_") && e.relationship === "derived_from");
    expect(linkerEdge).toBeTruthy();
    // An ordinary supported relation with an explicit edge id, prepared from
    // the first mutation's detached result.
    const explicit = value(prepareCoreMutation(derived.after,
      { kind: "graph-edge.put", id: "edge-explicit", source: "memory:beta", target: "memory:candidate",
        relationship: "supports", data: { origin: "probe" } }));
    const writer = new ProductionWalStore(s.directory, s.io);
    const first = value(await writer.commit(s.tip, mutationId("graph-derived"), derived.operations));
    value(await writer.commit(first.identity, mutationId("graph-explicit"), explicit.operations));
    const runtime = new StartupRecovery(s.directory, raw.identity.userId, s.io);
    const receipt = value(await runtime.recover());
    expect(receipt.transactions).toBe(2);
    const read = value(runtime.read());
    // Recovered persisted graph is identical to the detached Core result.
    expect(value(encodeSnapshotPayload(read.snapshot))).toEqual(value(encodeSnapshotPayload(explicit.after)));
    const edges = read.snapshot.graph.edges;
    const derivedNoteId = derived.after.memoryNotes.find(n => n.content === "Committed derived")!.id;
    expect(edges.find(e => e.id === linkerEdge!.id)).toEqual({
      id: linkerEdge!.id, source: `memory:${derivedNoteId}`, target: "diary:diary-one",
      relationship: "derived_from", data: { origin: "foundation_linker",
        cause: { type: "note_created", noteId: derivedNoteId }, provenanceKind: "diary_extract" } });
    expect(edges.find(e => e.id === "edge-explicit")!.relationship).toBe("supports");
    expect(edges.find(e => e.id === "edge-alpha-beta")!.relationship).toBe("supports");
    // No synthetic duplicate-endpoint edge exists anywhere.
    expect(edges.filter(e => e.source.startsWith("memory:") && e.target === "diary:diary-one").length).toBe(1);
    // Repeated recovery must not drift graph semantics.
    const bytes = value(encodeSnapshotPayload(read.snapshot));
    for (let i = 0; i < 3; i++) {
      const restart = new StartupRecovery(s.directory, raw.identity.userId, s.io);
      value(await restart.recover());
      expect(value(encodeSnapshotPayload(value(restart.read()).snapshot))).toEqual(bytes);
      expect(value(restart.read()).snapshot.graph).toEqual(read.snapshot.graph);
    }
  });
  it("recovery never publishes un-normalized relationships from the runtime graph", async () => {
    const raw = sourceSnapshot();
    raw.graph.edges[0].relationship = "unsupported-relation";
    const s = await setup(raw);
    const runtime = new StartupRecovery(s.directory, raw.identity.userId, s.io);
    value(await runtime.recover());
    const bytes = value(encodeSnapshotPayload(value(runtime.read()).snapshot));
    expect(normalizedRelationships(bytes)).toEqual(["related_to"]);
    const persistedFile = join(s.directory, "checkpoints");
    expect(await fs.readdir(persistedFile)).toEqual([expect.stringContaining("checkpoint-") as never]);
  });
});
