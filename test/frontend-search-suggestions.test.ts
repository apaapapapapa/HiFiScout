import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { MAX_SUGGEST_QUERY_LENGTH, MAX_SUGGESTIONS } from "../src/api/contracts.js";
import { isSuggestResponse } from "../frontend/api-client.js";
import { suggestionRequestPath } from "../frontend/search-suggestions.js";

test("browser suggestion requests share endpoint normalization and bounds", () => {
  assert.equal(suggestionRequestPath("P"), null);
  assert.equal(suggestionRequestPath("PM"), null);
  assert.equal(suggestionRequestPath(" ＰＭ   14s1 "), "/api/suggest?q=PM%2014s1");
  assert.equal(suggestionRequestPath("x".repeat(MAX_SUGGEST_QUERY_LENGTH + 1)), null);
});

test("browser accepts only bounded string suggestion payloads", () => {
  assert.equal(isSuggestResponse({ suggestions: ["Marantz PM-14S1", "Marantz"] }), true);
  assert.equal(isSuggestResponse({ suggestions: ["Marantz", 14] }), false);
  assert.equal(
    isSuggestResponse({
      suggestions: Array.from({ length: MAX_SUGGESTIONS + 1 }, (_, i) => `M${i}`),
    }),
    false,
  );
});
