import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AssociationStore } from "../src/associations.js";

async function freshStore(): Promise<{ store: AssociationStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "mymem-assoc-test-"));
  const store = new AssociationStore(dir);
  await store.initialize();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("associate refuses to link a memory to itself", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const id = randomUUID();
    await assert.rejects(() => store.associate(id, id, "related_to", "reinforce"));
  } finally {
    await cleanup();
  }
});

test("repeated reinforcement shows diminishing returns and never reaches 1", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    let last = 0;
    let lastDelta = Infinity;
    for (let i = 0; i < 20; i += 1) {
      const edge = await store.associate(a, b, "related_to", "reinforce");
      const delta = edge.weight - last;
      if (i > 0) assert.ok(delta <= lastDelta + 1e-9, "each successive reinforcement should add no more than the last");
      last = edge.weight;
      lastDelta = delta;
    }
    assert.ok(last < 1);
  } finally {
    await cleanup();
  }
});

test("weaken moves weight down and never below the floor", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    const reinforced = await store.associate(a, b, "related_to", "reinforce");
    let weight = reinforced.weight;
    for (let i = 0; i < 50; i += 1) {
      const edge = await store.associate(a, b, "related_to", "weaken");
      assert.ok(edge.weight <= weight);
      weight = edge.weight;
    }
    assert.ok(weight >= 0.05);
  } finally {
    await cleanup();
  }
});

test("association is order-independent: A->B and B->A reuse the same edge", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    const first = await store.associate(a, b, "related_to", "reinforce");
    const second = await store.associate(b, a, "related_to", "reinforce");
    assert.equal(first.id, second.id);
    assert.equal(second.reinforcedCount, 2);
    const all = await store.all();
    assert.equal(all.length, 1, "order-independence must not create a duplicate edge");
  } finally {
    await cleanup();
  }
});

test("different relations between the same pair create separate edges", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    await store.associate(a, b, "inspired_by", "reinforce");
    await store.associate(a, b, "co-occurs", "reinforce");
    const all = await store.all();
    assert.equal(all.length, 2);
  } finally {
    await cleanup();
  }
});

test("neighbors ranks by weight, strongest first", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await store.associate(a, b, "related_to", "reinforce");
    await store.associate(a, c, "related_to", "reinforce");
    await store.associate(a, c, "related_to", "reinforce"); // reinforce c a second time so it outranks b
    const neighbors = await store.neighbors(a, 10);
    assert.equal(neighbors.length, 2);
    assert.equal(neighbors[0].neighborId, c);
    assert.equal(neighbors[1].neighborId, b);
  } finally {
    await cleanup();
  }
});

test("walk depth=2 discounts weight per hop and excludes the origin and depth-1 neighbors", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const edgeAB = await store.associate(a, b, "related_to", "reinforce");
    const edgeBC = await store.associate(b, c, "related_to", "reinforce");

    const depth1 = await store.walk(a, 1, 10);
    assert.equal(depth1.length, 1);
    assert.equal(depth1[0].memoryId, b);

    const depth2 = await store.walk(a, 2, 10);
    const viaC = depth2.find((entry) => entry.memoryId === c);
    assert.ok(viaC, "c should be reachable at depth 2 via b");
    assert.equal(viaC?.hops, 2);
    assert.ok(Math.abs(viaC!.weight - edgeAB.weight * edgeBC.weight) < 1e-9);
    assert.ok(!depth2.some((entry) => entry.memoryId === a), "the origin must never appear in its own walk");
  } finally {
    await cleanup();
  }
});

test("coReinforce links every pair among a set of co-retrieved memories", async () => {
  const { store, cleanup } = await freshStore();
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await store.coReinforce(ids);
    const all = await store.all();
    assert.equal(all.length, 3, "three memories co-retrieved together should produce 3 pairwise edges");
    assert.ok(all.every((edge) => edge.relation === "co-occurs"));
  } finally {
    await cleanup();
  }
});
