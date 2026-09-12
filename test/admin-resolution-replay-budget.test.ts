import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  scanAdminResolutionReplay,
  needsAdminResolutionReplay,
} from "../src/db/admin-resolution-replay.js";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database } from "./helpers/d1-write-budget.js";

test("admin resolution replay shares eligibility and bounds discovery and point checks as the inventory grows", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,model_resolver_version,metadata_json)
        SELECT i,'budget',CAST(i AS TEXT),'test','https://example.test/'||i,'','','',?,? FROM n`)
        .bind(
          previous + 1,
          size,
          RESOLUTION_VERSIONS.model,
          JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
        )
        .run();
      const measured = accountReads(db);
      const page = await scanAdminResolutionReplay(measured.db, 0, size);
      assert.equal(page.scanned, 25);
      assert.deepEqual(page.ids, []);
      assert.equal(page.complete, false);
      assert.equal(await needsAdminResolutionReplay(measured.db, size), false);
      costs.push({
        size,
        reads: measured.rowsRead(),
        writes: measured.rowsWritten(),
        statements: measured.statementCount(),
      });
      previous = size;
    }
    assert.ok(
      costs.every((c) => c.reads <= 30 && c.writes === 0 && c.statements === 2),
      JSON.stringify(costs),
    );
    assert.ok(costs[1].reads <= costs[0].reads + 1, JSON.stringify(costs));
    await db
      .prepare(
        "UPDATE products SET metadata_json=json_set(metadata_json,'$.categoryClassification.version',?) WHERE id=10000",
      )
      .bind(RESOLUTION_VERSIONS.category - 1)
      .run();
    const tail = await scanAdminResolutionReplay(db, 9999, 10000);
    assert.deepEqual(tail.ids, [10000]);
    assert.equal(tail.complete, true);
    assert.equal(await needsAdminResolutionReplay(db, 10000), true);
    // Missing/legacy category versions, simultaneous drift, pending projections, and inactive rows
    // must agree between discovery and the point check used after a crawl may have changed the row.
    const cases = [
      { model: 1, category: RESOLUTION_VERSIONS.category, active: 1, pending: 0, expected: true },
      { model: 1, category: 1, active: 1, pending: 0, expected: true },
      {
        model: RESOLUTION_VERSIONS.model,
        category: undefined,
        active: 1,
        pending: 0,
        expected: true,
      },
      { model: RESOLUTION_VERSIONS.model, category: null, active: 1, pending: 0, expected: true },
      {
        model: RESOLUTION_VERSIONS.model,
        category: String(RESOLUTION_VERSIONS.category),
        active: 1,
        pending: 0,
        expected: false,
      },
      {
        model: RESOLUTION_VERSIONS.model + 1,
        category: RESOLUTION_VERSIONS.category + 1,
        active: 1,
        pending: 0,
        expected: false,
      },
      {
        model: RESOLUTION_VERSIONS.model,
        category: RESOLUTION_VERSIONS.category,
        active: 1,
        pending: 1,
        expected: true,
      },
      { model: 1, category: 1, active: 0, pending: 1, expected: false },
    ];
    for (const [i, sample] of cases.entries()) {
      const id = i + 1;
      await db
        .prepare(
          "UPDATE products SET model_resolver_version=?,metadata_json=?,is_active=?,remediation_projection_required=? WHERE id=?",
        )
        .bind(
          sample.model,
          JSON.stringify({ categoryClassification: { version: sample.category } }),
          sample.active,
          sample.pending,
          id,
        )
        .run();
      assert.equal(
        await needsAdminResolutionReplay(db, id),
        sample.expected,
        JSON.stringify(sample),
      );
    }
    const page = await scanAdminResolutionReplay(db, 0, 10000);
    assert.deepEqual(
      page.ids,
      cases.flatMap((sample, i) => (sample.expected ? [i + 1] : [])),
    );
    console.log(JSON.stringify({ event: "admin_resolution_replay_scan_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
