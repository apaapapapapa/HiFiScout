import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { runRetentionCleanup } from "../src/maintenance.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database } from "./helpers/d1-write-budget.js";

const MIGRATION = "0133_evidence_archive_crawl_run.sql";
const NOW = new Date("2026-09-16T00:00:00.000Z");

async function arrange(before?: string) {
  const fixture = await database(before ? { before } : {});
  await fixture.db
    .prepare(`WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600
    )
    INSERT INTO crawl_runs(shop_key, started_at, finished_at, status)
    SELECT 'retention-budget', '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z', 'success' FROM n`)
    .run();
  await fixture.db
    .prepare(`WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000
    )
    INSERT INTO evidence_archive(
      shop_key, product_id, crawl_run_id, reason, content_hash, r2_object_key, captured_at
    )
    SELECT 'retention-budget', NULL, NULL, 'parser_failure', 'hash-' || i,
      'evidence/retention-budget/' || i, '2026-09-15T00:00:00.000Z' FROM n`)
    .run();
  return fixture;
}

async function measure(before?: string) {
  const { db, dispose } = await arrange(before);
  try {
    const measured = accountReads(db);
    const result = await runRetentionCleanup({ DB: measured.db }, { now: NOW });
    const retainedEvidence = await db
      .prepare("SELECT COUNT(*) AS count FROM evidence_archive WHERE crawl_run_id IS NULL")
      .first<{ count: number }>();
    return {
      reads: measured.rowsRead(),
      writes: measured.rowsWritten(),
      deleted: result.deleted.crawlRuns,
      retainedEvidence: Number(retainedEvidence?.count ?? 0),
    };
  } finally {
    await dispose();
  }
}

test("crawl-run retention indexes the evidence foreign key instead of rescanning its history", async () => {
  const legacy = await measure(MIGRATION);
  const indexed = await measure();

  assert.equal(legacy.deleted, 500);
  assert.equal(indexed.deleted, 500);
  assert.equal(legacy.retainedEvidence, 2000);
  assert.equal(indexed.retainedEvidence, 2000);
  assert.equal(indexed.writes, legacy.writes);
  assert.ok(legacy.reads > 900_000, JSON.stringify({ legacy, indexed }));
  assert.ok(indexed.reads < 10_000, JSON.stringify({ legacy, indexed }));
  assert.ok(indexed.reads * 100 < legacy.reads, JSON.stringify({ legacy, indexed }));

  console.log(JSON.stringify({ event: "crawl_run_retention_read_budget", legacy, indexed }));
}, 60_000);
