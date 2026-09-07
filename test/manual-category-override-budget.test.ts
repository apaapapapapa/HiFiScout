import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { applyConfirmedSwitchBundleCategory } from "../scripts/lib/confirmed-switch-bundle-category.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database, AT } from "./helpers/d1-write-budget.js";

test("confirmed category repair and repeated maintenance have bounded D1 cost", async () => {
  const { db, dispose } = await database();
  try {
    const model = "M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本";
    await db
      .prepare(`INSERT INTO products(
      id,shop_key,source_id,manufacturer,manufacturer_id,canonical_manufacturer_id,
      model,raw_model,normalized_model,model_resolution_status,model_resolution_method,
      title,source_url,first_seen_at,last_seen_at,last_changed_at,is_active,
      primary_category_id,category_ids,direct_category_ids,classification_status
    ) VALUES (1772,'formusic','31211','Telegartner','telegartner','telegartner',
      ?,?,'M12SWITCHIEGOLD20M3','candidate','unsafe_annotation',?,
      'https://shop.formusic.jp/network-player/31211.html',?,?,?,1,
      'SRC.STREAMER','["SRC.STREAMER"]','["SRC.STREAMER"]','classified')`)
      .bind(model, model, model, AT, AT, AT)
      .run();
    const correction = accountReads(db);
    assert.equal(await applyConfirmedSwitchBundleCategory(correction.db), 1);
    assert.ok(correction.rowsWritten() > 0);
    assert.ok(
      correction.rowsRead() <= 300,
      `one-listing correction read ${correction.rowsRead()} rows`,
    );
    assert.ok(
      correction.rowsWritten() <= 150,
      `one-listing correction wrote ${correction.rowsWritten()} rows`,
    );
    assert.ok(correction.countedStatements() <= 60);
    const repeated = accountReads(db);
    assert.equal(await applyConfirmedSwitchBundleCategory(repeated.db), 0);
    assert.equal(repeated.rowsWritten(), 0);
    assert.ok(repeated.rowsRead() <= 20, `one-listing no-op read ${repeated.rowsRead()} rows`);
    assert.ok(repeated.countedStatements() <= 4);
    // D1, including its real trigger execution, retains the corrected direct leaf.
    await db
      .prepare("UPDATE products SET direct_category_ids='[\"SRC.STREAMER\"]' WHERE id=1772")
      .run();
    assert.equal(
      await db
        .prepare("SELECT direct_category_ids FROM products WHERE id=1772")
        .first("direct_category_ids"),
      '["SIG.NETWORK"]',
    );
    const unchanged = accountReads(db);
    await unchanged.db
      .prepare(`UPDATE products SET direct_category_ids='["SIG.NETWORK"]'
      WHERE id=1772 AND direct_category_ids <> '["SIG.NETWORK"]'`)
      .run();
    assert.equal(unchanged.rowsWritten(), 0);
    console.log(
      JSON.stringify({
        event: "confirmed_category_correction_d1_budget",
        correction: {
          rowsRead: correction.rowsRead(),
          rowsWritten: correction.rowsWritten(),
          statements: correction.countedStatements(),
        },
        repeated: {
          rowsRead: repeated.rowsRead(),
          rowsWritten: repeated.rowsWritten(),
          statements: repeated.countedStatements(),
        },
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);
