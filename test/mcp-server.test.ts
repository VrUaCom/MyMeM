import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end tests against the built server over real stdio MCP transport --
 * this is the only place we exercise the tool handlers in src/index.ts
 * themselves (budget-fitting, cross-tool wiring), rather than the stores
 * they call directly.
 */

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let client: Client;
let homeDir: string;

before(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "mymem-mcp-test-"));
  client = new Client({ name: "mymem-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env: { MYMEM_HOME: homeDir } });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await rm(homeDir, { recursive: true, force: true });
});

function unwrap(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const payload = unwrap(result);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  return payload;
}

test("mymem_get_context: a core memory block too large to fit does not exclude smaller blocks that come after it", async () => {
  // Regression test for the break-vs-continue budget-fitting bug: a single
  // oversized core block must be skipped, not treated as a reason to stop
  // considering every other block.
  await call("mymem_pin", { name: "huge-block", content: "x ".repeat(2000), updated_by: "test" });
  await call("mymem_pin", { name: "tiny-block", content: "small", updated_by: "test" });

  const ctx = await call("mymem_get_context", { objective: "irrelevant objective with no matches", token_budget: 300 });
  const names = ctx.core_memory.map((block: { name: string }) => block.name);
  assert.ok(names.includes("tiny-block"), "the small block should still be included even though the huge block does not fit");
  assert.ok(!names.includes("huge-block"), "the oversized block itself must still be excluded");

  await call("mymem_unpin", { name: "huge-block" });
  await call("mymem_unpin", { name: "tiny-block" });
});

test("mymem_get_context: relevant memories fill the remaining budget after core memory, and stay within budget", async () => {
  await call("mymem_pin", { name: "focus", content: "context budget test", updated_by: "test" });
  const remembered = await call("mymem_remember", {
    content: "MyMeM get_context fills the remaining token budget with ranked recall",
    kind: "fact",
    source_agent: "test",
    source_device: "test",
    tags: [],
  });

  const ctx = await call("mymem_get_context", { objective: "get_context remaining token budget", token_budget: 500 });
  assert.ok(ctx.relevant_memories.some((memory: { id: string }) => memory.id === remembered.remembered.id));
  assert.ok(ctx.budget.estimated_tokens <= 500);

  await call("mymem_unpin", { name: "focus" });
});

test("mymem_associate rejects an edge to a memory id that does not exist", async () => {
  const real = await call("mymem_remember", { content: "real memory", kind: "fact", source_agent: "test", source_device: "test", tags: [] });
  const fakeId = "00000000-0000-4000-8000-000000000000";

  await assert.rejects(() => call("mymem_associate", { from_id: real.remembered.id, to_id: fakeId }), /does not match any memory/);
});

test("mymem_get_context surfaces associatively-linked memories that the query text itself does not match", async () => {
  const a = await call("mymem_remember", { content: "zorbex quantifiable widget throughput", kind: "fact", source_agent: "test", source_device: "test", tags: [] });
  const b = await call("mymem_remember", { content: "penguins migrate south during winter months", kind: "fact", source_agent: "test", source_device: "test", tags: [] });
  await call("mymem_associate", { from_id: a.remembered.id, to_id: b.remembered.id, relation: "inspired_by" });

  const ctx = await call("mymem_get_context", { objective: "zorbex quantifiable widget throughput", token_budget: 2000 });
  assert.ok(!ctx.relevant_memories.some((memory: { id: string }) => memory.id === b.remembered.id), "test setup invalid: b matched directly by text");
  assert.ok(ctx.associated_memories.some((memory: { id: string }) => memory.id === b.remembered.id), "b should surface via the associative layer");
});

test("mymem_get_context reinforces every returned relevant memory, not just the top hit", async () => {
  const first = await call("mymem_remember", { content: "kryzon telemetry pipeline throughput benchmark", kind: "fact", source_agent: "test", source_device: "test", tags: [] });
  const second = await call("mymem_remember", { content: "kryzon telemetry pipeline latency benchmark", kind: "fact", source_agent: "test", source_device: "test", tags: [] });

  const ctx = await call("mymem_get_context", { objective: "kryzon telemetry pipeline benchmark", token_budget: 2000 });
  assert.ok(ctx.relevant_memories.length >= 2, "test setup invalid: expected both memories to be returned");

  const results = await call("mymem_recall", { query: "kryzon telemetry pipeline", limit: 10 });
  const firstAfter = results.results.find((m: { id: string }) => m.id === first.remembered.id);
  const secondAfter = results.results.find((m: { id: string }) => m.id === second.remembered.id);
  assert.equal(firstAfter.accessCount, 1, "first memory should have been reinforced by get_context even though it wasn't the top hit");
  assert.equal(secondAfter.accessCount, 1, "second memory should also have been reinforced");
});

test("mymem_track_access reinforces an existing mymem memory when ref is its id", async () => {
  const memory = await call("mymem_remember", { content: "tracked memory content", kind: "fact", source_agent: "test", source_device: "test", tags: [] });
  const before = await call("mymem_recall", { query: "tracked memory content", limit: 1 });
  assert.equal(before.results[0].accessCount, 0);

  const tracked = await call("mymem_track_access", { ref: memory.remembered.id, source: "test-hook" });
  assert.equal(tracked.tracked.kind, "memory");
  assert.equal(tracked.tracked.memory.accessCount, 1);
});

test("mymem_track_access tracks an external ref (not a mymem memory) as a standalone access record", async () => {
  const tracked1 = await call("mymem_track_access", { ref: "/Users/x/some-external-doc.md", source: "test-hook" });
  assert.equal(tracked1.tracked.kind, "external-ref");
  assert.equal(tracked1.tracked.record.accessCount, 1);

  const tracked2 = await call("mymem_track_access", { ref: "/Users/x/some-external-doc.md", source: "test-hook" });
  assert.equal(tracked2.tracked.record.accessCount, 2, "re-tracking the same external ref should increment, not reset");
});

test("mymem_track_access does not treat an arbitrary path-shaped ref as a memory id lookup", async () => {
  const tracked = await call("mymem_track_access", { ref: "../../etc/passwd", source: "test-hook" });
  assert.equal(tracked.tracked.kind, "external-ref", "a non-UUID ref must never be routed into store.get()");
});
