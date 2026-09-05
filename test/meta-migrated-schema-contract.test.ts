import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { isMetaResponse } from "../frontend/api-client.js";
import { meta } from "../src/http/meta.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

// Exercise the actual SQL schema, server DTO mapping, JSON boundary, and browser guard together.
// A typed mock containing a retired SQL column would hide the production regression.
test("metadata from the migrated schema preserves the legacy nullable queue timestamp", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    const now = new Date().toISOString();
    sqlite
      .prepare(`
        INSERT OR REPLACE INTO shop_sync_state(
          shop_key, last_attempt_at, last_success_at, last_projection_at, last_item_count
        ) VALUES ('hifido', ?, ?, ?, 2)
      `)
      .run(now, now, now);

    const row = sqlite.prepare("SELECT * FROM shop_sync_state WHERE shop_key = 'hifido'").get();
    assert.ok(row);
    assert.equal(Object.hasOwn(row, "queued_at"), false, "the retired queue column is absent");

    const response = await meta({ DB: db } as unknown as Env);
    const shop = response.shops.find((entry) => entry.key === "hifido");
    assert.ok(shop?.sync);
    assert.equal(shop.sync.queued_at, null, "the public compatibility field must not be undefined");
    assert.equal(shop.sync.last_error, null);

    const serialized: unknown = JSON.parse(JSON.stringify(response));
    assert.equal(isMetaResponse(serialized), true, "real metadata must pass the browser guard");
  } finally {
    sqlite.close();
  }
});
