import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  getCrawlWorkloadObservation,
  listCrawlWorkloadObservations,
  recordCrawlWorkloadObservation,
} from "../src/db/crawl-workload-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const SHOP = "ippinkan";

test("observed workload only ever moves up", async () => {
  const { db } = migratedSqlite();

  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 745,
    budgetExhausted: false,
    observedAt: "2026-08-25T00:00:00.000Z",
  });
  // A quiet crawl is not evidence that the shop shrank; it is one observation of a shop that has
  // already been seen at 745. Letting it lower the mark is what makes a lane flap.
  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 12,
    budgetExhausted: false,
    observedAt: "2026-08-25T01:00:00.000Z",
  });

  const observation = await getCrawlWorkloadObservation(db, SHOP);
  assert.equal(observation?.peakItemCount, 745);
  assert.equal(observation?.budgetExhaustedCount, 0);
  assert.equal(observation?.lastBudgetExhaustedAt, null);
});

test("handing derived work to the sweep is counted and dated", async () => {
  const { db } = migratedSqlite();

  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 40,
    budgetExhausted: true,
    observedAt: "2026-08-25T00:00:00.000Z",
  });
  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 40,
    budgetExhausted: false,
    observedAt: "2026-08-25T01:00:00.000Z",
  });
  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 40,
    budgetExhausted: true,
    observedAt: "2026-08-25T02:00:00.000Z",
  });

  const observation = await getCrawlWorkloadObservation(db, SHOP);
  assert.equal(observation?.budgetExhaustedCount, 2);
  assert.equal(observation?.lastBudgetExhaustedAt, "2026-08-25T02:00:00.000Z");
});

test("a shop with no completed crawl has no observation to schedule from", async () => {
  const { db } = migratedSqlite();
  await recordCrawlWorkloadObservation(db, SHOP, {
    itemCount: 3,
    budgetExhausted: false,
    observedAt: "2026-08-25T00:00:00.000Z",
  });

  assert.equal(await getCrawlWorkloadObservation(db, "home-shokai"), null);
  const all = await listCrawlWorkloadObservations(db);
  assert.deepEqual([...all.keys()], [SHOP]);
});
