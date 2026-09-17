import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeQuery,
  tokenizeQuery,
  meaningfulQueryTerms,
  levenshtein,
  maxEditDistance,
  findAllPositions,
  findMinSpan,
} from "../src/search-utils.ts";

// ── sanitizeQuery ────────────────────────────────────────

test("sanitizeQuery: strips FTS5 special chars and quotes terms", () => {
  const out = sanitizeQuery('hello (world) *foo*');
  assert.ok(!out.includes("("));
  assert.ok(!out.includes("*"));
  assert.ok(out.includes('"hello"'));
  assert.ok(out.includes('"world"'));
});

test("sanitizeQuery: OR mode default joins with OR", () => {
  const out = sanitizeQuery("alpha beta");
  assert.equal(out, '"alpha" OR "beta"');
});

test("sanitizeQuery: AND mode joins with space", () => {
  const out = sanitizeQuery("alpha beta", "AND");
  assert.equal(out, '"alpha" "beta"');
});

test("sanitizeQuery: drops FTS operators AND/OR/NOT/NEAR", () => {
  const out = sanitizeQuery("alpha AND beta");
  assert.equal(out, '"alpha" OR "beta"');
});

test("sanitizeQuery: empty/operator-only query becomes empty phrase", () => {
  assert.equal(sanitizeQuery("AND OR"), '""');
  assert.equal(sanitizeQuery("   "), '""');
});

test("sanitizeQuery: dedupes repeated words", () => {
  assert.equal(sanitizeQuery("foo foo bar"), '"foo" OR "bar"');
});

// ── tokenizeQuery / meaningfulQueryTerms ─────────────────

test("tokenizeQuery: splits, lowers, dedupes, respects min length", () => {
  const terms = tokenizeQuery("Hello hello big World");
  assert.deepEqual(terms, ["hello", "big", "world"]);
  assert.ok(!terms.includes("a")); // length 1 < default minLength 2
});

test("meaningfulQueryTerms: filters stopwords but never returns empty", () => {
  // "the" is a stopword, "of" is not → filtered result is non-empty.
  assert.deepEqual(meaningfulQueryTerms("the of"), ["of"]);
  // All-stopword input → falls back to the unfiltered tokens.
  assert.deepEqual(meaningfulQueryTerms("the and"), ["the"]);
  const out = meaningfulQueryTerms("the database error");
  assert.ok(out.includes("database"));
  assert.ok(out.includes("error"));
});

// ── levenshtein / maxEditDistance ────────────────────────

test("levenshtein: classic distances", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("same", "same"), 0);
});

test("maxEditDistance: scales with word length", () => {
  assert.equal(maxEditDistance(3), 1);
  assert.equal(maxEditDistance(4), 1);
  assert.equal(maxEditDistance(8), 2);
  assert.equal(maxEditDistance(20), 3);
});

// ── position helpers ─────────────────────────────────────

test("findAllPositions: finds overlapping-adjacent occurrences", () => {
  assert.deepEqual(findAllPositions("ababab", "ab"), [0, 2, 4]);
  assert.deepEqual(findAllPositions("abc", "z"), []);
});

test("findMinSpan: minimal window covering all terms", () => {
  assert.equal(findMinSpan([[1, 10], [5, 20]]), 4); // 1..5
  assert.equal(findMinSpan([[1]]), 0);
  assert.equal(findMinSpan([]), Infinity);
});
