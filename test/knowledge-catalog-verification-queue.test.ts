import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  isRetryableKnowledgeCatalogVerification,
  knowledgeCatalogRetryDelaySeconds,
} from "../src/knowledge-catalog/policy.js";

test("Knowledge Catalog source retries use bounded exponential backoff", () => {
  assert.equal(knowledgeCatalogRetryDelaySeconds(1), 300);
  assert.equal(knowledgeCatalogRetryDelaySeconds(2), 600);
  assert.equal(knowledgeCatalogRetryDelaySeconds(3), 1200);
  assert.equal(knowledgeCatalogRetryDelaySeconds(10), 3600);
});

test("only transient official-source failures are retried", () => {
  assert.equal(
    isRetryableKnowledgeCatalogVerification({
      status: "error",
      httpStatus: 429,
      message: "rate limited",
    }),
    true,
  );
  assert.equal(
    isRetryableKnowledgeCatalogVerification({
      status: "error",
      httpStatus: 503,
      message: "upstream",
    }),
    true,
  );
  assert.equal(
    isRetryableKnowledgeCatalogVerification({ status: "error", message: "request timeout" }),
    true,
  );
  assert.equal(
    isRetryableKnowledgeCatalogVerification({
      status: "not_found",
      httpStatus: 404,
      message: "missing",
    }),
    false,
  );
  assert.equal(
    isRetryableKnowledgeCatalogVerification({
      status: "error",
      message: "Too many subrequests",
    }),
    false,
  );
});
