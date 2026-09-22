import { expect, it } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { productQuery } from "./helpers/product-query.js";
import { notificationCandidates, notificationEvents } from "../src/db/notification-candidates.js";
import { matchNotificationListings } from "../src/db/product-search-repository.js";
import { recordCostSample } from "../scripts/harness/cost.js";

it("reads a bounded changed-listing window and matches the very same offer among 10,000 unrelated rows", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen,previous_price_yen)
      SELECT i,CASE WHEN i=2 THEN 'fujiya-avic' ELSE 'hifido' END,CAST(i AS TEXT),'LUXMAN C10','https://example.test/'||i,
        CASE WHEN i=3 THEN 'sold_out' ELSE 'in_stock' END,
        '2026-09-22T01:00:00.000Z','2026-09-22T01:00:00.000Z',
        CASE WHEN i<=20 THEN '2026-09-22T01:00:00.000Z' ELSE '2020-01-01T00:00:00.000Z' END,
        '2020-01-01T00:00:00.000Z',CASE WHEN i=1 THEN 200000 ELSE 100000 END,120000 FROM n`)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,manufacturer,manufacturer_id,model,title_terms,model_terms)
      SELECT id,'l-'||id,'unresolved_listing',id,'LUXMAN','luxman','C10','LUXMAN C10','C10' FROM products`)
      .run();
    await db
      .prepare(
        "INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) SELECT id,CASE WHEN id=2 THEN 1 ELSE id END,shop_key FROM products",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO price_history(product_id,price_yen,observed_at) VALUES(4,100000,'2026-09-22T01:05:00.000Z')",
      )
      .run();
    const measured = measureD1Cost(db);
    const page = await notificationCandidates(
      measured.db,
      { at: "2026-09-22T00:00:00.000Z", id: 0 },
      "2026-09-22T02:00:00.000Z",
    );
    expect(page.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await notificationCandidates(db, page.at(-1)!, "2026-09-22T02:00:00.000Z")).toEqual([]);
    expect(measured.metrics().rowsRead).toBeLessThan(50);
    await recordCostSample("notification-candidates", "local-workerd", measured.metrics(), [
      "test/notification-query.test.ts",
    ]);
    const matches = measureD1Cost(db);
    const rows = await matchNotificationListings(
      matches.db,
      productQuery("?q=LUXMAN+C10&shop=hifido&maxPrice=120000"),
      page.map((row) => row.id),
    );
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 17 }, (_, i) => i + 4));
    const events = notificationEvents(rows);
    expect(events.filter((event) => event.kind === "drop").map((event) => event.listingId)).toEqual(
      [4],
    );
    expect(matches.metrics().rowsWritten).toBe(0);
    expect(matches.metrics().rowsRead).toBeLessThan(1000);
    await recordCostSample("notification-matches", "local-workerd", matches.metrics(), [
      "test/notification-query.test.ts",
    ]);
    const repeat = await matchNotificationListings(
      db,
      productQuery("?shop=hifido&maxPrice=120000"),
      [1, 2],
    );
    expect(repeat).toEqual([]);
  } finally {
    await dispose();
  }
}, 60_000);
