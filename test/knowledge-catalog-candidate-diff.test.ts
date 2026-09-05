import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { refreshKnowledgeCatalogCandidates } from "../src/db/knowledge-catalog-review-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const AT = "2026-09-05T00:00:00.000Z";
const NEXT = "2026-09-05T01:00:00.000Z";

test("candidate differences preserve manual ignores and retire only vanished groups", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec("DELETE FROM knowledge_catalog_products");
    const product = normalizeCatalogProduct({
      sourceId: "one",
      manufacturer: "LUXMAN",
      model: "C10",
      title: "LUXMAN C10",
      conditionText: "中古",
      priceYen: 100000,
      stockStatus: "in_stock",
      sourceUrl: "https://example.test/one",
    });
    await upsertProducts(db, "hifido", [product], AT);
    await refreshKnowledgeCatalogCandidates(db, AT);
    sqlite.exec("UPDATE knowledge_catalog_candidates SET review_status='ignored'");
    const snapshot = sqlite.prepare("SELECT * FROM knowledge_catalog_candidates").get();
    await refreshKnowledgeCatalogCandidates(db, NEXT);
    assert.deepEqual(sqlite.prepare("SELECT * FROM knowledge_catalog_candidates").get(), snapshot);

    await upsertProducts(db, "hifido", [{ ...product, title: "LUXMAN C10 updated" }], NEXT);
    await refreshKnowledgeCatalogCandidates(db, NEXT);
    const changed = sqlite.prepare("SELECT * FROM knowledge_catalog_candidates").get();
    assert.equal(changed?.review_status, "ignored");
    assert.equal(changed?.sample_title, "LUXMAN C10 updated");
    assert.equal(changed?.first_seen_at, AT);
    assert.equal(changed?.updated_at, NEXT);

    sqlite.exec("UPDATE products SET is_active=0");
    const stats = await refreshKnowledgeCatalogCandidates(db, NEXT);
    assert.equal(stats.candidates, 0);
    const retired = sqlite
      .prepare(
        "SELECT active_listing_count,shop_count,priority_score,review_status FROM knowledge_catalog_candidates",
      )
      .get();
    assert.deepEqual(
      { ...retired },
      { active_listing_count: 0, shop_count: 0, priority_score: 0, review_status: "ignored" },
    );
    const afterRetirement = sqlite.prepare("SELECT total_changes() n").get()?.n;
    await refreshKnowledgeCatalogCandidates(db, "2026-09-05T02:00:00.000Z");
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, afterRetirement);

    await upsertProducts(db, "hifido", [product], NEXT);
    await refreshKnowledgeCatalogCandidates(db, NEXT);
    assert.equal(
      sqlite.prepare("SELECT active_listing_count FROM knowledge_catalog_candidates").get()
        ?.active_listing_count,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT review_status FROM knowledge_catalog_candidates").get()?.review_status,
      "ignored",
    );
  } finally {
    sqlite.close();
  }
});
