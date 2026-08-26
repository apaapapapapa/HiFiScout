import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  MAX_SUGGEST_QUERY_LENGTH,
  canonicalSuggestQueryUrl,
  parseSuggestQuery,
  validateSuggestQuery,
} from "../src/api/suggest-query.js";

test("suggest accepts only one bounded q parameter", () => {
  assert.equal(validateSuggestQuery(new URL("https://example.test/api/suggest?q=TAD")), null);
  assert.equal(
    validateSuggestQuery(new URL("https://example.test/api/suggest?q=TAD&q=ME1")),
    "q_repeated",
  );
  assert.equal(
    validateSuggestQuery(new URL("https://example.test/api/suggest?q=TAD&limit=1000")),
    "parameter_unknown",
  );
  assert.equal(
    validateSuggestQuery(
      new URL(`https://example.test/api/suggest?q=${"x".repeat(MAX_SUGGEST_QUERY_LENGTH + 1)}`),
    ),
    "q_too_long",
  );
});

test("suggest bounds raw and normalized code-point length", () => {
  const emoji = "🎧".repeat(MAX_SUGGEST_QUERY_LENGTH);
  assert.equal(
    validateSuggestQuery(
      new URL(`https://example.test/api/suggest?q=${encodeURIComponent(emoji)}`),
    ),
    null,
  );

  const expandsUnderNfkc = "㍿".repeat(MAX_SUGGEST_QUERY_LENGTH);
  assert.equal(
    validateSuggestQuery(
      new URL(`https://example.test/api/suggest?q=${encodeURIComponent(expandsUnderNfkc)}`),
    ),
    "q_too_long",
  );
});

test("suggest input and edge-cache URL are canonicalized", () => {
  const url = new URL("https://example.test/api/suggest?q=%EF%BC%B0%EF%BC%AD%20%20%2014s1");
  const query = parseSuggestQuery(url);
  assert.deepEqual(query, { q: "PM 14s1" });
  assert.equal(
    canonicalSuggestQueryUrl(url, query).toString(),
    "https://example.test/api/suggest?q=PM+14s1",
  );
});
