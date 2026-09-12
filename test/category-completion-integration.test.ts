import { migrationSources } from "./helpers/migrations.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import {
  normalizeCatalogProduct,
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
} from "../src/catalog/product-normalizer.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";
import { captureDatabase } from "./helpers/d1.js";
import type { QueryableDatabase } from "../src/db/types.js";

const AT = "2026-09-05T00:00:00.000Z";
const MIGRATION = "0095_tape_source_membership.sql";

async function seed(db: QueryableDatabase, titles: readonly string[]) {
  const products = titles.map((title, index) =>
    normalizeCatalogProduct({
      sourceId: `completion-${index}`,
      title,
      manufacturer: "",
      model: "",
      conditionText: "中古",
      priceYen: 10000 + index,
      stockStatus: "in_stock",
      sourceUrl: `https://example.test/completion-${index}`,
    }),
  );
  await upsertProducts(db, "hifido", products, AT);
  await refreshListingProjections(
    db,
    products.map((product) => ({ shop_key: "hifido", source_id: product.sourceId })),
    AT,
  );
}

test("media/noise replay updates searchable memberships and preserves manual category authority", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await seed(db, ["1500-550", "Crystal E", "ケース"]);
    sqlite.exec(`
      UPDATE products SET title='10号メタルリール' WHERE source_id='completion-2';
      UPDATE products SET metadata_json=json_object('categoryClassification',json_object('version',15,'evidence',json('[]')));
      UPDATE products SET raw_category='オープンリールテープ',
        metadata_json=json_object('categoryClassification',json_object('version',15,'evidence',json('[{"source":"seller_category","strength":"supporting","categoryIds":["ANA.TAPE"],"value":"オープンリールテープ"}]')))
        WHERE source_id='completion-0';
      UPDATE products SET raw_manufacturer='KOJO' WHERE source_id='completion-1';
      INSERT INTO product_admin_overrides(listing_product_id,primary_category_id,category_ids,category_name,created_at,updated_at)
        SELECT id,'ACC.CASE','["ACC.CASE","ACC"]','ケース','${AT}','${AT}' FROM products WHERE source_id='completion-2';
    `);
    const result = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date("2026-09-12T02:00:00Z"),
    });
    assert.equal(result.resolved, 3);
    const rows = sqlite
      .prepare(
        "SELECT source_id,primary_category_id,raw_category,remediation_projection_required,json_extract(metadata_json,'$.categoryClassification.version') AS version FROM products ORDER BY source_id",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => row.primary_category_id),
      ["REC.MEDIA", "ACC.GROUND_NOISE", "ACC.CASE"],
    );
    assert.equal(rows[0].raw_category, "オープンリールテープ");
    assert.ok(
      rows.every(
        (row) =>
          row.version === CATEGORY_CLASSIFICATION_METADATA_VERSION &&
          row.remediation_projection_required === 0,
      ),
    );
    for (const [category, sourceId] of [
      ["REC.MEDIA", "completion-0"],
      ["REC", "completion-0"],
      ["ACC.GROUND_NOISE", "completion-1"],
      ["ACC.CASE", "completion-2"],
    ]) {
      const found = await searchProducts(db, productQuery(`?category=${category}`));
      assert.deepEqual(
        found.items.map((item) => item.representative_offer?.source_url),
        [`https://example.test/${sourceId}`],
      );
    }
    const before = sqlite.prepare("SELECT * FROM products ORDER BY id").all();
    const next = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date("2026-09-12T02:01:00Z"),
    });
    assert.equal(next.resolved, 0);
    assert.deepEqual(sqlite.prepare("SELECT * FROM products ORDER BY id").all(), before);
    assert.equal(
      sqlite.prepare("SELECT updated_at FROM product_admin_overrides").get()?.updated_at,
      AT,
    );
  } finally {
    sqlite.close();
  }
});

