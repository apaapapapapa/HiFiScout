import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { applyManualCategoryAuthority } from "../scripts/apply-manual-category-authority.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { applyConfirmedSwitchBundleCategory } from "../scripts/apply-confirmed-switch-bundle-category.js";
import { updateListingAdminProduct } from "../src/db/listing-admin-repository.js";
import { recordingDatabase, queryPlan } from "./helpers/query-plan.js";

const MODEL = "M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本";
const URL = "https://shop.formusic.jp/network-player/31211.html";

function database() {
  const setup = migratedSqlite();
  setup.sqlite
    .prepare(`INSERT INTO products(
    id,shop_key,source_id,manufacturer,model,title,category,condition_text,
    price_yen,stock_status,source_url,first_seen_at,last_seen_at,last_changed_at,is_active,
    raw_manufacturer,manufacturer_id,canonical_manufacturer_id,manufacturer_resolution_status,
    raw_model,normalized_model,model_resolution_status,model_resolution_method,
    raw_category,primary_category_id,category_ids,direct_category_ids,classification_status,
    metadata_json
  ) VALUES (1772,'formusic','31211','Telegartner',?,?,'ネットワークプレーヤー','中古',
    498000,'in_stock',?,'2026-09-06','2026-09-06','2026-09-06',1,
    'Telegartner','telegartner','telegartner','resolved',?,'M12SWITCHIEGOLD20M3',
    'candidate','unsafe_annotation','network-player','SRC.STREAMER',
    '["SRC.STREAMER"]','["SRC.STREAMER"]','classified',?
  )`)
    .run(
      MODEL,
      MODEL,
      URL,
      MODEL,
      JSON.stringify({
        modelNormalization: { unclassifiedTokens: ["bundle_components"] },
        categoryClassification: { source: "seller_category", categoryIds: ["SRC.STREAMER"] },
      }),
    );
  // Reproduce a later CSV correction: the catalog describes the body, not this seller bundle.
  // The old audit source is retired; it must not be revived to authorize a product merge.
  setup.sqlite.exec(`UPDATE knowledge_catalog_products SET canonical_model='M12 SWITCH IE GOLD',
    normalized_model='M12 SWITCH IE GOLD' WHERE manufacturer_id='telegartner';
    DELETE FROM knowledge_catalog_aliases WHERE product_id IN (
      SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='telegartner');
    UPDATE knowledge_catalog_sources SET status='error' WHERE product_id IN (
      SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='telegartner');`);
  return setup;
}

test("confirmed bundle correction converges without restoring retired catalog identity evidence", async () => {
  const { db, sqlite } = database();
  try {
    const before = sqlite
      .prepare(`SELECT model,raw_model,raw_category,metadata_json,
      model_resolution_status,model_resolution_method,price_yen FROM products WHERE id=1772`)
      .get();
    // The shared audit caller cannot execute this new correction on an unconfirmed deployment.
    await assert.rejects(applyManualCategoryAuthority(db), /switching-hub classifications/u);
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) n FROM product_admin_overrides WHERE listing_product_id=1772")
        .get()?.n,
      0,
    );
    await applyConfirmedSwitchBundleCategory(db);
    await applyManualCategoryAuthority(db);
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=1772").get()
        ?.primary_category_id,
      "SIG.NETWORK",
    );
    assert.deepEqual(
      sqlite
        .prepare(`SELECT model,raw_model,raw_category,metadata_json,
      model_resolution_status,model_resolution_method,price_yen FROM products WHERE id=1772`)
        .get(),
      before,
    );
    assert.deepEqual(
      {
        ...sqlite
          .prepare(`SELECT primary_category_id,model,manufacturer_id
      FROM product_admin_overrides WHERE listing_product_id=1772`)
          .get(),
      },
      {
        primary_category_id: "SIG.NETWORK",
        model: null,
        manufacturer_id: null,
      },
    );
    assert.deepEqual(
      {
        ...sqlite
          .prepare(`SELECT e.entity_key,e.primary_category_id
      FROM product_search_entity_offers o JOIN product_search_entities e ON e.id=o.entity_id
      WHERE o.listing_product_id=1772`)
          .get(),
      },
      {
        entity_key: "l-1772",
        primary_category_id: "SIG.NETWORK",
      },
    );
    assert.equal(
      sqlite.prepare("SELECT remediation_projection_required FROM products WHERE id=1772").get()
        ?.remediation_projection_required,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) n FROM knowledge_catalog_sources WHERE status='active' AND product_id IN (SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='telegartner')",
        )
        .get()?.n,
      0,
    );
    assert.deepEqual(
      {
        ...sqlite
          .prepare(`SELECT previous_value,new_value FROM data_quality_remediation_events
      WHERE listing_product_id=1772 AND field='category'`)
          .get(),
      },
      {
        previous_value: "SRC.STREAMER",
        new_value: "SIG.NETWORK",
      },
    );
    // Exercise the actual persistence triggers: later seller-derived classifications cannot win.
    sqlite.exec(`UPDATE products SET primary_category_id='SRC.STREAMER',category_ids='["SRC.STREAMER"]',
      direct_category_ids='["SRC.STREAMER"]' WHERE id=1772`);
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=1772").get()
        ?.primary_category_id,
      "SIG.NETWORK",
    );
    assert.equal(
      sqlite.prepare("SELECT direct_category_ids FROM products WHERE id=1772").get()
        ?.direct_category_ids,
      '["SIG.NETWORK"]',
    );
  } finally {
    sqlite.close();
  }
});

