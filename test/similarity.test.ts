import assert from "node:assert/strict";
import { test } from "node:test";
import { TfIdfIndex } from "../src/similarity.js";

test("identical text has similarity 1", () => {
  const index = new TfIdfIndex(["the quick brown fox jumps over the lazy dog"]);
  const score = index.similarity("quick brown fox", "quick brown fox");
  assert.ok(score > 0.99);
});

test("unrelated text has similarity close to 0", () => {
  const index = new TfIdfIndex(["MyMeM associative layer design", "grocery list eggs milk bread"]);
  const score = index.similarity("MyMeM associative layer design", "grocery list eggs milk bread");
  assert.ok(score < 0.1);
});

test("shared-vocabulary paraphrase scores between 0 and 1", () => {
  const index = new TfIdfIndex(["bounded context entry point token budget", "unrelated filler text about nothing"]);
  const score = index.similarity("bounded context entry point", "bounded context entry point token budget");
  assert.ok(score > 0 && score <= 1);
});

test("empty corpus and empty text never throw or produce NaN", () => {
  const index = new TfIdfIndex([]);
  const score = index.similarity("", "");
  assert.equal(Number.isNaN(score), false);
  assert.equal(score, 0);
});
