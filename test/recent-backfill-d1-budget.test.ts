import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { workingMigrations } from "../scripts/lib/migration-history.js";
import { backfillRecentPriceIndexes } from "../src/db/knowledge-catalog-price-index-recent-refresh.js";
import { accountReads } from "../src/db/read-accounting.js";
import { invocationBudget } from "../src/db/invocation-budget.js";
import { applyMigration, localD1 } from "./helpers/local-d1.js";

test("real D1 backfill admits at most 1000 samples, meters index writes and bills no cooldown writes", async () => {
  const { db, dispose } = await localD1();
  try {
    for (const migration of workingMigrations(process.cwd())) await applyMigration(db, migration);
    await db.prepare("DELETE FROM knowledge_catalog_products").run();
    for (let id = 1; id <= 3; id += 1) {
      await db
        .prepare(`
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
          VALUES (?,'luxman',? ,?,?,'2026-09-01','2026-09-01');
      `)
        .bind(id, `Fixture ${id}`, `fixture${id}`, `Fixture ${id}`)
        .run();
      await db
        .prepare(`
        WITH RECURSIVE samples(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM samples WHERE n<500)
        INSERT INTO knowledge_catalog_price_index_samples(event_key,catalog_product_id,listing_product_id,shop_key,source_id,sample_kind,signal_kind,price_yen,observed_at)
        SELECT 'budget-' || ? || '-' || n, ?, 10000+n, 'fixture', 's-'||n, 'asking','asking',10000+n,'2026-09-01T00:00:00.000Z' FROM samples
      `)
        .bind(id, id)
        .run();
    }
    await db
      .prepare(
        "UPDATE knowledge_catalog_price_indexes SET recent_asking_median_yen=-1; DELETE FROM knowledge_catalog_price_index_recent_refreshes",
      )
      .run();
    const calls = invocationBudget(db);
    const measured = accountReads(calls.db);
    const now = new Date("2026-09-05T01:00:00.000Z");
    const result = await backfillRecentPriceIndexes(measured.db, { now });
    assert.equal(result.selectedCount, 2, "three products exceed the page's sample budget");
    assert.equal(result.afterCatalogProductId, 2);
    assert.equal(result.hasMore, true);
    assert.equal(calls.metrics().d1Calls, 3, "selectors plus one atomic batch");
    assert.equal(measured.countedStatements(), 8);
    assert.ok(measured.rowsRead() > 1000, "verify real workerd metadata, not a zero-valued mock");
    assert.ok(measured.rowsRead() <= 20000, `backfill read ${measured.rowsRead()} rows`);
    assert.ok(
      measured.rowsWritten() > 0 && measured.rowsWritten() <= 40,
      `backfill wrote ${measured.rowsWritten()} rows including indexes`,
    );
    assert.equal(
      await db
        .prepare(
          "SELECT recent_asking_median_yen AS median FROM knowledge_catalog_price_indexes WHERE catalog_product_id=1",
        )
        .first("median"),
      10251,
    );
    assert.equal(
      await db
        .prepare(
          "SELECT recent_asking_median_yen AS median FROM knowledge_catalog_price_indexes WHERE catalog_product_id=3",
        )
        .first("median"),
      -1,
    );
    const cooldown = accountReads(db);
    assert.equal(
      (await backfillRecentPriceIndexes(cooldown.db, { now })).deferredReason,
      "cooldown",
    );
    assert.equal(cooldown.countedStatements(), 1);
    assert.equal(cooldown.rowsWritten(), 0);
    assert.ok(cooldown.rowsRead() <= 2);
    assert.equal(
      (await backfillRecentPriceIndexes(db, { now: new Date("2026-09-05T02:00:00.000Z") })).status,
      "completed",
    );
  } finally {
    await dispose();
  }
}, 30000);
