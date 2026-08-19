import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentWeight, reinforce as bumpSalience } from "./decay.js";

/**
 * Hippocampal-style consolidation for things that are not (yet) full mymem
 * memories -- an external document, a file path, anything a hook wants to
 * signal was "read again." Reuses decay.ts's exact salience/decay formula
 * (Wave 4 research) so a frequently-accessed ref behaves the same way a
 * frequently-reinforced memory does: it stays "hot" without manual tuning,
 * and an ignored ref just cools down -- never deleted, same as memories.
 */

export interface AccessRecord {
  ref: string;
  source: string;
  salience: number;
  accessCount: number;
  firstAccessedAt: string;
  lastAccessedAt: string;
}

const DEFAULT_SALIENCE = 0.3; // starts cooler than an explicit mymem_remember (0.6) -- an access signal is weaker evidence of relevance than a deliberate memory
const IMPLICIT_BOOST = 0.1;

/**
 * refs are arbitrary caller-supplied text (file paths, URLs, anything a hook
 * names) -- a lossy slug (like store.ts's blockPath) would let two different
 * refs collide onto the same file, silently merging their access counts. A
 * content hash of the exact ref has no such collision and can't escape this
 * store's directory the way an unsanitized path could.
 */
function fileKey(ref: string): string {
  return createHash("sha256").update(ref, "utf8").digest("hex");
}

export class AccessStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = path.join(homeDir, "access");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private filePath(ref: string): string {
    return path.join(this.dir, `${fileKey(ref)}.json`);
  }

  private async read(ref: string): Promise<AccessRecord | undefined> {
    try {
      const raw = await readFile(this.filePath(ref), "utf8");
      return JSON.parse(raw) as AccessRecord;
    } catch {
      return undefined;
    }
  }

  /** Record one access to `ref`. Creates the record on first access, reinforces it on every later one. */
  async track(ref: string, source: string): Promise<AccessRecord> {
    const now = new Date().toISOString();
    const existing = await this.read(ref);
    const record: AccessRecord = existing
      ? { ...existing, salience: bumpSalience(existing.salience, IMPLICIT_BOOST), accessCount: existing.accessCount + 1, lastAccessedAt: now }
      : { ref, source, salience: DEFAULT_SALIENCE, accessCount: 1, firstAccessedAt: now, lastAccessedAt: now };
    await writeFile(this.filePath(ref), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }

  /** Current decay-adjusted weight for a tracked ref, or undefined if it's never been accessed. */
  async weight(ref: string): Promise<number | undefined> {
    const record = await this.read(ref);
    if (!record) return undefined;
    return currentWeight(record.salience, record.lastAccessedAt);
  }

  /** Whether ref has ever been tracked -- used to validate an associative-layer edge that points at an access record. */
  async exists(ref: string): Promise<boolean> {
    return (await this.read(ref)) !== undefined;
  }
}
