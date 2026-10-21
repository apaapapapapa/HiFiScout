import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { categorySearchAliases, getCategory } from "../src/catalog/categories.js";
import { reclassifyProductsFromKnowledgeCatalog } from "../src/db/knowledge-catalog-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { database, listing, AT, NEXT } from "./helpers/d1-write-budget.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import type { QueryableDatabase } from "../src/db/types.js";

function interceptCategoryBatch(
  db: QueryableDatabase,
  intercept: (batch: D1PreparedStatement[]) => D1PreparedStatement[],
): QueryableDatabase {
  const categoryWrites = new WeakSet<D1PreparedStatement>();
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql);
      if (!/UPDATE products\s+SET category =/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              categoryWrites.add(bound);
              return bound;
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch: (statements) =>
      db.batch(statements.some((s) => categoryWrites.has(s)) ? intercept(statements) : statements),
  };
}

test("real D1 reclassification rejects stale snapshots, preserves atomic categories and resumes projection", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','${AT}','${AT}');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
      VALUES (1,'luxman','C10','C10','LUXMAN C10','verified','${AT}','${AT}');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES (1,'AMP.PRE',1);`)
      .run();
    await upsertProducts(db, "reclassification", [listing("one")], AT);
    await db
      .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,catalog_product_id,status,match_method,confidence,evaluated_at)
      SELECT id,1,'matched','manufacturer_model_exact','high',? FROM products WHERE shop_key='reclassification'`)
      .bind(AT)
      .run();
    let refreshCalls = 0;
    let raced = false;
    const racing: QueryableDatabase = {
      ...db,
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await db
            .prepare(
              "UPDATE products SET last_seen_at=?,metadata_json='{}' WHERE shop_key='reclassification'",
            )
            .bind(NEXT)
            .run();
        }
        return db.batch(statements);
      },
    };
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(racing, NEXT, {
        refreshListings: async () => {
          refreshCalls++;
        },
      }),
      0,
    );
    assert.equal(refreshCalls, 0);
    assert.equal(
      (
        await db
          .prepare("SELECT primary_category_id FROM products WHERE shop_key='reclassification'")
          .first()
      )?.primary_category_id,
      "unclassified",
    );
    const aborting = interceptCategoryBatch(db, (statements) => [
      ...statements,
      db.prepare(
        "INSERT INTO product_categories(product_id,category_id,is_direct) VALUES (-1,'AMP.PRE',1)",
      ),
    ]);
    await assert.rejects(reclassifyProductsFromKnowledgeCatalog(aborting, NEXT), /FOREIGN KEY/);
    assert.equal(
      (
        await db
          .prepare("SELECT primary_category_id FROM products WHERE shop_key='reclassification'")
          .first()
      )?.primary_category_id,
      "unclassified",
    );
    await assert.rejects(
      reclassifyProductsFromKnowledgeCatalog(db, NEXT, {
        refreshListings: async () => {
          throw new Error("projection interruption");
        },
      }),
      /projection interruption/,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT remediation_projection_required FROM products WHERE shop_key='reclassification'",
          )
          .first()
      )?.remediation_projection_required,
      1,
    );
    // The row already committed; the retry performs exactly one durable projection repair.
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(db, NEXT, {
        refreshListings: async () => {
          refreshCalls++;
        },
      }),
      0,
    );
    assert.equal(refreshCalls, 1);
    const replay = measureD1Cost(db);
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(replay.db, NEXT, {
        refreshListings: async () => {
          refreshCalls++;
        },
      }),
      0,
    );
    assert.equal(replay.metrics().rowsWritten, 0);
    assert.equal(refreshCalls, 1);
    // Aliases and direct membership are part of the shared change contract, even with the same primary.
    await db
      .prepare(
        "UPDATE products SET search_aliases='',direct_category_ids='[]' WHERE shop_key='reclassification'",
      )
      .run();
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(db, NEXT, {
        refreshListings: async () => {
          refreshCalls++;
        },
      }),
      1,
    );
    // Conflicting verified leaves must not pick the first category and oscillate with enrichment.
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES (1,'AMP.POWER',0)",
      )
      .run();
    const ambiguous = measureD1Cost(db);
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(ambiguous.db, NEXT, {
        refreshListings: async () => {
          refreshCalls++;
        },
      }),
      0,
    );
    assert.equal(ambiguous.metrics().rowsWritten, 0);
    assert.equal(refreshCalls, 2);
    await db
      .prepare(
        "DELETE FROM knowledge_catalog_product_categories WHERE product_id=1 AND category_id='AMP.POWER'",
      )
      .run();
    await upsertProducts(
      db,
      "reclassification",
      Array.from({ length: 17 }, (_, i) => listing(`chunk-${i}`)),
      AT,
    );
    await db
      .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,catalog_product_id,status,match_method,confidence,evaluated_at)
      SELECT id,1,'matched','manufacturer_model_exact','high',? FROM products WHERE source_id LIKE 'chunk-%'`)
      .bind(AT)
      .run();
    let batches = 0;
    const partial = interceptCategoryBatch(db, (statements) => {
      if (++batches === 2) throw new Error("second batch interrupted");
      return statements;
    });
    await assert.rejects(
      reclassifyProductsFromKnowledgeCatalog(partial, NEXT),
      /second batch interrupted/,
    );
    const committed = await db
      .prepare(
        "SELECT COUNT(*) n FROM products WHERE source_id LIKE 'chunk-%' AND primary_category_id='AMP.PRE' AND remediation_projection_required=1",
      )
      .first();
    assert.equal(committed?.n, 16);
    let repaired = 0;
    assert.equal(
      await reclassifyProductsFromKnowledgeCatalog(db, NEXT, {
        refreshListings: async (_db, targets) => {
          repaired += targets.length;
        },
      }),
      1,
    );
    assert.equal(repaired, 17);
    const complete = await db
      .prepare(
        "SELECT COUNT(*) n FROM products WHERE source_id LIKE 'chunk-%' AND primary_category_id='AMP.PRE' AND remediation_projection_required=0",
      )
      .first();
    assert.equal(complete?.n, 17);
  } finally {
    await dispose();
  }
}, 60_000);

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
          direct_category_ids: pass === 1 ? '["other"]' : JSON.stringify([primary.id]),
          search_aliases: pass === 1 ? "" : categorySearchAliases([primary.id]),
          classification_status: "classified",
          remediation_projection_required: pass === 1 ? 0 : 1,
          remediation_projection_token: pass === 1 ? "" : pendingToken,
          identity_status: "matched",
          identity_catalog_product_id: 10,
        },
      ];
    }
    if (/knowledge_catalog_products kp/.test(statement.sql)) {
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
  // 0: display name, 1: primary, 2: closure, 3: direct set, 4: aliases, 5: projection token.
  pendingToken = String(categoryUpdate.binds[5]);
  assert.match(pendingToken, /^category:/);
  assert.equal(refreshCalls, 1);
  assert.equal(
    db.batched.some((statement) => /remediation_projection_required = 0/.test(statement.sql)),
    false,
  );

  // The retry starts from an already-correct category; only the durable projection token keeps it live.
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
