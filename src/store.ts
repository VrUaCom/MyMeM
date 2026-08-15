import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
}

/**
 * One JSON file per memory (not one big array) so two devices editing
 * different memories never conflict on the same file when this directory
 * is synced through git. Records are never deleted -- mymem_supersede
 * writes a new record and patches the old one's supersededBy field.
 */
export class MemoryStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = path.join(homeDir, "memories");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async remember(input: Omit<MemoryRecord, "id" | "createdAt">): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
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

  async recall(query: string, opts: { kind?: MemoryKind; sourceAgent?: string; limit: number }): Promise<MemoryRecord[]> {
    const needle = query.trim().toLowerCase();
    const records = await this.all();
    const scored = records
      .filter((record) => !record.supersededBy) // only current, non-superseded state
      .filter((record) => (opts.kind ? record.kind === opts.kind : true))
      .filter((record) => (opts.sourceAgent ? record.sourceAgent === opts.sourceAgent : true))
      .filter((record) => {
        if (!needle) return true;
        const haystack = `${record.content} ${record.tags.join(" ")}`.toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return scored.slice(0, opts.limit);
  }

  async listRecent(opts: { since?: string; sourceDevice?: string; limit: number }): Promise<MemoryRecord[]> {
    const records = await this.all();
    return records
      .filter((record) => (opts.since ? record.createdAt > opts.since : true))
      .filter((record) => (opts.sourceDevice ? record.sourceDevice === opts.sourceDevice : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit);
  }

  async supersede(memoryId: string, replacementContent: string, reason: string, actor: { sourceAgent: string; sourceDevice: string }): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    const old = await this.get(memoryId);
    if (old.supersededBy) {
      throw new Error(`Memory ${memoryId} was already superseded by ${old.supersededBy}.`);
    }
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
    await this.save(old);
    return { old, replacement };
  }
}
