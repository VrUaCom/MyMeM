import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentWeight, reinforce as bumpSalience } from "./decay.js";
import { TfIdfIndex } from "./similarity.js";

export type MemoryKind = "fact" | "decision" | "preference" | "todo";

export interface MemoryRecord {
  id: string;
  content: string;
  kind: MemoryKind;
  sourceAgent: string;
  sourceDevice: string;
  tags: string[];
  confidence?: number;
  createdAt: string;
  supersedes?: string;
  supersededBy?: string;
  supersededReason?: string;
  /** Decay + reinforcement (OpenMemory-style, see Wave 4 research). 0..1, default 0.6. */
  salience: number;
  lastAccessedAt: string;
  /** Bi-temporal fields (Zep/Graphiti-style, see get_ai_context review). */
  validFrom: string;
  validUntil?: string;
}

export interface CoreMemoryBlock {
  name: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_SALIENCE = 0.6;

/**
 * One JSON file per memory (not one big array) so two devices editing
 * different memories never conflict on the same file when this directory
 * is synced through git. Records are never deleted -- mymem_supersede
 * writes a new record and patches the old one's supersededBy field.
 */
export class MemoryStore {
  private readonly dir: string;
  private readonly coreDir: string;

  constructor(homeDir: string) {
    this.dir = path.join(homeDir, "memories");
    this.coreDir = path.join(homeDir, "core");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.coreDir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async remember(input: Omit<MemoryRecord, "id" | "createdAt" | "salience" | "lastAccessedAt" | "validFrom">): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: randomUUID(),
      createdAt: now,
      salience: DEFAULT_SALIENCE,
      lastAccessedAt: now,
      validFrom: now,
      ...input,
    };
    await writeFile(this.filePath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }

  async get(id: string): Promise<MemoryRecord> {
    const raw = await readFile(this.filePath(id), "utf8");
    return JSON.parse(raw) as MemoryRecord;
  }

  private async save(record: MemoryRecord): Promise<void> {
    await writeFile(this.filePath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async all(): Promise<MemoryRecord[]> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    const records: MemoryRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, entry.name), "utf8");
        records.push(JSON.parse(raw) as MemoryRecord);
      } catch {
        // A partially-written or corrupt file (e.g. mid-sync) is skipped,
        // never treated as fatal -- memory reads must stay resilient.
      }
    }
    return records;
  }

  /** Ranked by decay-adjusted weight * lexical similarity, not a flat filter. */
  async recall(query: string, opts: { kind?: MemoryKind; sourceAgent?: string; limit: number }): Promise<Array<MemoryRecord & { score: number }>> {
    const records = (await this.all())
      .filter((record) => !record.supersededBy) // only current, non-superseded state
      .filter((record) => (opts.kind ? record.kind === opts.kind : true))
      .filter((record) => (opts.sourceAgent ? record.sourceAgent === opts.sourceAgent : true));

    const needle = query.trim();
    const index = new TfIdfIndex(records.map((r) => `${r.content} ${r.tags.join(" ")}`));
    const now = Date.now();

    const scored = records.map((record) => {
      const weight = currentWeight(record.salience, record.lastAccessedAt, now);
      const similarity = needle ? index.similarity(needle, `${record.content} ${record.tags.join(" ")}`) : 1;
      const exactBonus = needle && record.content.toLowerCase().includes(needle.toLowerCase()) ? 0.3 : 0;
      const relevance = needle ? Math.min(1, similarity + exactBonus) : 1;
      return { ...record, score: relevance * weight };
    });

    return scored
      .filter((record) => !needle || record.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }

  /** Reinforcement: recall hits and explicit confirmations both raise salience and refresh lastAccessedAt. */
  async reinforceMemory(id: string, boost = 0.2): Promise<MemoryRecord> {
    const record = await this.get(id);
    record.salience = bumpSalience(record.salience, boost);
    record.lastAccessedAt = new Date().toISOString();
    await this.save(record);
    return record;
  }

  async listRecent(opts: { since?: string; sourceDevice?: string; limit: number }): Promise<MemoryRecord[]> {
    const records = await this.all();
    return records
      .filter((record) => (opts.since ? record.createdAt > opts.since : true))
      .filter((record) => (opts.sourceDevice ? record.sourceDevice === opts.sourceDevice : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit);
  }

  /**
   * Bi-temporal query: "what was true as of asOf". Walks each
   * supersede-chain to the version whose [validFrom, validUntil) window
   * covers asOf, rather than just returning the current head.
   */
  async recallAsOf(asOf: string, opts: { kind?: MemoryKind; limit: number }): Promise<MemoryRecord[]> {
    const records = await this.all();
    const matches = records.filter((record) => {
      if (opts.kind && record.kind !== opts.kind) return false;
      const withinStart = record.validFrom <= asOf;
      const withinEnd = !record.validUntil || asOf < record.validUntil;
      return withinStart && withinEnd;
    });
    return matches.sort((a, b) => b.validFrom.localeCompare(a.validFrom)).slice(0, opts.limit);
  }

  async supersede(memoryId: string, replacementContent: string, reason: string, actor: { sourceAgent: string; sourceDevice: string }): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    const old = await this.get(memoryId);
    if (old.supersededBy) {
      throw new Error(`Memory ${memoryId} was already superseded by ${old.supersededBy}.`);
    }
    const now = new Date().toISOString();
    const replacement = await this.remember({
      content: replacementContent,
      kind: old.kind,
      sourceAgent: actor.sourceAgent,
      sourceDevice: actor.sourceDevice,
      tags: old.tags,
      supersedes: old.id,
    });
    old.supersededBy = replacement.id;
    old.supersededReason = reason;
    old.validUntil = now;
    await this.save(old);
    return { old, replacement };
  }

  // --- Core memory blocks (Letta/MemGPT-style always-included tier) ---

  private blockPath(name: string): string {
    const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safe) throw new Error("Core memory block name must contain at least one alphanumeric character.");
    return path.join(this.coreDir, `${safe}.json`);
  }

  async pin(name: string, content: string, updatedBy: string): Promise<CoreMemoryBlock> {
    const block: CoreMemoryBlock = { name, content, updatedAt: new Date().toISOString(), updatedBy };
    await writeFile(this.blockPath(name), `${JSON.stringify(block, null, 2)}\n`, "utf8");
    return block;
  }

  async unpin(name: string): Promise<void> {
    await rm(this.blockPath(name), { force: true });
  }

  async coreMemory(): Promise<CoreMemoryBlock[]> {
    const entries = await readdir(this.coreDir, { withFileTypes: true }).catch(() => []);
    const blocks: CoreMemoryBlock[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.coreDir, entry.name), "utf8");
        blocks.push(JSON.parse(raw) as CoreMemoryBlock);
      } catch {
        // Same resilience policy as memories: skip a corrupt block, never fail the whole read.
      }
    }
    return blocks.sort((a, b) => a.name.localeCompare(b.name));
  }
}
