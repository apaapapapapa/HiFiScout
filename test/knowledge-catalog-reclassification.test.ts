import assert from "node:assert/strict";
import test from "node:test";

import { getCategory } from "../src/catalog/categories.js";
import { reclassifyProductsFromKnowledgeCatalog } from "../src/db/knowledge-catalog-repository.js";
import { captureDatabase } from "./helpers/d1.js";

test("category reclassification retries a failed downstream projection refresh", async () => {
  const primary = getCategory("pre_amp");
  assert.ok(primary);

  let pass = 1;
  let pendingToken = "";
  let refreshCalls = 0;
  const refreshedListings: Array<{ shop_key: string; source_id: string }> = [];
  const db = captureDatabase((statement) => {
    if (/FROM products p/.test(statement.sql)) {
      return [
        {
          id: 11,
          shop_key: "hifido",
          source_id: "listing-11",
          manufacturer_id: "marantz",
          model: "ABC-1",
          model_resolution_status: "resolved",
          category: pass === 1 ? "Other" : primary.name,
          primary_category_id: pass === 1 ? "other" : primary.id,
          category_ids: pass === 1 ? '["other"]' : JSON.stringify([primary.id]),
          classification_status: "classified",
          remediation_projection_required: pass === 1 ? 0 : 1,
          remediation_projection_token: pass === 1 ? "" : pendingToken,
          identity_status: "matched",
          identity_catalog_product_id: 10,
        },
      ];
    }
    if (/FROM knowledge_catalog_products kp/.test(statement.sql)) {
      return [
        {
          id: 10,
          manufacturer_id: "marantz",
          canonical_model: "ABC-1",
          normalized_model: "ABC-1",
          canonical_name: "ABC-1 Control Amplifier",
          category_id: primary.id,
          is_primary: 1,
        },
      ];
    }
    if (/FROM knowledge_catalog_aliases/.test(statement.sql)) return [];
    return [];
  });

  await assert.rejects(
    reclassifyProductsFromKnowledgeCatalog(db, "2026-08-15T01:00:00.000Z", {
      refreshListings: async () => {
        refreshCalls += 1;
        pass = 2;
        throw new Error("projection failed");
      },
    }),
    /projection failed/,
  );

  const categoryUpdate = db.batched.find((statement) =>
    /remediation_projection_required = 1/.test(statement.sql),
  );
  assert.ok(categoryUpdate);
  pendingToken = String(categoryUpdate.binds[4]);
  assert.match(pendingToken, /^category:/);
  assert.equal(refreshCalls, 1);
  assert.equal(
    db.batched.some((statement) => /remediation_projection_required = 0/.test(statement.sql)),
    false,
  );

  const reclassified = await reclassifyProductsFromKnowledgeCatalog(
    db,
    "2026-08-15T01:01:00.000Z",
    {
      refreshListings: async (_database, listings) => {
        refreshCalls += 1;
        refreshedListings.push(...listings);
      },
    },
  );

  assert.equal(reclassified, 0);
  assert.equal(refreshCalls, 2);
  assert.deepEqual(refreshedListings, [
    { id: 11, shop_key: "hifido", source_id: "listing-11", projectionToken: pendingToken },
  ]);
  const completed = db.batched.find(
    (statement) =>
      /SET remediation_projection_required = 0/.test(statement.sql) &&
      statement.binds[1] === pendingToken,
  );
  assert.ok(completed);
  assert.deepEqual(completed.binds, [11, pendingToken]);
});
