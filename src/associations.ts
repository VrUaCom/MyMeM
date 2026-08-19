import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The associative layer -- deliberately separate from decay.ts's
 * time-based salience. An association is a short, weighted link between
 * two memories that gets STRONGER with experience (explicit or
 * co-occurrence reinforcement) and otherwise stays put -- it does not fade
 * on its own the way recall salience does. This mirrors how associative
 * memory in humans solidifies with repetition rather than decaying with
 * the clock; two ideas linked once and never revisited don't spontaneously
 * become "unlinked," they just stay weakly linked.
 */

export interface AssociationEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
  reinforcedCount: number;
  createdAt: string;
  lastReinforcedAt: string;
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

/** Canonical, order-independent pair key so A-B and B-A reinforce the same edge. */
function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
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
        edges.push(JSON.parse(raw) as AssociationEdge);
      } catch {
        // Same resilience policy as the rest of the store: skip, never fail the whole read.
      }
    }
    return edges;
  }

  private async findEdge(from: string, to: string, relation: string): Promise<AssociationEdge | undefined> {
    const [a, b] = pairKey(from, to);
    const edges = await this.all();
    return edges.find((edge) => {
      const [ea, eb] = pairKey(edge.from, edge.to);
      return ea === a && eb === b && edge.relation === relation;
    });
  }

  private async save(edge: AssociationEdge): Promise<void> {
    await writeFile(this.filePath(edge.id), `${JSON.stringify(edge, null, 2)}\n`, "utf8");
  }

  async associate(from: string, to: string, relation: string, signal: "reinforce" | "weaken", implicit = false): Promise<AssociationEdge> {
    if (from === to) throw new Error("A memory cannot be associated with itself.");
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
      from,
      to,
      relation,
      weight: signal === "reinforce" ? reinforceWeight(DEFAULT_WEIGHT, rate) : weakenWeight(DEFAULT_WEIGHT, rate),
      reinforcedCount: 1,
      createdAt: now,
      lastReinforcedAt: now,
    };
    await this.save(edge);
    return edge;
  }

  /** Reinforce every pair among a set of co-retrieved memory IDs -- "fire together, wire together," gently. */
  async coReinforce(memoryIds: string[], relation = "co-occurs"): Promise<void> {
    for (let i = 0; i < memoryIds.length; i += 1) {
      for (let j = i + 1; j < memoryIds.length; j += 1) {
        await this.associate(memoryIds[i], memoryIds[j], relation, "reinforce", true);
      }
    }
  }

  /** Direct neighbors of one memory, ranked by weight (strongest association first). */
  async neighbors(memoryId: string, limit: number): Promise<Array<AssociationEdge & { neighborId: string }>> {
    const edges = await this.all();
    return edges
      .filter((edge) => edge.from === memoryId || edge.to === memoryId)
      .map((edge) => ({ ...edge, neighborId: edge.from === memoryId ? edge.to : edge.from }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /**
   * Short associative paths outward from one memory: direct neighbors, and
   * optionally one further hop (spreading activation), weight-discounted
   * per hop and deduplicated against anything already reached.
   */
  async walk(memoryId: string, depth: 1 | 2, limit: number): Promise<Array<{ memoryId: string; weight: number; viaRelation: string; hops: 1 | 2 }>> {
    const direct = await this.neighbors(memoryId, limit);
    const reached = new Map<string, { memoryId: string; weight: number; viaRelation: string; hops: 1 | 2 }>();
    for (const edge of direct) {
      reached.set(edge.neighborId, { memoryId: edge.neighborId, weight: edge.weight, viaRelation: edge.relation, hops: 1 });
    }
    if (depth === 2) {
      for (const edge of direct) {
        const secondHop = await this.neighbors(edge.neighborId, limit);
        for (const hop2 of secondHop) {
          if (hop2.neighborId === memoryId || reached.has(hop2.neighborId)) continue;
          const discounted = edge.weight * hop2.weight; // spreading activation loses strength per hop
          reached.set(hop2.neighborId, { memoryId: hop2.neighborId, weight: discounted, viaRelation: `${edge.relation}->${hop2.relation}`, hops: 2 });
        }
      }
    }
    return [...reached.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
  }
}
