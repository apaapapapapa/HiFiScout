import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseFtsSearchQuery, quoteFtsTerm } from "../src/search/fts-query.js";

test("multi-word search uses a conjunctive escaped FTS5 expression", () => {
  const parsed = parseFtsSearchQuery("TAD 1000");
  assert.deepEqual(parsed.ftsTerms, ["TAD", "1000"]);
  assert.deepEqual(parsed.shortTerms, []);
  assert.equal(parsed.ftsQuery, '"TAD" AND "1000"');
});

test("FTS syntax from user input is always quoted instead of concatenated as operators", () => {
  const parsed = parseFtsSearchQuery('TAD OR "D1000"*');
  assert.deepEqual(parsed.shortTerms, ["OR"]);
  assert.equal(parsed.ftsQuery, '"TAD" AND """D1000""*"');
});

test("short tokens stay out of trigram MATCH and can be handled with LIKE", () => {
  const parsed = parseFtsSearchQuery("SE TAD");
  assert.deepEqual(parsed.shortTerms, ["SE"]);
  assert.deepEqual(parsed.ftsTerms, ["TAD"]);
  assert.equal(parsed.ftsQuery, '"TAD"');
});

test("quoteFtsTerm doubles embedded quotes", () => {
  assert.equal(quoteFtsTerm('a"b'), '"a""b"');
});
