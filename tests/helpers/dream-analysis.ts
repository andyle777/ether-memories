import { EtherMemoriesCore, type DreamPlan, type DreamSelector } from "../../src/index.js";
import type { Result } from "../../src/utils/result.js";

export const DREAM_AS_OF = 1700000000000;
export function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export function seedDreamCore(
  sources: Array<{ id: string; content: string; tags?: string[] }>,
  relationships: Array<{ id: string; source: string; target: string; relationship: string }> = []
): EtherMemoriesCore {
  const core = new EtherMemoriesCore({ userId: "dream-analysis-tests" });
  const template = requireValue(core.notes.add({ content: "template" }));
  core.notes.replaceAll(sources.map(source => ({ ...template, ...source, tags: source.tags ?? ["shared"],
    createdAt: new Date(10), updatedAt: new Date(20) })));
  for (const source of sources) requireValue(core.graph.addNode({ id: `memory:${source.id}`, type: "memory", data: {} }));
  for (const edge of relationships) requireValue(core.graph.addEdgeWithId(edge.id, `memory:${edge.source}`, `memory:${edge.target}`, edge.relationship));
  const snapshot = core.exportData();
  snapshot.identity.createdAt = new Date(1).toISOString();
  snapshot.identity.lastActive = new Date(2).toISOString();
  requireValue(core.importData(snapshot));
  return core;
}
export function planFor(core: EtherMemoriesCore, selector: DreamSelector): DreamPlan {
  return requireValue(core.previewDreamCycle(selector, { asOf: DREAM_AS_OF }));
}
