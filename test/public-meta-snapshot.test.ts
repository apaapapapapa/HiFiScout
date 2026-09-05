import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { meta } from "../src/http/meta.js";
import {
  PUBLIC_META_REFRESH_MS,
  refreshPublicMetaSnapshot,
  readPublicMetaSnapshot,
} from "../src/db/public-meta-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase, assertNoGrowingTableScans } from "./helpers/query-plan.js";

const AT = new Date("2030-01-01T00:00:00.000Z");

test("public metadata reads a stored snapshot and fresh sync state without catalog aggregation", async () => {
  const { sqlite, db } = migratedSqlite();
  const insert =
    sqlite.prepare(`INSERT INTO products(shop_key, source_id, manufacturer, manufacturer_id,
    title, source_url, first_seen_at, last_seen_at, last_changed_at)
    VALUES ('hifido', ?, 'LUXMAN', 'luxman', 'C10', 'https://example.test/p', ?, ?, ?)`);
  let size = 0;
  for (const count of [100, 1_000, 10_000]) {
    sqlite.exec("BEGIN");
    while (size < count) {
      insert.run(String(++size), AT.toISOString(), AT.toISOString(), AT.toISOString());
    }
    sqlite.exec("COMMIT");
    sqlite.exec("UPDATE public_meta_snapshot SET generated_at = '2000-01-01'");
    await refreshPublicMetaSnapshot(db, AT);
    const recording = recordingDatabase(db);
    const result = await meta({ DB: recording.db } as unknown as Env);
    assert.equal(result.shops.find((shop) => shop.key === "hifido")?.activeProductCount, count);
    assert.equal(
      result.manufacturerFacets?.find((facet) => facet.name === "LUXMAN")?.activeProductCount,
      count,
    );
    assert.equal(result.taxonomyHealth?.activeProductCount, count);
    assert.equal(result.countsUpdatedAt, AT.toISOString());
    assert.equal(recording.executed.length, 2);
    assertNoGrowingTableScans(sqlite, recording.executed, {
      allowances: [
        {
          tables: ["shop_sync_state"],
          when: /SELECT \* FROM shop_sync_state/,
          reason: "One state row per authored shop, independent of listings and history",
        },
      ],
    });
    assert.ok(
      recording.executed.every(
        (query) => !/products|facet_facts|public_meta_aggregate/.test(query.sql),
      ),
    );
  }
  sqlite.exec(
    `INSERT INTO shop_sync_state(shop_key, last_success_at) VALUES ('hifido', '2030-01-01T00:05:00Z')`,
  );
  const live = await meta({ DB: db } as unknown as Env);
  assert.equal(
    live.shops.find((shop) => shop.key === "hifido")?.sync?.last_success_at,
    "2030-01-01T00:05:00Z",
  );
  assert.equal(
    live.countsUpdatedAt,
    AT.toISOString(),
    "sync reads must not refresh catalog counts",
  );
});

test("snapshot refresh skips fresh aggregates, atomically retains old counts on failure, and recovers", async () => {
  const { sqlite, db } = migratedSqlite();
  let aggregations = 0;
  const empty = JSON.stringify(Array.from({ length: 4 }, () => ({ results: [] })));
  sqlite.function("observe_aggregate", () => {
    aggregations += 1;
    return empty;
  });
  sqlite.exec(
    "DROP VIEW public_meta_aggregate; CREATE VIEW public_meta_aggregate AS SELECT observe_aggregate() AS payload_json",
  );
  await refreshPublicMetaSnapshot(db, AT);
  assert.equal(aggregations, 1);
  const previous = await readPublicMetaSnapshot(db);
  assert.equal(
    (await refreshPublicMetaSnapshot(db, new Date(AT.getTime() + PUBLIC_META_REFRESH_MS - 1)))
      .refreshed,
    false,
  );
  assert.equal(aggregations, 1, "freshness must short-circuit before the aggregate view runs");

  const due = new Date(AT.getTime() + PUBLIC_META_REFRESH_MS);
  sqlite.exec(
    "CREATE TRIGGER fail_snapshot BEFORE UPDATE ON public_meta_snapshot BEGIN SELECT RAISE(ABORT, 'test refresh failure'); END",
  );
  await assert.rejects(refreshPublicMetaSnapshot(db, due), /test refresh failure/);
  assert.deepEqual(await readPublicMetaSnapshot(db), previous);
  sqlite.exec("DROP TRIGGER fail_snapshot");
  assert.equal((await refreshPublicMetaSnapshot(db, due)).refreshed, true);
  assert.equal((await readPublicMetaSnapshot(db)).generatedAt, due.toISOString());
  sqlite.exec("DELETE FROM public_meta_snapshot");
  await refreshPublicMetaSnapshot(db, due);
  assert.equal((await readPublicMetaSnapshot(db)).generatedAt, due.toISOString());
});

test("category and facet snapshots still count entities, while shops count listings", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite.exec(`
    INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
    VALUES (1, 'hifido', 'a', 'a', 'https://example.test/a', '2026', '2026', '2026'),
           (2, 'audioshop', 'b', 'b', 'https://example.test/b', '2026', '2026', '2026');
    INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id)
    VALUES (1, 'l-1', 'unresolved_listing', 1);
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    VALUES (1, 1, 'hifido'), (2, 1, 'audioshop');
    INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct) VALUES (1, 'AMP.PRE', 1);
    INSERT INTO product_facet_facts(product_id, facet_id, facet_value, source, confidence, verified_at)
    VALUES (1, 'test', 'shared', 'test', 1, '2026'), (2, 'test', 'shared', 'test', 1, '2026');
  `);
  await refreshPublicMetaSnapshot(db, AT);
  const snapshot = await readPublicMetaSnapshot(db);
  assert.equal(
    snapshot.batches[1]?.results.find((row) => row.value === "AMP.PRE")?.active_product_count,
    1,
  );
  assert.equal(
    snapshot.batches[2]?.results.find((row) => row.facet_id === "test")?.active_product_count,
    1,
  );
  assert.equal(
    snapshot.batches[0]?.results
      .filter((row) => row.facet_kind === "shop")
      .reduce((sum, row) => sum + Number(row.active_product_count), 0),
    2,
  );
});
