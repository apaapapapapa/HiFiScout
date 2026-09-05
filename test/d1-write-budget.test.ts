import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { syncProductMetadata } from "../src/db/product-metadata-repository.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { syncProductIdentityResolutions } from "../src/db/product-identity-repository.js";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { syncProductSearchProjections } from "../src/db/product-search-projection-repository.js";
import { refreshKnowledgeCatalogCandidates } from "../src/db/knowledge-catalog-review-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { detailFetchOptions } from "./helpers/fixtures.js";
import { AT, NEXT, database, listing } from "./helpers/d1-write-budget.js";

test("D1 bills zero for unchanged catalog decisions, search replay and candidate refresh", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`
      INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','${AT}','${AT}');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
      VALUES (1,'luxman','C10','C10','LUXMAN C10','verified','${AT}','${AT}');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES (1,'AMP.PRE',1);
    `)
      .run();
    const enrich = (at: string) =>
      enrichProductCategories({
        db,
        adapter: { key: "hifido", capabilities: {} },
        products: [listing("one")],
        now: new Date(at),
        fetchOptions: detailFetchOptions(),
        transport: {
          fetchHtmlPage: async () => {
            throw new Error("unexpected network");
          },
        },
      });
    const first = (await enrich(AT)).products;
    await upsertProducts(db, "hifido", first, AT);
    await syncProductMetadata(db, "hifido", first, AT);
    await syncProductSearchProjections(db, "hifido", ["one"]);
    await syncProductIdentityResolutions(db, "hifido", ["one"]);
    await syncProductSearchEntities(db, "hifido", ["one"]);
    await refreshKnowledgeCatalogCandidates(db, AT);

    const second = (await enrich(NEXT)).products;
    const replay = accountReads(db);
    await upsertProducts(replay.db, "hifido", second, NEXT);
    await syncProductMetadata(replay.db, "hifido", second, NEXT);
    await syncProductSearchEntities(replay.db, "hifido", ["one"]);
    await refreshKnowledgeCatalogCandidates(replay.db, NEXT);
    assert.ok(replay.countedStatements() > 20);
    assert.equal(replay.rowsWritten(), 0);
    assert.ok(replay.rowsRead() < 200, `unchanged replay read ${replay.rowsRead()} rows`);
    assert.equal(
      await db
        .prepare(
          "SELECT json_extract(metadata_json, '$.categoryClassification.catalogMatchedAt') at FROM products",
        )
        .first("at"),
      AT,
    );

    const changed = accountReads(db);
    const priceResult = await upsertProducts(
      changed.db,
      "hifido",
      [{ ...second[0], priceYen: 90000 }],
      NEXT,
    );
    assert.equal(priceResult.activityCount, 1);
    // Two added writes retain the atomic projection obligation and its fairness index.
    assert.ok(changed.rowsWritten() <= 18, `price/history wrote ${changed.rowsWritten()} rows`);
    const row = await db
      .prepare(
        "SELECT price_yen, previous_price_yen, last_changed_at, last_activity_at FROM products WHERE source_id='one'",
      )
      .first();
    assert.deepEqual(row, {
      price_yen: 90000,
      previous_price_yen: 100000,
      last_changed_at: NEXT,
      last_activity_at: NEXT,
    });
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM price_history").first("n"), 2);
    const projection = accountReads(db);
    await syncProductSearchEntities(projection.db, "hifido", ["one"]);
    assert.ok(projection.rowsWritten() <= 5);
    assert.equal(
      await db
        .prepare("SELECT lowest_price_yen FROM product_search_entities")
        .first("lowest_price_yen"),
      90000,
    );
    const repeated = accountReads(db);
    await syncProductSearchEntities(repeated.db, "hifido", ["one"]);
    assert.equal(repeated.rowsWritten(), 0);

    // A hundred clock-only metadata changes must stay zero, rather than hiding a per-row cost.
    const group = Array.from({ length: 100 }, (_, i) => ({ ...first[0], sourceId: `bulk-${i}` }));
    await upsertProducts(db, "hifido", group, AT);
    await syncProductMetadata(db, "hifido", group, AT);
    const bulk = accountReads(db);
    await syncProductMetadata(
      bulk.db,
      "hifido",
      group.map((product) => ({
        ...product,
        metadata: {
          ...product.metadata,
          categoryClassification: {
            ...product.metadata.categoryClassification,
            catalogMatchedAt: NEXT,
          },
        },
      })),
      NEXT,
    );
    assert.equal(bulk.rowsWritten(), 0);
  } finally {
    await dispose();
  }
}, 30_000);

test("D1 exact-group replay avoids transient entities and still completes pending correction evidence", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "hifido", [listing("a"), listing("b")], AT);
    await syncProductSearchProjections(db, "hifido", ["a", "b"]);
    await syncProductIdentityResolutions(db, "hifido", ["a", "b"]);
    await syncProductSearchEntities(db, "hifido", ["a", "b"]);
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM product_search_entities").first("n"), 1);
    const replay = accountReads(db);
    await syncProductSearchEntities(replay.db, "hifido", ["b"]);
    assert.equal(replay.rowsWritten(), 0);
    assert.ok(replay.rowsRead() < 350, `exact-group replay read ${replay.rowsRead()} rows`);

    await db
      .prepare(`INSERT INTO data_quality_remediation_events(listing_product_id,shop_key,source_id,field,processed_at)
      SELECT id,shop_key,source_id,'category','${NEXT}' FROM products WHERE source_id='b'`)
      .run();
    assert.equal(
      await db
        .prepare("SELECT provenance_complete FROM data_quality_remediation_events")
        .first("provenance_complete"),
      0,
    );
    await syncProductSearchEntities(db, "hifido", ["b"]);
    const event = await db
      .prepare(
        "SELECT provenance_complete, new_search_entity_key FROM data_quality_remediation_events",
      )
      .first<{ provenance_complete: number; new_search_entity_key: string }>();
    assert.equal(event?.provenance_complete, 1);
    assert.equal(
      event?.new_search_entity_key,
      await db.prepare("SELECT entity_key FROM product_search_entities").first("entity_key"),
    );
    const completed = accountReads(db);
    await syncProductSearchEntities(completed.db, "hifido", ["b"]);
    assert.equal(completed.rowsWritten(), 0);

    await db.prepare("UPDATE products SET is_active=0 WHERE source_id='a'").run();
    await syncProductSearchEntities(db, "hifido", ["a", "b"]);
    assert.equal(
      await db.prepare("SELECT offer_count FROM product_search_entities").first("offer_count"),
      1,
    );
    assert.equal(
      await db.prepare("SELECT COUNT(*) n FROM product_search_entity_offers").first("n"),
      1,
    );
  } finally {
    await dispose();
  }
}, 30_000);
