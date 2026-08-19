import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The associative layer -- deliberately separate from decay.ts's
 * time-based salience. An association is a short, weighted link between
 * two NODES (a memory, a core-memory block, or an access record -- any of
 * mymem's stores, not just memories) that gets STRONGER with experience
 * (explicit or co-occurrence reinforcement) and otherwise stays put -- it
 * does not fade on its own the way recall salience does. This mirrors how
 * associative memory in humans solidifies with repetition rather than
 * decaying with the clock, and doesn't care which "kind" of memory the two
 * ends are -- a fact, a pinned focus note, and a frequently-read file can
 * all be linked the same way.
 */

export type NodeType = "memory" | "core" | "access";

export interface AssociationEdge {
  id: string;
  from: string;
  fromType: NodeType;
  to: string;
  toType: NodeType;
  relation: string;
  weight: number;
  reinforcedCount: number;
  createdAt: string;
  lastReinforcedAt: string;
}

export interface NodeRef {
  type: NodeType;
  id: string;
}

const DEFAULT_WEIGHT = 0.5;
const EXPLICIT_LEARNING_RATE = 0.2;
const IMPLICIT_LEARNING_RATE = 0.05; // co-occurrence reinforcement is much gentler than an explicit call
const MIN_WEIGHT = 0.05; // an edge fades toward irrelevance on repeated weakening but is never deleted by weakening alone

/** Asymptotic reinforcement: approaches but never reaches 1. Diminishing returns as weight climbs. */
function reinforceWeight(weight: number, rate: number): number {
  return weight + (1 - weight) * rate;
}

/** Mirror operation for correction -- approaches but never reaches 0. */
function weakenWeight(weight: number, rate: number): number {
  return Math.max(MIN_WEIGHT, weight - weight * rate);
}

function nodeKey(node: NodeRef): string {
  return `${node.type}:${node.id}`;
}

/**
 * Canonical, order-independent pair key so A-B and B-A reinforce the same
 * edge. Ordering compares the composite (type, id) key, not the bare id --
 * ids from different types happen to be drawn from disjoint formats today
 * (memory=UUID, core=block name, access=content hash) but nothing
 * guarantees that in principle, so type must be part of the ordering key.
 */
function pairKey(a: NodeRef, b: NodeRef): [NodeRef, NodeRef] {
  return nodeKey(a) < nodeKey(b) ? [a, b] : [b, a];
}

/** Edges written before typed nodes existed have no fromType/toType on disk -- the only type back then was memory. */
function normalize(edge: AssociationEdge): AssociationEdge {
  return { ...edge, fromType: edge.fromType ?? "memory", toType: edge.toType ?? "memory" };
}

export class AssociationStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = path.join(homeDir, "associations");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async all(): Promise<AssociationEdge[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const edges: AssociationEdge[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, entry.name), "utf8");
        edges.push(normalize(JSON.parse(raw) as AssociationEdge));
      } catch {
        // Same resilience policy as the rest of the store: skip, never fail the whole read.
      }
    }
    return edges;
  }

  private async findEdge(from: NodeRef, to: NodeRef, relation: string): Promise<AssociationEdge | undefined> {
    const [a, b] = pairKey(from, to);
    const edges = await this.all();
    return edges.find((edge) => {
      const [ea, eb] = pairKey({ type: edge.fromType, id: edge.from }, { type: edge.toType, id: edge.to });
      return nodeKey(ea) === nodeKey(a) && nodeKey(eb) === nodeKey(b) && edge.relation === relation;
    });
  }

  private async save(edge: AssociationEdge): Promise<void> {
    await writeFile(this.filePath(edge.id), `${JSON.stringify(edge, null, 2)}\n`, "utf8");
  }

  async associate(from: NodeRef, to: NodeRef, relation: string, signal: "reinforce" | "weaken", implicit = false): Promise<AssociationEdge> {
    if (from.type === to.type && from.id === to.id) throw new Error("A node cannot be associated with itself.");
    const rate = implicit ? IMPLICIT_LEARNING_RATE : EXPLICIT_LEARNING_RATE;
    const now = new Date().toISOString();
    const existing = await this.findEdge(from, to, relation);
    if (existing) {
      existing.weight = signal === "reinforce" ? reinforceWeight(existing.weight, rate) : weakenWeight(existing.weight, rate);
      existing.reinforcedCount += 1;
      existing.lastReinforcedAt = now;
      await this.save(existing);
      return existing;
    }
    const edge: AssociationEdge = {
      id: randomUUID(),
      from: from.id,
      fromType: from.type,
      to: to.id,
      toType: to.type,
      relation,
      weight: signal === "reinforce" ? reinforceWeight(DEFAULT_WEIGHT, rate) : weakenWeight(DEFAULT_WEIGHT, rate),
      reinforcedCount: 1,
      createdAt: now,
      lastReinforcedAt: now,
    };
    await this.save(edge);
    return edge;
  }

  /** Reinforce every pair among a set of co-retrieved memory IDs -- "fire together, wire together," gently. Kept memory-only: this is what mymem_get_context's own co-retrieval hook uses. */
  async coReinforce(memoryIds: string[], relation = "co-occurs"): Promise<void> {
    for (let i = 0; i < memoryIds.length; i += 1) {
      for (let j = i + 1; j < memoryIds.length; j += 1) {
        await this.associate({ type: "memory", id: memoryIds[i] }, { type: "memory", id: memoryIds[j] }, relation, "reinforce", true);
      }
    }
  }

  /** Direct neighbors of one node, ranked by weight (strongest association first). */
  async neighbors(node: NodeRef, limit: number): Promise<Array<AssociationEdge & { neighborId: string; neighborType: NodeType }>> {
    const edges = await this.all();
    const matches = (edge: AssociationEdge) => (edge.from === node.id && edge.fromType === node.type) || (edge.to === node.id && edge.toType === node.type);
    return edges
      .filter(matches)
      .map((edge) => {
        const isFrom = edge.from === node.id && edge.fromType === node.type;
        return { ...edge, neighborId: isFrom ? edge.to : edge.from, neighborType: isFrom ? edge.toType : edge.fromType };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /**
   * Short associative paths outward from one node: direct neighbors, and
   * optionally one further hop (spreading activation), weight-discounted
   * per hop and deduplicated against anything already reached.
   */
  async walk(node: NodeRef, depth: 1 | 2, limit: number): Promise<Array<{ nodeId: string; nodeType: NodeType; weight: number; viaRelation: string; hops: 1 | 2 }>> {
    const direct = await this.neighbors(node, limit);
    const reached = new Map<string, { nodeId: string; nodeType: NodeType; weight: number; viaRelation: string; hops: 1 | 2 }>();
    for (const edge of direct) {
      reached.set(nodeKey({ type: edge.neighborType, id: edge.neighborId }), { nodeId: edge.neighborId, nodeType: edge.neighborType, weight: edge.weight, viaRelation: edge.relation, hops: 1 });
    }
    if (depth === 2) {
      for (const edge of direct) {
        const secondHop = await this.neighbors({ type: edge.neighborType, id: edge.neighborId }, limit);
        for (const hop2 of secondHop) {
          const hop2Key = nodeKey({ type: hop2.neighborType, id: hop2.neighborId });
          if ((hop2.neighborId === node.id && hop2.neighborType === node.type) || reached.has(hop2Key)) continue;
          const discounted = edge.weight * hop2.weight; // spreading activation loses strength per hop
          reached.set(hop2Key, { nodeId: hop2.neighborId, nodeType: hop2.neighborType, weight: discounted, viaRelation: `${edge.relation}->${hop2.relation}`, hops: 2 });
        }
      }
    }
    return [...reached.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
  }
}
