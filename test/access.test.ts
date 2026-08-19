import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/access.js";

async function freshStore(): Promise<{ store: AccessStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "mymem-access-test-"));
  const store = new AccessStore(dir);
  await store.initialize();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("first access creates a record with accessCount 1", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const record = await store.track("/Users/x/notes.md", "test-hook");
    assert.equal(record.accessCount, 1);
    assert.equal(record.ref, "/Users/x/notes.md");
    assert.equal(record.source, "test-hook");
  } finally {
    await cleanup();
  }
});

test("repeated access on the same ref increments accessCount and raises salience with diminishing returns", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const first = await store.track("/Users/x/notes.md", "test-hook");
    const second = await store.track("/Users/x/notes.md", "test-hook");
    const third = await store.track("/Users/x/notes.md", "test-hook");
    assert.deepEqual([first.accessCount, second.accessCount, third.accessCount], [1, 2, 3]);
    const delta1 = second.salience - first.salience;
    const delta2 = third.salience - second.salience;
    assert.ok(delta2 < delta1, "each successive access should raise salience by a shrinking amount");
  } finally {
    await cleanup();
  }
});

test("different refs get independent records", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.track("/Users/x/a.md", "test-hook");
    await store.track("/Users/x/a.md", "test-hook");
    const b = await store.track("/Users/x/b.md", "test-hook");
    assert.equal(b.accessCount, 1, "a different ref must not share a's access count");
  } finally {
    await cleanup();
  }
});

test("weight is undefined for a ref that was never tracked, defined after tracking", async () => {
  const { store, cleanup } = await freshStore();
  try {
    assert.equal(await store.weight("/never/tracked.md"), undefined);
    await store.track("/Users/x/a.md", "test-hook");
    const weight = await store.weight("/Users/x/a.md");
    assert.ok(typeof weight === "number" && weight > 0);
  } finally {
    await cleanup();
  }
});

test("refs with path separators and special characters don't collide or escape the store directory", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = await store.track("../../etc/passwd", "test-hook");
    const b = await store.track("/etc/passwd", "test-hook");
    assert.equal(a.accessCount, 1);
    assert.equal(b.accessCount, 1, "these are different refs and must not collide into one record");
  } finally {
    await cleanup();
  }
});
