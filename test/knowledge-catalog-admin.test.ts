import assert from "node:assert/strict";
import test from "node:test";

import { catalogAdminCategoryIds } from "../src/db/knowledge-catalog-admin-repository.js";
import {
  parseKnowledgeCatalogAdminListQuery,
  parseKnowledgeCatalogAdminUpdate,
} from "../src/http/knowledge-catalog-admin.js";

test("catalog admin list query validates and canonicalizes filters", () => {
  const url = new URL(
    "https://example.test/api/admin/knowledge-catalog/products?q=D-1000&manufacturerId=LUXMAN&categoryId=turntable&afterId=12&limit=25",
  );
  assert.deepEqual(parseKnowledgeCatalogAdminListQuery(url), {
    query: "D-1000",
    manufacturerId: "luxman",
    categoryId: "turntable",
    afterId: 12,
    limit: 25,
  });
});

test("catalog admin list query rejects invalid pagination and category", () => {
  assert.equal(
    parseKnowledgeCatalogAdminListQuery(
      new URL("https://example.test/api/admin/knowledge-catalog/products?limit=101"),
    ),
    null,
  );
  assert.equal(
    parseKnowledgeCatalogAdminListQuery(
      new URL(
        "https://example.test/api/admin/knowledge-catalog/products?categoryId=not-a-category",
      ),
    ),
    null,
  );
});

test("catalog admin update accepts only canonical leaf categories", () => {
  assert.deepEqual(
    parseKnowledgeCatalogAdminUpdate({
      canonicalName: "  LUXMAN D-1000  ",
      lifecycleStatus: "discontinued",
      primaryCategoryId: "turntable",
    }),
    {
      canonicalName: "LUXMAN D-1000",
      lifecycleStatus: "discontinued",
      primaryCategoryId: "turntable",
    },
  );

  assert.equal(
    parseKnowledgeCatalogAdminUpdate({
      canonicalName: "Example",
      lifecycleStatus: "active",
      primaryCategoryId: "analog",
    }),
    null,
  );
  assert.equal(
    parseKnowledgeCatalogAdminUpdate({
      canonicalName: "Example",
      lifecycleStatus: "retired",
      primaryCategoryId: "turntable",
    }),
    null,
  );
});

test("catalog admin category propagation stores the leaf and its search ancestors", () => {
  assert.deepEqual(catalogAdminCategoryIds("turntable"), ["turntable", "analog"]);
  assert.deepEqual(catalogAdminCategoryIds("analog"), []);
});
