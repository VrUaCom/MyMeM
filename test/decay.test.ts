import assert from "node:assert/strict";
import { test } from "node:test";
import { currentWeight, decayFactor, reinforce, tierFor } from "../src/decay.js";

test("tierFor buckets salience into hot/warm/cold", () => {
  assert.equal(tierFor(0.9), "hot");
  assert.equal(tierFor(0.7), "hot");
  assert.equal(tierFor(0.5), "warm");
  assert.equal(tierFor(0.3), "warm");
  assert.equal(tierFor(0.1), "cold");
  assert.equal(tierFor(0), "cold");
});

test("decayFactor is 1 at zero elapsed days regardless of tier", () => {
  assert.equal(decayFactor(0.9, 0), 1);
  assert.equal(decayFactor(0.5, 0), 1);
  assert.equal(decayFactor(0.1, 0), 1);
});

test("decayFactor shrinks as days pass, and hot memories decay slower than cold ones", () => {
  const hotAfter30 = decayFactor(0.9, 30);
  const coldAfter30 = decayFactor(0.1, 30);
  assert.ok(hotAfter30 < 1 && hotAfter30 > 0);
  assert.ok(coldAfter30 < hotAfter30, "cold-tier memories should decay faster than hot-tier ones over the same span");
});

test("decayFactor never goes negative or NaN for large day spans", () => {
  const factor = decayFactor(0.05, 10_000);
  assert.ok(Number.isFinite(factor));
  assert.ok(factor >= 0);
});

test("currentWeight combines salience and decay, dropping over time", () => {
  const now = Date.parse("2026-01-31T00:00:00.000Z");
  const fresh = currentWeight(0.6, "2026-01-31T00:00:00.000Z", now);
  const stale = currentWeight(0.6, "2025-01-01T00:00:00.000Z", now);
  assert.equal(fresh, 0.6);
  assert.ok(stale < fresh);
});

test("reinforce raises salience but caps at 1", () => {
  assert.equal(reinforce(0.6, 0.2), 0.8);
  assert.equal(reinforce(0.95, 0.2), 1);
  assert.equal(reinforce(1, 0.5), 1);
});
