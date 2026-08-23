import assert from "node:assert/strict";
import test from "node:test";

import { KNOWLEDGE_CATALOG_EXPORT_GENERATION_DEADLINE_HOURS } from "../src/db/knowledge-catalog-export-job-repository.js";
import { PRODUCT_AUDIT_EXPORT_GENERATION_DEADLINE_HOURS } from "../src/db/product-audit-export-job-repository.js";

test("export generation deadlines remain explicit 24-hour production limits", () => {
  assert.equal(KNOWLEDGE_CATALOG_EXPORT_GENERATION_DEADLINE_HOURS, 24);
  assert.equal(PRODUCT_AUDIT_EXPORT_GENERATION_DEADLINE_HOURS, 24);
});
