import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { test } from "vite-plus/test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { syncProductMetadata } from "../src/db/product-metadata-repository.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { syncProductIdentityResolutions } from "../src/db/product-identity-repository.js";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { syncProductSearchProjections } from "../src/db/product-search-projection-repository.js";
import { refreshKnowledgeCatalogCandidates } from "../src/db/knowledge-catalog-review-repository.js";
import {
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageParsed,
} from "../src/db/crawl-fetch-page-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { detailFetchOptions } from "./helpers/fixtures.js";
import {
  readCollectionSession,
  type CollectionProgressState,
} from "../src/crawler/collection-progress.js";
import { processFetch, processParse } from "../src/crawler/resumable-page-steps.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { ResumableRuntimeEnv } from "../src/crawler/resumable-queue-contract.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";

const AT = "2026-09-05T00:00:00.000Z";
const NEXT = "2026-09-05T01:00:00.000Z";
const migrations = new URL("../migrations/", import.meta.url);

/** Real workerd rows_written includes indexes, triggers and AUTOINCREMENT's sqlite_sequence. */
async function database() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } }",
      compatibilityDate: "2026-01-01",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = asQueryableDatabase(await mf.getD1Database("DB"));
    for (const name of readdirSync(migrations)
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(new URL(name, migrations), "utf8")
        .replace(/^\s*--[^\n]*$/gm, "")
        .trim();
      if (sql) await db.prepare(sql).run();
    }
    await db.prepare("DELETE FROM knowledge_catalog_products").run();
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

