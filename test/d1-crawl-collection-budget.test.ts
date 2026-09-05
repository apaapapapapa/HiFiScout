import assert from "node:assert/strict";
import { test } from "vite-plus/test";
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
import { accountReads } from "../src/db/read-accounting.js";
import { AT, NEXT, database } from "./helpers/d1-write-budget.js";

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