test("tape migration repairs ancestors without changing durable identities or explicit overrides", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    // Keep the historical fixture independent of tables required by today's listing writer.
    for (const [index, title] of [
      "テープデッキ T1",
      "テープデッキ T2",
      "レコードプレーヤー R1",
    ].entries()) {
      const category = index < 2 ? "ANA.TAPE" : "ANA.TURNTABLE";
      sqlite
        .prepare(`INSERT INTO products
          (shop_key, source_id, title, condition_text, price_yen, stock_status, source_url,
           first_seen_at, last_seen_at, last_changed_at, primary_category_id, category_ids)
          VALUES ('hifido', ?, ?, '中古', ?, 'in_stock', ?, ?, ?, ?, ?, ?)`)
        .run(
          `completion-${index}`,
          title,
          10000 + index,
          `https://example.test/completion-${index}`,
          AT,
          AT,
          AT,
          category,
          JSON.stringify([category, "ANA"]),
        );
    }
    sqlite.exec(`
      INSERT INTO product_categories(product_id, category_id, is_direct)
        SELECT id, primary_category_id, 1 FROM products;
      INSERT INTO price_history(product_id, price_yen, observed_at)
        SELECT id, price_yen, '${AT}' FROM products;
      INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at)
        SELECT id,'unresolved','unresolved','none','${AT}' FROM products;
      INSERT INTO product_search_entities(entity_key,entity_kind,fallback_listing_id,primary_category_id)
        SELECT 'l-'||id,'unresolved_listing',id,primary_category_id FROM products;
      INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT p.id,e.id,p.shop_key FROM products p JOIN product_search_entities e ON e.entity_key='l-'||p.id;
      INSERT INTO product_search_entity_categories(entity_id,category_id,is_direct)
        SELECT m.entity_id,pc.category_id,pc.is_direct FROM product_categories pc
        JOIN product_search_entity_offers m ON m.listing_product_id=pc.product_id;
    `);
    sqlite.exec(`
      DELETE FROM product_categories WHERE category_id = 'SRC';
      INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct)
        SELECT id, 'ANA', 0 FROM products;
      INSERT INTO product_categories(product_id,category_id,is_direct)
        SELECT id,'ANA.TURNTABLE',1 FROM products WHERE source_id='completion-1';
      DELETE FROM product_search_entity_categories WHERE category_id = 'SRC';
      INSERT OR IGNORE INTO product_search_entity_categories(entity_id,category_id,is_direct)
        SELECT id,'ANA',0 FROM product_search_entities;
      INSERT OR IGNORE INTO product_search_entity_categories(entity_id,category_id,is_direct)
        SELECT entity_id,'ANA.TURNTABLE',1 FROM product_search_entity_offers m JOIN products p ON p.id=m.listing_product_id WHERE p.source_id='completion-1';
      INSERT INTO product_admin_overrides(listing_product_id, primary_category_id, category_ids, category_name, created_at, updated_at)
        SELECT id,'ANA.TAPE','["ANA.TAPE","ANA"]','テープデッキ','${AT}','${AT}' FROM products WHERE source_id='completion-0';
    `);
    const before = sqlite
      .prepare(
        "SELECT id,source_id,primary_category_id,price_yen,first_seen_at,metadata_json FROM products ORDER BY id",
      )
      .all();
    const identityBefore = sqlite
      .prepare("SELECT * FROM product_identity_resolutions ORDER BY listing_product_id")
      .all();
    const historyBefore = sqlite.prepare("SELECT * FROM price_history ORDER BY id").all();
    sqlite.exec(readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8"));
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT id,source_id,primary_category_id,price_yen,first_seen_at,metadata_json FROM products ORDER BY id",
        )
        .all(),
      before,
    );
    assert.deepEqual(
      sqlite
        .prepare("SELECT * FROM product_identity_resolutions ORDER BY listing_product_id")
        .all(),
      identityBefore,
    );
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM price_history ORDER BY id").all(),
      historyBefore,
    );
    const memberships = (sourceId: string) =>
      sqlite
        .prepare(
          "SELECT category_id FROM product_categories pc JOIN products p ON p.id=pc.product_id WHERE p.source_id=? ORDER BY category_id",
        )
        .all(sourceId)
        .map((row) => row.category_id);
    assert.deepEqual(memberships("completion-0"), ["ANA.TAPE", "SRC"]);
    assert.deepEqual(memberships("completion-1"), ["ANA", "ANA.TAPE", "ANA.TURNTABLE", "SRC"]);
    assert.deepEqual(memberships("completion-2"), ["ANA", "ANA.TURNTABLE"]);
    const override = sqlite
      .prepare("SELECT primary_category_id, category_ids, updated_at FROM product_admin_overrides")
      .get();
    assert.equal(override?.primary_category_id, "ANA.TAPE");
    assert.equal(override?.category_ids, '["ANA.TAPE","SRC"]');
    assert.equal(override?.updated_at, AT);
    // The protection is restored: a crawler cannot erase the admin-owned leaf after migration.
    sqlite.exec(
      "DELETE FROM product_categories WHERE product_id IN (SELECT listing_product_id FROM product_admin_overrides)",
    );
    assert.deepEqual(memberships("completion-0"), ["ANA.TAPE", "SRC"]);
    // Current search reads offer facts; preserve the historical migration assertions above.
    for (const current of migrationSources.filter((row) => row.name > MIGRATION))
      sqlite.exec(current.sql);
    assert.equal((await searchProducts(db, productQuery("?category=SRC"))).items.length, 2);
    assert.equal((await searchProducts(db, productQuery("?category=ANA"))).items.length, 2);
  } finally {
    sqlite.close();
  }
});

