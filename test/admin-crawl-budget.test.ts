import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { readAdminCrawls } from "../src/crawler/admin-crawl.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";

test("crawl overview reads only shop state regardless of the listing inventory", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<2000)
      INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
      SELECT id,'test','source-'||id,'title','https://example.test/'||id,'','','' FROM n`)
      .run();
    for (const shop of SHOP_PLUGINS)
      await db
        .prepare("INSERT OR IGNORE INTO shop_sync_state(shop_key) VALUES (?)")
        .bind(shop.key)
        .run();
    const measured = accountReads(db);
    let doReads = 0;
    const env = {
      DB: measured.db,
      CRAWL_SCHEDULER: {
        idFromName: (key: string) => key,
        get: () => ({
          fetch: async () => {
            doReads++;
            return Response.json({
              paused: false,
              running: false,
              nextAlarmAt: null,
              acceptedAt: null,
              jobId: null,
              stage: "idle",
              pagesFetched: null,
              pagesParsed: null,
              progressAt: null,
            });
          },
        }),
      },
    } as unknown as Env;
    const overview = await readAdminCrawls(env);
    assert.equal(overview.items.length, SHOP_PLUGINS.length);
    assert.equal(doReads, SHOP_PLUGINS.length);
    assert.equal(measured.statementCount(), 1);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() <= SHOP_PLUGINS.length + 1, `reads=${measured.rowsRead()}`);
  } finally {
    await dispose();
  }
}, 30_000);
