import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageParsed,
} from "../src/db/crawl-fetch-page-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";

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