const listing = (sourceId: string) =>
  normalizeCatalogProduct({
    sourceId,
    manufacturer: "LUXMAN",
    model: "C10",
    title: "LUXMAN C10",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${sourceId}`,
  });

test("inline listing checkpoints reduce billed D1 writes and duplicate deliveries write zero rows", async () => {
  const { db, dispose } = await database();
  try {
    const costs: Record<string, { rowsWritten: number; rowsRead: number; statements: number }> = {};
    for (const inline of [false, true]) {
      const runId = inline ? "inline-page-budget" : "split-page-budget";
      const pages = Array.from({ length: 20 }, (_, ordinal) => ({
        key: "https://example.test/list?page=" + ordinal,
        page: "https://example.test/list?page=" + ordinal,
        ordinal,
      }));
      await ensureCrawlFetchSession(db, {
        runId,
        shopKey: runId,
        requestedAt: AT,
        maxPages: pages.length,
        pageLimit: pages.length,
        pages: [pages[0]],
        createdAt: AT,
      });
      const measured = accountReads(db);
      let sequence = 0;
      for (const [i, page] of pages.entries()) {
        if (!inline) {
          await recordCrawlFetchPageFetched(measured.db, {
            runId,
            pageKey: page.key,
            html: "<html>seller</html>",
            htmlBytes: 19,
            fetchedAt: AT,
            currentSequence: sequence++,
          });
        }
        const input = {
          runId,
          pageKey: page.key,
          products: [listing("item-" + i)],
          discoveredPages: pages[i + 1] ? [pages[i + 1]] : [],
          parsedAt: AT,
          currentSequence: sequence++,
          nextPageKey: pages[i + 1]?.key ?? null,
          coverageIncomplete: false,
          reachedEnd: false,
          ...(inline ? { fetched: { at: AT, htmlBytes: 19 } } : {}),
        };
        await recordCrawlFetchPageParsed(measured.db, input);
        const duplicate = accountReads(db);
        await recordCrawlFetchPageParsed(duplicate.db, input);
        assert.equal(
          duplicate.rowsWritten(),
          0,
          "redelivery must not update counters or insert a second frontier",
        );
      }
      const summary = await getCrawlFetchSession(db, runId);
      assert.equal(summary?.pages_fetched, 20);
      assert.equal(summary?.pages_parsed, 20);
      assert.equal(summary?.next_phase, "finalize");
      assert.equal(summary?.continuation_sequence, inline ? 20 : 40);
      assert.equal(
        await db
          .prepare(
            "SELECT COUNT(*) n FROM crawl_fetch_pages WHERE run_id = ? AND html_text IS NOT NULL",
          )
          .bind(runId)
          .first("n"),
        0,
      );
      costs[inline ? "inline" : "split"] = {
        rowsWritten: measured.rowsWritten(),
        rowsRead: measured.rowsRead(),
        statements: measured.countedStatements(),
      };
    }
    assert.ok(costs.inline.rowsWritten <= costs.split.rowsWritten * 0.75, JSON.stringify(costs));
    assert.ok(costs.inline.statements < costs.split.statements, JSON.stringify(costs));
    console.log("crawl_inline_d1_budget " + JSON.stringify(costs));
  } finally {
    await dispose();
  }
}, 30_000);

test("DO collection progress and inline parsing reduce billed D1 writes with one final checkpoint", async () => {
  const { db, dispose } = await database();
  try {
    const plugin = getShopPlugin("home-shokai")!;
    // Three full collection modes include workerd round trips; ten pages keeps the comparison
    // below the CI runner's time budget while still exercising repeated steps and one checkpoint.
    const pageCount = 10;
    const totals = new Map<string, number>();
    const costs: Record<string, { rowsWritten: number; rowsRead: number; statements: number }> = {};
    for (const mode of ["d1", "durable_object", "durable_object_inline"] as const) {
      const measured = accountReads(db);
      const env = {
        DB: measured.db,
        HOME_SHOKAI_REQUEST_DELAY_MS: "0",
      } as unknown as ResumableRuntimeEnv;
      const body = {
        shopKey: plugin.key,
        force: true,
        requestedAt:
          mode === "d1" ? AT : mode === "durable_object" ? NEXT : "2026-09-05T02:00:00.000Z",
        collectionRunId: `budget:${mode}`,
      };
      const state: CollectionProgressState | undefined =
        mode !== "d1" ? { value: null } : undefined;
      await ensureCrawlFetchSession(measured.db, {
        runId: body.collectionRunId,
        shopKey: plugin.key,
        requestedAt: body.requestedAt,
        createdAt: AT,
        progressStorage: mode === "d1" ? "d1" : "durable_object",
        maxPages: pageCount,
        pageLimit: pageCount,
        pages: Array.from({ length: pageCount }, (_, ordinal) => ({
          key: `https://www.homeshokai.jp/itemlist.php?a=${ordinal + 2}`,
          page: `https://www.homeshokai.jp/itemlist.php?a=${ordinal + 2}`,
          ordinal,
        })),
      });
      for (let page = 0; page < pageCount; page += 1) {
        for (const step of mode === "durable_object_inline"
          ? [processFetch]
          : [processFetch, processParse]) {
          const session = await readCollectionSession(measured.db, body.collectionRunId, state);
          assert.ok(session);
          await step(env, plugin, session, body, {
            collectionProgress: state,
            parseFetchedPage: mode === "durable_object_inline",
            fetchHtmlPage: async () =>
              '<a href="/item.php?z=1001">LUXMAN プリメインアンプ L-505 〇委託販売品 ￥250,000 -</a>',
          });
        }
      }
      const checkpoint = await getCrawlFetchSession(db, body.collectionRunId);
      assert.equal(checkpoint?.pages_fetched, pageCount);
      assert.equal(checkpoint?.pages_parsed, pageCount);
      assert.equal(checkpoint?.next_phase, "finalize");
      const count = await db
        .prepare("SELECT SUM(item_count) n FROM crawl_fetch_pages WHERE run_id=?")
        .bind(body.collectionRunId)
        .first("n");
      assert.equal(count, pageCount, "fixture must exercise the nonempty-page index");
      assert.ok(measured.rowsRead() < 1500, `collection read ${measured.rowsRead()} rows`);
      totals.set(mode, measured.rowsWritten());
      costs[mode] = {
        rowsWritten: measured.rowsWritten(),
        rowsRead: measured.rowsRead(),
        statements: measured.countedStatements(),
      };
    }
    assert.equal(totals.get("d1"), 4 + 13 * pageCount);
    assert.equal(totals.get("durable_object"), 4 + 9 * pageCount + 2);
    assert.ok(totals.get("durable_object_inline")! <= totals.get("durable_object")! * 0.8);
    assert.ok(costs.durable_object_inline.rowsRead < costs.durable_object.rowsRead);
    assert.ok(costs.durable_object_inline.statements < costs.durable_object.statements);
    console.log("crawl_do_inline_d1_budget " + JSON.stringify(costs));
  } finally {
    await dispose();
  }
}, 30_000);

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
    assert.ok(changed.rowsWritten() <= 16, `price/history wrote ${changed.rowsWritten()} rows`);
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
