#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { estimateTokens } from "./tokens.js";
import { AssociationStore } from "./associations.js";
import { AccessStore } from "./access.js";

const home = process.env.MYMEM_HOME?.trim() || path.join(homedir(), ".mymem");
const store = new MemoryStore(home);
const associations = new AssociationStore(home);
const access = new AccessStore(home);
await store.initialize();
await associations.initialize();
await access.initialize();

const kind = z.enum(["fact", "decision", "preference", "todo"]);
const nodeType = z.enum(["memory", "core", "access"]);
const MEMORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a node reference actually resolves, without ever handing arbitrary caller text to a store that would build a file path from it unsanitized. */
async function nodeExists(type: "memory" | "core" | "access", id: string): Promise<boolean> {
  if (type === "memory") {
    if (!MEMORY_ID_PATTERN.test(id)) return false;
    return (await store.get(id).catch(() => undefined)) !== undefined;
  }
  if (type === "core") {
    return (await store.coreMemory()).some((block) => block.name === id);
  }
  return access.exists(id);
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer({ name: "mymem", version: "0.6.0" });

server.registerTool(
  "mymem_remember",
  {
    title: "Remember one memory",
    description: "Store one fact, decision, preference, or todo so any other AI agent on any device can recall it later. Content already recorded is never deleted -- to correct something, use mymem_supersede instead.",
    inputSchema: {
      content: z.string().min(1).max(10_000),
      kind,
      source_agent: z.string().min(1).max(200),
      source_device: z.string().min(1).max(200),
      tags: z.array(z.string().min(1).max(100)).max(50).default([]),
      confidence: z.number().min(0).max(1).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ content, kind: memoryKind, source_agent, source_device, tags, confidence }) => {
    try {
      const record = await store.remember({
        content,
        kind: memoryKind,
        sourceAgent: source_agent,
        sourceDevice: source_device,
        tags,
        confidence,
      });
      return jsonResult({ remembered: record });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_recall",
  {
    title: "Recall memories matching a query",
    description: "Ranked search over current (non-superseded) memories, combining lexical/TF-IDF similarity with decay-adjusted salience (recent + reinforced memories rank higher; stale ones fade but are never lost). Empty query returns the highest-weight memories.",
    inputSchema: {
      query: z.string().max(2_000).default(""),
      kind: kind.optional(),
      source_agent: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(20),
      reinforce_top_hit: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ query, kind: memoryKind, source_agent, limit, reinforce_top_hit }) => {
    try {
      const results = await store.recall(query, { kind: memoryKind, sourceAgent: source_agent, limit });
      if (reinforce_top_hit && results[0]) {
        await store.reinforceMemory(results[0].id);
      }
      return jsonResult({ results, count: results.length });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_reinforce",
  {
    title: "Reinforce a memory",
    description: "Explicitly confirm a memory is still relevant/true, raising its salience and resetting its decay clock. Use when another agent independently arrives at the same conclusion, or a memory proves useful.",
    inputSchema: {
      memory_id: z.string().uuid(),
      boost: z.number().min(0).max(1).default(0.2),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ memory_id, boost }) => {
    try {
      const record = await store.reinforceMemory(memory_id, boost);
      return jsonResult({ reinforced: record });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_list_recent",
  {
    title: "List recently remembered memories",
    description: "Cheap 'what changed since I last looked' -- lists memories created after a timestamp, optionally from one device, newest first.",
    inputSchema: {
      since: z.string().datetime().optional(),
      source_device: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, source_device, limit }) => {
    try {
      const results = await store.listRecent({ since, sourceDevice: source_device, limit });
      return jsonResult({ results, count: results.length });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_recall_as_of",
  {
    title: "Recall memory state as of a past date (bi-temporal)",
    description: "Answers 'what did we believe as of <date>', not just 'what's true now'. Walks each memory's supersede chain to the version whose validity window covered that timestamp.",
    inputSchema: {
      as_of: z.string().datetime(),
      kind: kind.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ as_of, kind: memoryKind, limit }) => {
    try {
      const results = await store.recallAsOf(as_of, { kind: memoryKind, limit });
      return jsonResult({ results, count: results.length, asOf: as_of });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_supersede",
  {
    title: "Supersede a memory with a correction",
    description: "Replace an outdated or wrong memory. The original is preserved and marked superseded, not deleted; the replacement links back to it. Closes the original's bi-temporal validity window.",
    inputSchema: {
      memory_id: z.string().uuid(),
      replacement_content: z.string().min(1).max(10_000),
      reason: z.string().min(1).max(2_000),
      source_agent: z.string().min(1).max(200),
      source_device: z.string().min(1).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ memory_id, replacement_content, reason, source_agent, source_device }) => {
    try {
      const result = await store.supersede(memory_id, replacement_content, reason, {
        sourceAgent: source_agent,
        sourceDevice: source_device,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_pin",
  {
    title: "Pin a core memory block",
    description: "Create or update a small, named, always-included memory block (Letta/MemGPT-style core memory) -- e.g. 'current-focus' or 'known-blockers'. Distinct from mymem_recall: core memory blocks are meant to be read on every task start via mymem_core_memory, not found by query.",
    inputSchema: {
      name: z.string().min(1).max(100),
      content: z.string().min(1).max(4_000),
      updated_by: z.string().min(1).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ name, content, updated_by }) => {
    try {
      const block = await store.pin(name, content, updated_by);
      return jsonResult({ pinned: block });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_unpin",
  {
    title: "Remove a core memory block",
    description: "Unpin a named core memory block. Unlike mymem_supersede, this is a real delete -- core memory blocks are working state (e.g. 'current sprint focus'), not durable facts, so nothing needs to be preserved when they stop applying.",
    inputSchema: { name: z.string().min(1).max(100) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ name }) => {
    try {
      await store.unpin(name);
      return jsonResult({ unpinned: name });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_core_memory",
  {
    title: "Read all core memory blocks",
    description: "Returns every pinned core memory block. Call this at the start of a task alongside mymem_recall -- core memory is the small always-relevant tier, recall is the queried tier.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const blocks = await store.coreMemory();
      return jsonResult({ blocks, count: blocks.length });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_associate",
  {
    title: "Associate or dissociate two nodes",
    description: "Create or change a stable, experience-based link between any two mymem nodes -- a memory, a core memory block, or a tracked access record. Distinct from decay/salience, which fades with time. Association weight only moves when reinforced or weakened (asymptotic: diminishing returns, approaches but never reaches full certainty or zero), never on its own. Use 'reinforce' when two things really do belong together, 'weaken' to correct a link that turned out wrong. from_type/to_type default to 'memory' for backward compatibility.",
    inputSchema: {
      from_id: z.string().min(1).max(2_000),
      from_type: nodeType.default("memory"),
      to_id: z.string().min(1).max(2_000),
      to_type: nodeType.default("memory"),
      relation: z.string().min(1).max(100).default("related_to"),
      signal: z.enum(["reinforce", "weaken"]).default("reinforce"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ from_id, from_type, to_id, to_type, relation, signal }) => {
    try {
      if (!(await nodeExists(from_type, from_id))) throw new Error(`from_id ${from_id} does not match any ${from_type} node.`);
      if (!(await nodeExists(to_type, to_id))) throw new Error(`to_id ${to_id} does not match any ${to_type} node.`);
      const edge = await associations.associate({ type: from_type, id: from_id }, { type: to_type, id: to_id }, relation, signal);
      return jsonResult({ association: edge });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_associations",
  {
    title: "Walk the associative layer from one node",
    description: "Short associative paths outward from one node (a memory, a core memory block, or a tracked access record), ranked by weight (strongest/most-experienced links first) -- not a text search, a graph walk. depth=1 is direct neighbors; depth=2 spreads one hop further (activation spreading), weight-discounted per hop. node_type defaults to 'memory' for backward compatibility.",
    inputSchema: {
      node_id: z.string().min(1).max(2_000),
      node_type: nodeType.default("memory"),
      depth: z.union([z.literal(1), z.literal(2)]).default(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ node_id, node_type, depth, limit }) => {
    try {
      const results = await associations.walk({ type: node_type, id: node_id }, depth, limit);
      return jsonResult({ results, count: results.length });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_get_context",
  {
    title: "Get bounded context for a task (primary entry point)",
    description: "The recommended first call for any task: one objective, one token budget, one response -- core memory blocks (always included, since they're small and meant to be known) plus ranked recall results filling the remaining budget. Mirrors the get_ai_context pattern from the sibling mcp-space-dmc-rengine server, so an agent already used to that workflow needs no new mental model here.",
    inputSchema: {
      objective: z.string().min(1).max(2_000),
      kind: kind.optional(),
      token_budget: z.number().int().min(256).max(8_000).default(1_500),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ objective, kind: memoryKind, token_budget }) => {
    try {
      const coreBlocks = await store.coreMemory();
      let usedTokens = 0;
      const core = [];
      for (const block of coreBlocks) {
        const cost = estimateTokens(block.content);
        if (usedTokens + cost > token_budget) continue; // skip, don't stop -- one oversized block must not silently exclude every smaller one that follows
        core.push(block);
        usedTokens += cost;
      }

      const remaining = Math.max(0, token_budget - usedTokens);
      const candidates = await store.recall(objective, { kind: memoryKind, limit: 100 });
      const relevant = [];
      let recallTokens = 0;
      for (const candidate of candidates) {
        const cost = estimateTokens(candidate.content);
        if (recallTokens + cost > remaining) continue; // skip, don't stop -- a later smaller-but-relevant memory can still fit
        relevant.push(candidate);
        recallTokens += cost;
      }
      // Every memory actually surfaced into a task context gets a small
      // reinforcement -- being retrieved repeatedly is itself a signal of
      // relevance (hippocampal-style consolidation, Wave 4/5 research: the
      // more often something is recalled, the better it "sticks"). Not just
      // the top hit -- everything that made it into the response.
      for (const memory of relevant) await store.reinforceMemory(memory.id, 0.05);

      // Associative layer: memories retrieved together for the same task
      // gently reinforce their co-occurrence link ("fire together, wire
      // together"), and the top hit's strongest existing associations
      // surface as a *separate* field -- things related by experience,
      // not by matching this particular query's wording.
      if (relevant.length > 1) await associations.coReinforce(relevant.map((memory) => memory.id));
      let associated: Array<{ nodeId: string; nodeType: "memory" | "core" | "access"; weight: number; viaRelation: string; hops: 1 | 2 }> = [];
      if (relevant[0]) {
        const neighbors = await associations.walk({ type: "memory", id: relevant[0].id }, 1, 10);
        const alreadyShown = new Set(relevant.map((memory) => memory.id));
        // associated_memories is specifically memories -- a core-memory-block or
        // access-record neighbor is a real association but doesn't fit this
        // field's MemoryRecord shape, so it's omitted here, not an error.
        associated = neighbors.filter((neighbor) => neighbor.nodeType === "memory" && !alreadyShown.has(neighbor.nodeId));
      }
      const associatedMemories = [];
      for (const link of associated) {
        try {
          const memory = await store.get(link.nodeId);
          if (!memory.supersededBy) associatedMemories.push({ ...memory, associationWeight: link.weight, viaRelation: link.viaRelation });
        } catch {
          // A dangling association (its memory file is gone) is skipped, not fatal.
        }
      }

      const totalTokens = usedTokens + recallTokens;
      return jsonResult({
        objective,
        core_memory: core,
        relevant_memories: relevant,
        associated_memories: associatedMemories,
        budget: {
          requested_tokens: token_budget,
          estimated_tokens: totalTokens,
          core_memory_tokens: usedTokens,
          recall_tokens: recallTokens,
          truncated: core.length < coreBlocks.length || relevant.length < candidates.length,
        },
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "mymem_track_access",
  {
    title: "Track an access to a document or memory (hippocampal-style consolidation)",
    description: "Signal that something was read again -- an external document/file, or an existing mymem memory. Repeated access raises its salience the same way mymem_reinforce does (asymptotic, never silently promotes something to fully trusted). Meant to be called from a client-side hook (e.g. a Claude Code PostToolUse hook on Read) so frequently-revisited context gets naturally 'stickier' without a manual mymem_remember every time. If ref matches an existing mymem memory id, this reinforces that memory directly; otherwise it tracks ref as a standalone access record.",
    inputSchema: {
      ref: z.string().min(1).max(2_000),
      source: z.string().min(1).max(200).default("hook"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ ref, source }) => {
    try {
      // ref is arbitrary caller-supplied text (a file path, a URL, anything a hook wants to
      // name) -- only treat it as a mymem memory id, and only then hand it to store.get(),
      // when it's actually shaped like the UUIDs mymem itself issues. Passing arbitrary text
      // straight into store.get() would let it build a file path outside the memories dir.
      const existingMemory = MEMORY_ID_PATTERN.test(ref) ? await store.get(ref).catch(() => undefined) : undefined;
      if (existingMemory) {
        const reinforced = await store.reinforceMemory(ref, 0.05);
        return jsonResult({ tracked: { kind: "memory", memory: reinforced } });
      }
      const record = await access.track(ref, source);
      return jsonResult({ tracked: { kind: "external-ref", record } });
    } catch (error) {
      return errorResult(error);
    }
  },
);

await server.connect(new StdioServerTransport());
