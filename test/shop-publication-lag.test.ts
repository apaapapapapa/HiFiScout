import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { reportShopPublicationLag } from "../scripts/lib/shop-publication-lag.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

test("publication lag keeps exact, date-only, future and missing evidence separate", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`
      CREATE TABLE shop_sync_state (shop_key TEXT PRIMARY KEY);
      CREATE TABLE products (
        shop_key TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        source_published_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    for (const shop of ["hifido", "dynamic-audio", "soundpitplus", "avac", "e-earphone"]) {
      sql.prepare("INSERT INTO shop_sync_state (shop_key) VALUES (?)").run(shop);
    }
    const insert = sql.prepare(
      "INSERT INTO products (shop_key, first_seen_at, source_published_at, metadata_json) VALUES (?, ?, ?, ?)",
    );
    insert.run("hifido", "2026-11-10T12:30:00.000Z", "2026-11-10T11:30:00.000Z", "{}");
    insert.run("hifido", "2026-11-11T04:20:00.000Z", "2026-11-11T04:00:00.000Z", "{}");
    insert.run("hifido", "2026-11-11T05:00:00.000Z", "2026-11-10T15:00:00.000Z", "{}");
    insert.run("hifido", "2026-11-12T03:00:00.000Z", "2026-11-12T04:00:00.000Z", "{}");
    insert.run(
      "dynamic-audio",
      "2026-11-10T08:00:00.000Z",
      "2026-11-09T15:00:00.000Z",
      '{"sourcePublishedPrecision":"day"}',
    );
    insert.run(
      "dynamic-audio",
      "2026-11-10T09:30:00.000Z",
      "2026-11-10T09:00:00.000Z",
      '{"sourcePublishedPrecision":"second"}',
    );
    insert.run("soundpitplus", "2026-11-10T09:00:00.000Z", "2026-11-10T08:45:00.000Z", "{}");
    // A 20-second negative lag is future evidence, not a rounded zero-minute lag.
    insert.run("soundpitplus", "2026-11-10T09:00:00.000Z", "2026-11-10T09:00:20.000Z", "{}");
    // A delay of 60m20s is outside the within-hour bucket despite rounding to 60.
    insert.run("soundpitplus", "2026-11-10T10:00:20.000Z", "2026-11-10T09:00:00.000Z", "{}");
    insert.run("avac", "2026-11-10T09:00:00.000Z", null, "{}");

    const report = await reportShopPublicationLag(
      sqliteD1(sql),
      new Date("2026-11-01T00:00:00.000Z"),
      new Date("2026-11-14T00:00:00.000Z"),
    );
    assert.equal(report.schemaVersion, 1);
    const shops = new Map(report.shops.map((row) => [row.shop_key, row]));
    assert.deepEqual(
      {
        first: shops.get("hifido")?.first_seen_count,
        sourced: shops.get("hifido")?.sourced_count,
        precise: shops.get("hifido")?.precise_count,
        day: shops.get("hifido")?.day_count,
        future: shops.get("hifido")?.future_count,
        withinHour: shops.get("hifido")?.within_hour_count,
        p50: shops.get("hifido")?.p50_minutes,
        p90: shops.get("hifido")?.p90_minutes,
      },
      { first: 4, sourced: 4, precise: 2, day: 1, future: 1, withinHour: 2, p50: 20, p90: 60 },
    );
    assert.equal(shops.get("dynamic-audio")?.day_count, 1);
    assert.equal(shops.get("dynamic-audio")?.same_day_count, 1);
    assert.equal(shops.get("dynamic-audio")?.precise_count, 1);
    assert.equal(shops.get("soundpitplus")?.precise_count, 2);
    assert.equal(shops.get("soundpitplus")?.future_count, 1);
    assert.equal(shops.get("soundpitplus")?.within_hour_count, 1);
    assert.equal(shops.get("avac")?.sourced_count, 0);
    assert.equal(shops.get("avac")?.p50_minutes, null);
    assert.equal(shops.get("e-earphone")?.first_seen_count, 0);
    await assert.rejects(
      () => reportShopPublicationLag(sqliteD1(sql), new Date("2026-11-14"), new Date("2026-11-01")),
      /valid window/,
    );
  } finally {
    sql.close();
  }
});
