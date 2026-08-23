import { test } from "vitest";
import assert from "node:assert/strict";

import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

test("badge-prefixed Japanese legacy manufacturers remain filterable during replay", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    // This fixture intentionally models an already-existing stale read-model row. Its referenced
    // listing is irrelevant to the manufacturer predicate, so avoid manufacturing a full product
    // fixture solely to satisfy the read model's foreign key.
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite
      .prepare(`
        INSERT INTO product_search_entities(
          entity_key, entity_kind, fallback_listing_id,
          manufacturer_id, manufacturer, model, normalized_model, primary_category_id
        ) VALUES (?, 'unresolved_listing', ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "l-999999",
        999999,
        "brand-1l3h5o3",
        "【中古品】ラックスマン",
        "L-505uXII",
        "l505uxii",
        "integrated_amp",
      );
    sqlite.exec("PRAGMA foreign_keys = ON");

    const result = await searchProducts(db, productQuery("?manufacturer=LUXMAN"));

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].manufacturer, "LUXMAN");
    assert.equal(result.items[0].manufacturer_id, "luxman");
  } finally {
    sqlite.close();
  }
});