test("feature-state SQL matches missing, explicit absent and conflicting evidence using indexed entity lookups", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await seed(db, [
      "DAC搭載 CDプレーヤー D1",
      "DAC非搭載 CDトランスポート T1",
      "CDプレーヤー U1",
      "DAC搭載 CDプレーヤー X1",
    ]);
    sqlite.exec(`INSERT INTO product_feature_facts(product_id,feature_id,state,source,confidence)
      SELECT id,'dac','absent','official',1 FROM products WHERE source_id='completion-3';`);
    const sources = async (feature: string) =>
      (await searchProducts(db, productQuery(`?feature=${feature}`))).items
        .map((item) => item.representative_offer?.source_url)
        .sort();
    assert.deepEqual(await sources("dac"), ["https://example.test/completion-0"]);
    assert.deepEqual(await sources("dac:absent"), ["https://example.test/completion-1"]);
    assert.deepEqual(await sources("dac:unknown"), [
      "https://example.test/completion-2",
      "https://example.test/completion-3",
    ]);
    const capture = captureDatabase();
    await searchProducts(capture, productQuery("?feature=dac:unknown"));
    const { sql, binds } = capture.calls[0];
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        ...binds.map((value) => {
          assert.ok(value === null || typeof value === "string" || typeof value === "number");
          return value;
        }),
      )
      .map((row) => String(row.detail))
      .join("\n");
    assert.match(plan, /SEARCH m USING[^\n]+\(entity_id=\?\)/);
    assert.match(plan, /SEARCH pff USING[^\n]+\([^\n)]*product_id=\?[^\n)]*\)/);
    assert.ok(plan.indexOf("SEARCH m USING") < plan.indexOf("SEARCH pff USING"), plan);
    assert.doesNotMatch(plan, /SCAN (?:m|pff)\b/);
  } finally {
    sqlite.close();
  }
});

test("bounded version replay replaces stale title decisions and facts while preserving external evidence", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await seed(db, ["フルレンジユニット F1", "DAC非搭載 CDトランスポート T1", "DATデッキ D1"]);
    sqlite.exec(`
      UPDATE products SET metadata_json=json_set(metadata_json,'$.categoryClassification.version',17);
      UPDATE products SET metadata_json=json_set(metadata_json,'$.categoryClassification.evidence',json('[{"source":"title","strength":"strong","categoryIds":["SPK.LOUDSPEAKER"],"value":"フルレンジユニット F1"}]')),
        primary_category_id='SPK.LOUDSPEAKER',category_ids='["SPK.LOUDSPEAKER"]',direct_category_ids='["SPK.LOUDSPEAKER"]' WHERE source_id='completion-0';
      UPDATE product_feature_facts SET state='present' WHERE feature_id='dac' AND source='title';
      INSERT INTO product_facet_facts(product_id,facet_id,facet_value,source,confidence)
        SELECT id,'technology','transformer','title',0.8 FROM products WHERE source_id='completion-1';
      INSERT INTO product_feature_facts(product_id,feature_id,state,source,confidence)
        SELECT id,'recording','present','official',1 FROM products WHERE source_id='completion-2';
      UPDATE products SET is_active=0 WHERE source_id='completion-2';
    `);
    const first = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 1,
      now: new Date("2026-09-05T01:00:00Z"),
    });
    assert.equal(first.seeded, 2);
    assert.equal(first.resolved, 1);
    assert.equal(first.queue.pending, 1);
    sqlite.exec("UPDATE products SET is_active=1 WHERE source_id='completion-2'");
    const next = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date("2026-09-05T01:01:00Z"),
    });
    assert.equal(next.seeded, 1);
    assert.equal(next.resolved, 2);
    assert.equal(
      sqlite
        .prepare("SELECT primary_category_id FROM products WHERE source_id='completion-0'")
        .get()?.primary_category_id,
      "ACC.PART",
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT state FROM product_feature_facts WHERE feature_id='dac' AND source='title'",
        )
        .get()?.state,
      "absent",
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM product_facet_facts WHERE facet_id='technology' AND facet_value='transformer'",
        )
        .get()?.n,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT state FROM product_feature_facts WHERE feature_id='recording' AND source='official'",
        )
        .get()?.state,
      "present",
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM products WHERE json_extract(metadata_json,'$.categoryClassification.version')=?",
        )
        .get(CATEGORY_CLASSIFICATION_METADATA_VERSION)?.n,
      3,
    );
    const idle = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date("2026-09-05T01:02:00Z"),
    });
    assert.equal(idle.seeded, 0);
    assert.equal(idle.claimed, 0);
  } finally {
    sqlite.close();
  }
});
