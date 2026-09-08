import { createRequire } from "node:module";
import type { AbstractGraph, Attributes } from "graphology-types";
const require = createRequire(import.meta.url);
type GraphInstance = AbstractGraph<Attributes, Attributes, Attributes>;
type GraphConstructor = new (options?: Record<string, unknown>) => GraphInstance;
const Graph = require("graphology") as GraphConstructor;
import type { GraphRelation, MindGraphEdge, MindGraphNode } from "../types/index.js";
import { createId } from "../utils/ids.js";
import { err, ok, type Result } from "../utils/result.js";
import { cloneValue } from "../utils/clone.js";

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
      for (const n of [...frontier].sort()) {
        const visit = (_edgeKey: string, attrs: any, source: string, target: string) => {
          const relationship = String(attrs.relationship ?? "related_to");
          if (relationAllowlist && !relationAllowlist.includes(relationship)) return;
          const neighbor = source === n ? target : source;
          edges.set(_edgeKey, {
            id: _edgeKey, source, target, relationship,
            data: cloneValue((attrs.data ?? {}) as Record<string, unknown>)
          });
          if (visited.has(neighbor)) return;
          visited.add(neighbor);
          next.add(neighbor);
        };
        if (direction === "out" || direction === "both") this.graph.forEachOutEdge(n, visit);
        if (direction === "in" || direction === "both") this.graph.forEachInEdge(n, visit);
      }
      frontier = next;
    }
    const nodes = [...visited].filter(x => x !== id).sort().map(nodeId => this.getNode(nodeId)!).filter(Boolean);
    return {
      nodes,
      edges: [...edges.values()].filter(edge => visited.has(edge.source) && visited.has(edge.target)).sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  /** Recall traversal is intentionally capped and does not re-expand visited nodes. */
  getRecallNeighbors(id: string, depth: 0 | 1 | 2 = 1, maxNodes = 8, relationAllowlist?: string[], direction: "in" | "out" | "both" = "both"): {
    nodes: MindGraphNode[];
    edges: MindGraphEdge[];
    paths: Map<string, MindGraphEdge[]>;
  } {
    const paths = new Map<string, MindGraphEdge[]>();
    if (!this.graph.hasNode(id) || depth === 0 || maxNodes <= 0) return { nodes: [], edges: [], paths };
    const visited = new Set([id]);
    let frontier = [id];
    const edges = new Map<string, MindGraphEdge>();
    for (let level = 0; level < depth && frontier.length && visited.size - 1 < maxNodes; level++) {
      const next: string[] = [];
      for (const current of frontier.sort()) {
        const candidates: MindGraphEdge[] = [];
        const collect = (key: string, attrs: any, source: string, target: string) => {
          const relationship = String(attrs.relationship ?? "related_to");
          if (!relationAllowlist || relationAllowlist.includes(relationship)) {
            candidates.push({ id: key, source, target, relationship, data: cloneValue((attrs.data ?? {}) as Record<string, unknown>) });
          }
        };
        if (direction === "out" || direction === "both") this.graph.forEachOutEdge(current, collect);
        if (direction === "in" || direction === "both") this.graph.forEachInEdge(current, collect);
        for (const edge of candidates.sort((a, b) => a.id.localeCompare(b.id))) {
          const neighbor = direction === "in" ? edge.source : edge.source === current ? edge.target : edge.source;
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push(neighbor);
          edges.set(edge.id, edge);
          paths.set(neighbor, [...(paths.get(current) ?? []), edge]);
          if (visited.size - 1 >= maxNodes) break;
        }
        if (visited.size - 1 >= maxNodes) break;
      }
      frontier = next;
    }
    return { nodes: [...visited].filter(node => node !== id).sort().map(node => this.getNode(node)!).filter(Boolean), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), paths };
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
