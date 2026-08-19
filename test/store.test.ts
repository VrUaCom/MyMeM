import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryStore } from "../src/store.js";

async function freshStore(): Promise<{ store: MemoryStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "mymem-store-test-"));
  const store = new MemoryStore(dir);
  await store.initialize();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("remember/get round-trips a record with defaults filled in", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const record = await store.remember({ content: "hello", kind: "fact", sourceAgent: "test", sourceDevice: "test", tags: [] });
    assert.equal(record.salience, 0.6);
    const fetched = await store.get(record.id);
    assert.equal(fetched.content, "hello");
  } finally {
    await cleanup();
  }
});

test("recall ranks lexically-matching memories above unrelated ones", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.remember({ content: "MyMeM associative layer design", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    await store.remember({ content: "grocery list eggs milk bread", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    const results = await store.recall("associative layer", { limit: 10 });
    assert.ok(results.length >= 1);
    assert.match(results[0].content, /associative layer/);
  } finally {
    await cleanup();
  }
});

test("recall with empty query returns everything, highest weight first, and never crashes on an empty store", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const empty = await store.recall("", { limit: 10 });
    assert.deepEqual(empty, []);
    const a = await store.remember({ content: "a", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    await store.remember({ content: "b", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    await store.reinforceMemory(a.id, 0.3);
    const all = await store.recall("", { limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(all[0].id, a.id, "reinforced memory should rank first when query is empty");
  } finally {
    await cleanup();
  }
});

test("reinforceMemory raises salience and refreshes lastAccessedAt", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const record = await store.remember({ content: "x", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    const before = record.lastAccessedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reinforced = await store.reinforceMemory(record.id, 0.2);
    assert.equal(reinforced.salience, 0.8);
    assert.notEqual(reinforced.lastAccessedAt, before);
  } finally {
    await cleanup();
  }
});

test("supersede preserves the original, closes its validity window, and links to the replacement", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const original = await store.remember({ content: "old fact", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    const { old, replacement } = await store.supersede(original.id, "new fact", "correction", { sourceAgent: "t", sourceDevice: "t" });
    assert.equal(old.supersededBy, replacement.id);
    assert.equal(replacement.supersedes, old.id);
    assert.ok(old.validUntil);
    const current = await store.recall("fact", { limit: 10 });
    assert.equal(current.length, 1, "superseded record must not appear in current recall");
    assert.equal(current[0].id, replacement.id);
  } finally {
    await cleanup();
  }
});

test("supersede refuses to double-supersede the same memory", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const original = await store.remember({ content: "old", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    await store.supersede(original.id, "new", "reason", { sourceAgent: "t", sourceDevice: "t" });
    await assert.rejects(() => store.supersede(original.id, "newer", "reason2", { sourceAgent: "t", sourceDevice: "t" }));
  } finally {
    await cleanup();
  }
});

test("recallAsOf answers what was true at a past timestamp via the supersede chain", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const original = await store.remember({ content: "v1", kind: "fact", sourceAgent: "t", sourceDevice: "t", tags: [] });
    const t1 = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.supersede(original.id, "v2", "reason", { sourceAgent: "t", sourceDevice: "t" });

    const asOfNow = await store.recallAsOf(new Date().toISOString(), { limit: 10 });
    assert.equal(asOfNow.length, 1);
    assert.equal(asOfNow[0].content, "v2");

    const asOfT1 = await store.recallAsOf(t1, { limit: 10 });
    assert.equal(asOfT1.length, 1);
    assert.equal(asOfT1[0].content, "v1");
  } finally {
    await cleanup();
  }
});

test("pin/coreMemory/unpin round-trip a core memory block", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.pin("current-focus", "testing mymem", "test");
    const blocks = await store.coreMemory();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].content, "testing mymem");
    await store.unpin("current-focus");
    assert.deepEqual(await store.coreMemory(), []);
  } finally {
    await cleanup();
  }
});

test("pin rejects a name with no alphanumeric characters", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await assert.rejects(() => store.pin("***", "content", "test"));
  } finally {
    await cleanup();
  }
});

test("known limitation: block names that sanitize to the same slug collide", async () => {
  // "current focus" and "CURRENT-FOCUS" both sanitize to "current-focus" and
  // therefore address the same file. This is documented, expected behavior
  // (pin is intentionally idempotent by name), not a bug -- this test exists
  // so a future change to blockPath()'s sanitization can't silently alter it.
  const { store, cleanup } = await freshStore();
  try {
    await store.pin("current focus", "first", "test");
    await store.pin("CURRENT-FOCUS", "second", "test");
    const blocks = await store.coreMemory();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].content, "second");
  } finally {
    await cleanup();
  }
});
