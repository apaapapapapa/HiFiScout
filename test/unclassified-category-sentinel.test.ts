import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UNCLASSIFIED_CATEGORY_ID,
  categoryFacet,
  categoryFilterIds,
  categorySearchAliases,
  getCategory,
} from "../src/catalog/categories.js";
import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import { toProductSearchItem } from "../src/db/product-search-entity-mapper.js";
import { upsertCatalogEntitiesSql } from "../src/db/product-search-entity-sql.js";
import type { ProductSearchEntityRow } from "../src/db/types.js";

const migration = readFileSync(
  new URL("../migrations/0041_separate_unclassified_category_sentinel.sql", import.meta.url),
  "utf8",
);

function entityRow(primaryCategoryId: string): ProductSearchEntityRow {
  return {
    id: 1,
    entity_key: "l-1",
    entity_kind: "unresolved_listing",
    catalog_product_id: null,
    fallback_listing_id: 1,
    manufacturer_id: "example",
    manufacturer: "Example",
    model: "EX-1",
    normalized_model: "EX1",
    primary_category_id: primaryCategoryId,
    offer_count: 1,
    in_stock_offer_count: 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: 1000,
    lowest_in_stock_price_yen: 1000,
    highest_price_yen: 1000,
    latest_activity_at: null,
    newest_listed_at: null,
    has_price_drop: 0,
  };
}

test("an undecided classification answers the sentinel, not the other leaf", () => {
  const classification = classifyCategoryEvidence([]);
  assert.equal(classification.primaryCategoryId, UNCLASSIFIED_CATEGORY_ID);
  assert.equal(classification.classificationStatus, "unclassified");
  assert.equal(classification.displayName, "未分類");
});

test("the sentinel is a real definition but never a classifier target or a public filter", () => {
  const sentinel = getCategory(UNCLASSIFIED_CATEGORY_ID);
  assert.ok(sentinel, "the read model derives the label from the id, so it needs a definition");
  assert.equal(sentinel.name, "未分類");
  assert.equal(sentinel.classifiable, false);
  assert.equal(sentinel.filterable, false);
  assert.equal(categoryFacet(UNCLASSIFIED_CATEGORY_ID), null);
  assert.equal(categorySearchAliases([UNCLASSIFIED_CATEGORY_ID]), "");
});

test("filtering by その他 returns the real leaf only, never the unclassified backlog", () => {
  for (const filter of ["other", "その他"]) {
    const ids = categoryFilterIds(filter);
    assert.ok(ids.includes("other"), filter);
    assert.equal(ids.includes(UNCLASSIFIED_CATEGORY_ID), false, filter);
  }
});

test("search results say 未分類 instead of re-deriving その他 from the id", () => {
  const unclassified = toProductSearchItem(entityRow(UNCLASSIFIED_CATEGORY_ID));
  assert.equal(unclassified.category, "未分類");
  assert.deepEqual(unclassified.category_ids, []);

  const genuinelyOther = toProductSearchItem(entityRow("other"));
  assert.equal(genuinelyOther.category, "その他");
  assert.deepEqual(genuinelyOther.category_ids, ["other"]);
});

test("a verified catalog product without a category projects the sentinel", () => {
  assert.match(upsertCatalogEntitiesSql(), /\), 'unclassified'\),/);
});

test("the backfill selects unclassified listings by status, not by their category_ids shape", () => {
  const statements = migration.replace(/^\s*--.*$/gm, "");
  assert.match(statements, /WHERE classification_status = 'unclassified'/);
  assert.doesNotMatch(
    statements,
    /category_ids = '\[\]'/,
    'unclassified rows also carry ["other"], so that predicate would silently skip them',
  );
  // Entities move through the listing they represent, so a grouped entity whose representative is
  // classified keeps its leaf even when it also carries unclassified offers.
  assert.match(statements, /fallback_listing_id IN \(/);
});
