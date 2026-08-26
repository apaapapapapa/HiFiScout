import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import type { CapturedStatement } from "./helpers/d1.js";

test("entity sync never expands into shop-wide inactive memberships", async () => {
  let queriedInactiveShopMembers = false;
  const db = captureDatabase((statement: CapturedStatement) => {
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) return [{ id: 7 }];
    if (/p\.shop_key = \? AND p\.is_active = 0/.test(statement.sql)) {
      queriedInactiveShopMembers = true;
      return [{ listing_product_id: 99 }];
    }
    if (/entity_id AS entity_id|id AS entity_id/.test(statement.sql)) {
      return [{ entity_id: 21 }];
    }
    return [];
  });

  const result = await syncProductSearchEntities(db, "hifido", ["source-1"]);

  assert.equal(queriedInactiveShopMembers, false);
  assert.equal(result.listing_count, 1);
  const listingScopedWrites = db.calls.filter(
    (statement) =>
      /^\s*(INSERT|DELETE)/.test(statement.sql) &&
      /(?:p\.id|listing_product_id) IN \(\?\)/.test(statement.sql),
  );
  assert.ok(listingScopedWrites.length > 0);
  for (const statement of listingScopedWrites) {
    assert.deepEqual(statement.binds, [7], statement.sql);
  }
});
