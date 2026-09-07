import { createRequire } from "node:module";
import type { AbstractGraph, Attributes } from "graphology-types";
const require = createRequire(import.meta.url);
type GraphInstance = AbstractGraph<Attributes, Attributes, Attributes>;
type GraphConstructor = new (options?: Record<string, unknown>) => GraphInstance;
const Graph = require("graphology") as GraphConstructor;
import type { GraphRelation, MindGraphEdge, MindGraphNode } from "../types/index.js";
import { createId } from "../utils/ids.js";
import { err, ok, type Result } from "../utils/result.js";

export const STARTER_RELATIONS: GraphRelation[] = [
  "related_to", "mentions", "derived_from", "supports",
  "prefers", "worked_on", "part_of", "about"
];

export class MindGraphManager {
  private readonly graph = new Graph({ multi: false, type: "directed" });

  addNode(node: MindGraphNode): Result<MindGraphNode> {
    if (this.graph.hasNode(node.id)) return ok(node);
    this.graph.addNode(node.id, { type: node.type, label: node.label, data: cloneValue(node.data) });
    return ok({ ...node, data: cloneValue(node.data) });
  }

  ensureNode(node: MindGraphNode): Result<MindGraphNode> {
    if (this.graph.hasNode(node.id)) {
      this.graph.mergeNodeAttributes(node.id, { type: node.type, label: node.label, data: cloneValue(node.data) });
      return ok({ ...node, data: cloneValue(node.data) });
    }
    return this.addNode(node);
  }

  addEdgeWithId(id: string, source: string, target: string, relationship = "related_to", data: Record<string, unknown> = {}): Result<MindGraphEdge> {
    if (!this.graph.hasNode(source) || !this.graph.hasNode(target)) return err("NOT_FOUND", "Both graph endpoints must exist.");
    if (this.graph.hasEdge(id)) return err("CONFLICT", `Graph edge already exists: ${id}`);
    const normalized = STARTER_RELATIONS.includes(relationship as GraphRelation) ? relationship : "related_to";
    try {
      this.graph.addEdgeWithKey(id, source, target, { relationship: normalized, data: cloneValue(data) });
      return ok({ id, source, target, relationship: normalized, data: cloneValue(data) });
    } catch (cause) { return err("CONFLICT", "A directed edge already exists between these graph endpoints.", cause); }
  }

  addEdge(source: string, target: string, relationship: string = "related_to", data: Record<string, unknown> = {}): Result<MindGraphEdge> {
    if (!this.graph.hasNode(source) || !this.graph.hasNode(target)) {
      return err("NOT_FOUND", "Both graph endpoints must exist.");
    }
    const normalized = STARTER_RELATIONS.includes(relationship as GraphRelation) ? relationship : "related_to";
    const edgeId = createId("edge");
    try {
      this.graph.addEdgeWithKey(edgeId, source, target, { relationship: normalized, data: cloneValue({ ...data, ...(normalized !== relationship ? { rawRelation: relationship } : {}) }) });
    } catch (cause) {
      return err("CONFLICT", "A directed edge already exists between these graph endpoints.", cause);
    }
    return ok({ id: edgeId, source, target, relationship: normalized, data: cloneValue(data) });
  }

  getNeighbors(id: string, depth: 0 | 1 | 2 = 1, relationAllowlist?: string[], direction: "in" | "out" | "both" = "both"): { nodes: MindGraphNode[]; edges: MindGraphEdge[] } {
    if (!this.graph.hasNode(id) || depth === 0) return { nodes: [], edges: [] };
    const visited = new Set<string>([id]);
    let frontier = new Set<string>([id]);
    const edges = new Map<string, MindGraphEdge>();
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>();
      for (const n of frontier) {
        const visit = (_edgeKey: string, attrs: any, source: string, target: string) => {
          const relationship = String(attrs.relationship ?? "related_to");
          if (relationAllowlist && !relationAllowlist.includes(relationship)) return;
          const neighbor = source === n ? target : source;
          if (visited.has(neighbor)) return;
          visited.add(neighbor);
          next.add(neighbor);
          edges.set(_edgeKey, {
            id: _edgeKey, source, target, relationship,
            data: cloneValue((attrs.data ?? {}) as Record<string, unknown>)
          });
        };
        if (direction === "out" || direction === "both") this.graph.forEachOutEdge(n, visit);
        if (direction === "in" || direction === "both") this.graph.forEachInEdge(n, visit);
      }
      frontier = next;
    }
    const nodes = [...visited].filter(x => x !== id).map(nodeId => this.getNode(nodeId)!).filter(Boolean);
    return { nodes, edges: [...edges.values()] };
  }

  getNode(id: string): MindGraphNode | undefined {
    if (!this.graph.hasNode(id)) return undefined;
    const a = this.graph.getNodeAttributes(id) as any;
    return { id, type: String(a.type), label: a.label, data: cloneValue((a.data ?? {}) as Record<string, unknown>) };
  }

  listByType(type: string): MindGraphNode[] {
    return this.graph.filterNodes((_id, attrs) => attrs.type === type).map(id => this.getNode(id)!);
  }

  getAllNodes(): MindGraphNode[] {
    return this.graph.nodes().map(id => this.getNode(id)!);
  }

  getAllEdges(): MindGraphEdge[] {
    return this.graph.edges().map(id => {
      const a = this.graph.getEdgeAttributes(id) as any;
      const [source, target] = this.graph.extremities(id);
      return { id, source, target, relationship: String(a.relationship ?? "related_to"), data: cloneValue((a.data ?? {}) as Record<string, unknown>) };
    });
  }

  removeNode(id: string): void {
    if (this.graph.hasNode(id)) this.graph.dropNode(id);
  }

  clear(): void { this.graph.clear(); }
}

const cloneValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cloneValue(v)])) as T;
};
