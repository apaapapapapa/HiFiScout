import assert from "node:assert/strict";
import test from "node:test";

import { listKnowledgeCatalogAdminCandidates } from "../src/db/knowledge-catalog-admin-operations.js";
import {
  catalogAdminCategoryIds,
  listKnowledgeCatalogAdminProducts,
} from "../src/db/knowledge-catalog-admin-repository.js";
import {
  parseKnowledgeCatalogAdminCreate,
  parseKnowledgeCatalogAdminListQuery,
  parseKnowledgeCatalogAdminMerge,
  parseKnowledgeCatalogAdminUpdate,
} from "../src/http/knowledge-catalog-admin.js";
import { captureDatabase } from "./helpers/d1.js";

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

test("catalog admin free-text search uses normalized model and aliases", async () => {
  const db = captureDatabase();
  await listKnowledgeCatalogAdminProducts(db, {
    query: "Ｄ－１０００",
    manufacturerId: "",
    categoryId: "",
    afterId: 0,
    limit: 50,
  });

  const { sql, binds } = db.calls[0];
  assert.match(sql, /INSTR\(LOWER\(kp\.normalized_model\), \?\)/);
  assert.match(sql, /FROM knowledge_catalog_aliases search_alias/);
  assert.match(sql, /INSTR\(LOWER\(search_alias\.normalized_alias\), \?\)/);
  assert.match(sql, /kp\.manufacturer_id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.doesNotMatch(sql, /\bLIKE\b/);
  assert.deepEqual(binds, [
    0,
    "d-1000",
    "d-1000",
    "d-1000",
    '["d-1000","d1000"]',
    "d1000",
    "d1000",
    "d-1000",
    "d1000",
    "d1000",
    51,
  ]);
});

test("catalog admin search removes model separators for fuzzy identity matching", async () => {
  const db = captureDatabase();
  await listKnowledgeCatalogAdminProducts(db, {
    query: "D 1000",
    manufacturerId: "",
    categoryId: "",
    afterId: 0,
    limit: 50,
  });

  assert.equal(db.calls[0].binds[1], "d 1000");
  assert.equal(db.calls[0].binds[5], "d1000");
});

test("catalog admin free-text manufacturer search includes legacy manufacturer ids", async () => {
  const db = captureDatabase();
  await listKnowledgeCatalogAdminProducts(db, {
    query: "mark-levinson",
    manufacturerId: "",
    categoryId: "",
    afterId: 0,
    limit: 50,
  });

  const ids = JSON.parse(String(db.calls[0].binds[4])) as string[];
  assert.ok(ids.includes("mark-levinson"));
  assert.ok(ids.includes("marklevinson"));
});

test("catalog admin manufacturer filter includes canonical and legacy ids", async () => {
  const db = captureDatabase();
  await listKnowledgeCatalogAdminProducts(db, {
    query: "",
    manufacturerId: "mark-levinson",
    categoryId: "",
    afterId: 0,
    limit: 50,
  });

  assert.match(db.calls[0].sql, /kp\.manufacturer_id IN \(SELECT value FROM json_each\(\?\)\)/);
  const ids = JSON.parse(String(db.calls[0].binds[1])) as string[];
  assert.ok(ids.includes("mark-levinson"));
  assert.ok(ids.includes("marklevinson"));
});

test("catalog admin pending candidate search uses manufacturer compatibility", async () => {
  const db = captureDatabase();
  await listKnowledgeCatalogAdminCandidates(db, {
    query: "mark-levinson",
    manufacturerId: "",
    categoryId: "",
    afterId: 0,
    limit: 50,
  });

  const { sql, binds } = db.calls[0];
  assert.match(sql, /kc\.review_status = 'pending'/);
  assert.match(sql, /kc\.manufacturer_id IN \(SELECT value FROM json_each\(\?\)\)/);
  const ids = JSON.parse(String(binds[5])) as string[];
  assert.ok(ids.includes("mark-levinson"));
  assert.ok(ids.includes("marklevinson"));
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

test("catalog admin manual create canonicalizes manufacturer and validates evidence URL", () => {
  assert.deepEqual(
    parseKnowledgeCatalogAdminCreate({
      manufacturerId: "Mark Levinson",
      canonicalModel: "  No.5101  ",
      canonicalName: "  MARK LEVINSON No.5101  ",
      lifecycleStatus: "active",
      primaryCategoryId: "turntable",
      sourceUrl: "https://example.test/evidence",
    }),
    {
      manufacturerId: "mark-levinson",
      canonicalModel: "No.5101",
      canonicalName: "MARK LEVINSON No.5101",
      lifecycleStatus: "active",
      primaryCategoryId: "turntable",
      sourceUrl: "https://example.test/evidence",
    },
  );

  assert.equal(
    parseKnowledgeCatalogAdminCreate({
      manufacturerId: "Mark Levinson",
      canonicalModel: "No.5101",
      canonicalName: "MARK LEVINSON No.5101",
      lifecycleStatus: "active",
      primaryCategoryId: "turntable",
      sourceUrl: "javascript:alert(1)",
    }),
    null,
  );
});

test("catalog admin manual merge accepts only positive product ids", () => {
  assert.deepEqual(parseKnowledgeCatalogAdminMerge({ sourceProductId: 42 }), {
    sourceProductId: 42,
  });
  assert.equal(parseKnowledgeCatalogAdminMerge({ sourceProductId: 0 }), null);
  assert.equal(parseKnowledgeCatalogAdminMerge({ sourceProductId: 1.5 }), null);
});

test("catalog admin category propagation stores the leaf and its search ancestors", () => {
  assert.deepEqual(catalogAdminCategoryIds("turntable"), ["turntable", "analog"]);
  assert.deepEqual(catalogAdminCategoryIds("analog"), []);
});