test("repeating the correction preserves its receipt and override timestamp without writes", async () => {
  const { db, sqlite } = database();
  try {
    assert.equal(await applyConfirmedSwitchBundleCategory(db), 1);
    const snapshot = () => ({
      override: sqlite
        .prepare("SELECT * FROM product_admin_overrides WHERE listing_product_id=1772")
        .get(),
      receipts: sqlite.prepare("SELECT * FROM admin_csv_import_changes").all(),
      changes: sqlite.prepare("SELECT total_changes() n").get()?.n,
    });
    const before = snapshot();
    const recorded = recordingDatabase(db);
    assert.equal(await applyConfirmedSwitchBundleCategory(recorded.db), 0);
    assert.deepEqual(snapshot(), before);
    const plans = recorded.executed.flatMap((statement) => queryPlan(sqlite, statement));
    assert.ok(
      !plans.some(({ detail }) => /SCAN (?:p|products)\b/u.test(detail)),
      JSON.stringify(plans),
    );
  } finally {
    sqlite.close();
  }
});

test("a partial correction resumes the same durable receipt and completes the search projection", async () => {
  const { db, sqlite } = database();
  try {
    let committed = false;
    const failing = {
      prepare(sql: string) {
        if (committed && sql.includes("listing_projection_pending"))
          throw new Error("injected outage");
        return db.prepare(sql);
      },
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        const result = await db.batch<T>(statements);
        committed = true;
        return result;
      },
    };
    await assert.rejects(applyConfirmedSwitchBundleCategory(failing), /correction_incomplete/u);
    const pending = sqlite
      .prepare("SELECT operation_id,status FROM admin_csv_import_changes")
      .get();
    assert.equal(pending?.status, "pending");
    assert.equal(await applyConfirmedSwitchBundleCategory(db), 1);
    assert.deepEqual(
      sqlite
        .prepare("SELECT operation_id,status FROM admin_csv_import_changes")
        .all()
        .map((row) => ({ ...row })),
      [{ operation_id: pending?.operation_id, status: "applied" }],
    );
    assert.equal(
      sqlite.prepare("SELECT remediation_projection_required n FROM products WHERE id=1772").get()
        ?.n,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) n FROM data_quality_remediation_events WHERE listing_product_id=1772 AND field='category'",
        )
        .get()?.n,
      1,
    );
  } finally {
    sqlite.close();
  }
});

test("a different manual category decision is preserved and requires review", async () => {
  const { db, sqlite } = database();
  try {
    await updateListingAdminProduct(db, 1772, { primaryCategoryId: "PRC.DAC" });
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    await assert.rejects(applyConfirmedSwitchBundleCategory(db), /override_conflict/u);
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=1772").get()
        ?.primary_category_id,
      "PRC.DAC",
    );
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
  } finally {
    sqlite.close();
  }
});

for (const [column, value] of [
  ["model", "M12 SWITCH IE GOLD"],
  ["raw_model", "M12 SWITCH IE GOLD 専用ケーブル"],
  ["canonical_manufacturer_id", "sotm"],
  ["source_url", "https://shop.formusic.jp/network-player/99999.html"],
] as const) {
  test(`a changed ${column} cannot inherit the old listing correction`, async () => {
    const { db, sqlite } = database();
    try {
      sqlite.prepare(`UPDATE products SET ${column}=? WHERE id=1772`).run(value);
      const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
      await assert.rejects(applyConfirmedSwitchBundleCategory(db), /target_changed/u);
      assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
    } finally {
      sqlite.close();
    }
  });
}

test("the scoped category-only correction never discards another bundle component category", async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec(
      `UPDATE products SET direct_category_ids='["SRC.STREAMER","CAB.DIGITAL"]' WHERE id=1772`,
    );
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    await assert.rejects(applyConfirmedSwitchBundleCategory(db), /secondary_categories/u);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
  } finally {
    sqlite.close();
  }
});

test("inactive or absent targets cause no correction", async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec("UPDATE products SET is_active=0 WHERE id=1772");
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal(await applyConfirmedSwitchBundleCategory(db), 0);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
    sqlite.exec("DELETE FROM products WHERE id=1772");
    assert.equal(await applyConfirmedSwitchBundleCategory(db), 0);
  } finally {
    sqlite.close();
  }
});
