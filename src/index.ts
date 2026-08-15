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

const server = new McpServer({ name: "mymem", version: "0.1.0" });

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
    description: "Keyword search over current (non-superseded) memories, most recent first.",
    inputSchema: {
      query: z.string().max(2_000).default(""),
      kind: kind.optional(),
      source_agent: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(20),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, kind: memoryKind, source_agent, limit }) => {
    try {
      const results = await store.recall(query, { kind: memoryKind, sourceAgent: source_agent, limit });
      return jsonResult({ results, count: results.length });
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
  "mymem_supersede",
  {
    title: "Supersede a memory with a correction",
    description: "Replace an outdated or wrong memory. The original is preserved and marked superseded, not deleted; the replacement links back to it.",
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

await server.connect(new StdioServerTransport());
