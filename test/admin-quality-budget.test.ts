import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { saveDataQualityRun } from "../src/db/data-quality-repository.js";
import {
  readAdminQualityOverview,
  readAdminQualityReports,
  readAdminQualitySamples,
  readAdminQualityCandidates,
} from "../src/db/admin-quality-repository.js";
test("quality navigation and drilldowns have fixed measured D1 budgets with large unrelated history", async () => {
  const { db, dispose } = await database();
  try {
    await saveDataQualityRun(db, {
      shopKey: "audiounion",
      evaluatedAt: "2026-09-08T00:00:00.000Z",
    });
    const tableInfo: { results: { name: string }[] } = await db
      .prepare("PRAGMA table_info(data_quality_runs)")
      .all<{ name: string }>();
    const columns = tableInfo.results.map((row) => row.name).filter((name) => name !== "id");
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4000) INSERT INTO data_quality_runs(${columns.join(",")}) SELECT ${columns.map((name) => (name === "evaluated_at" ? "'2025-01-01T00:00:00.000Z'" : `base.${name}`)).join(",")} FROM data_quality_runs base CROSS JOIN n WHERE base.id=1`,
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000) INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,manufacturer_resolution_status,classification_status) SELECT id,'hifido','quality-budget-'||id,'Other','https://example.test/','','','','resolved','classified' FROM n",
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000) INSERT INTO product_correction_reports(id,listing_product_id,product_key,reason,status,created_at,updated_at) SELECT id,id,'listing:'||id,'wrong_model','accepted','','' FROM n",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO product_correction_reports(listing_product_id,product_key,reason,status,created_at,updated_at) VALUES(100001,'listing:100001','wrong_model','open','2026-09-08T01:00:00.000Z','2026-09-08T01:00:00.000Z')",
      )
      .run();
    const overview = accountReads(db);
    await readAdminQualityOverview(overview.db, [
      { key: "audiounion", name: "AU" },
      { key: "hifido", name: "HF" },
    ]);
    assert.equal(overview.statementCount(), 2);
    assert.equal(overview.rowsWritten(), 0);
    assert.ok(overview.rowsRead() < 10, `snapshot reads=${overview.rowsRead()}`);
    const reports = accountReads(db);
    const reportPage = await readAdminQualityReports(reports.db);
    assert.equal(reportPage.items.length, 1);
    assert.equal(reports.rowsWritten(), 0);
    assert.ok(reports.rowsRead() < 30, `reports reads=${reports.rowsRead()}`);
    const empty = accountReads(db);
    await readAdminQualitySamples(empty.db, "audiounion", "manufacturer", 0);
    assert.ok(empty.rowsRead() < 10, `empty sample reads=${empty.rowsRead()}`);
    const samples = accountReads(db);
    const samplePage = await readAdminQualitySamples(samples.db, "hifido", "manufacturer", 0);
    assert.equal(samplePage.scanned, 200);
    assert.equal(samplePage.hasMore, true);
    assert.equal(samples.rowsWritten(), 0);
    assert.ok(samples.rowsRead() < 1000, `sample reads=${samples.rowsRead()}`);
    const candidates = accountReads(db);
    await readAdminQualityCandidates(candidates.db);
    assert.equal(candidates.rowsWritten(), 0);
    assert.ok(candidates.rowsRead() < 10, `candidate reads=${candidates.rowsRead()}`);
    const writes = await db
      .prepare(
        "INSERT INTO product_correction_reports(listing_product_id,product_key,reason,status,created_at,updated_at) VALUES(100002,'listing:100002','wrong_model','open','2026-09-08T02:00:00.000Z','2026-09-08T02:00:00.000Z')",
      )
      .run();
    assert.ok(
      Number(writes.meta.rows_read) < 30,
      `projection update reads=${writes.meta.rows_read}`,
    );
    assert.ok(
      Number(writes.meta.rows_written) < 30,
      `projection writes=${writes.meta.rows_written}`,
    );
  } finally {
    await dispose();
  }
}, 30_000);
