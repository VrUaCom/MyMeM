#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./store.js";

const home = process.env.MYMEM_HOME?.trim() || path.join(homedir(), ".mymem");
const store = new MemoryStore(home);
await store.initialize();

const kind = z.enum(["fact", "decision", "preference", "todo"]);

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer({ name: "mymem", version: "0.2.0" });

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

await server.connect(new StdioServerTransport());
