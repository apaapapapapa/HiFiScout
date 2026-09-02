import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { dueMaintenanceTasks } from "../src/scheduled.js";
import { asQueryableDatabase } from "./helpers/d1.js";

/** Records the selector SQL each phase issues; every phase finds nothing, as a healthy tick does. */
function selectorRecorder() {
  const selectors: string[] = [];
  const db = asQueryableDatabase({
    selectors,
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        async all() {
          if (sql.includes("FROM products p")) selectors.push(sql);
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true, meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  });
  return db as typeof db & { selectors: string[] };
}

const EXACT_IDENTITY_SELECTOR = /FROM product_search_entity_offers current_membership/u;

test("the five-minute sweep runs the cheap phases and skips the identity self-join", async () => {
  const db = selectorRecorder();

  await repairActiveListingProjectionGaps(db, { includeExactIdentityPhase: false });

  assert.equal(db.selectors.length, 2, "critical coverage and stale fallback still run every tick");
  assert.equal(
    db.selectors.some((sql) => EXACT_IDENTITY_SELECTOR.test(sql)),
    false,
    "the peer scan is what the five-minute cadence could not afford",
  );
});

test("the default keeps every phase, so strict and daily callers are unchanged", async () => {
  const db = selectorRecorder();

  await repairActiveListingProjectionGaps(db);

  assert.equal(db.selectors.length, 3);
  assert.equal(
    db.selectors.filter((sql) => EXACT_IDENTITY_SELECTOR.test(sql)).length,
    1,
    "the peer scan is still reached, just not on every tick",
  );
});

test("the identity phase is scheduled hourly while the cheap sweep stays five-minutely", () => {
  const ticks = 12; // one hour of five-minute ticks
  let sweeps = 0;
  let identityPasses = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const due = dueMaintenanceTasks(new Date(tick * 5 * 60 * 1000)).map((task) => task.name);
    if (due.includes("product_search_projection_repair")) sweeps += 1;
    if (due.includes("product_search_exact_identity_repair")) identityPasses += 1;
  }

  assert.equal(sweeps, ticks, "projection repair keeps its five-minute convergence promise");
  assert.equal(identityPasses, 1, "the peer scan is paid for once an hour instead of twelve times");
});
