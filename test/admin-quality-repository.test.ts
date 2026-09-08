import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { unstable_splitSqlQuery } from "wrangler";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import {
  readAdminQualityReports,
  readAdminQualityOverview,
  readAdminQualitySamples,
  readAdminQualityCandidates,
} from "../src/db/admin-quality-repository.js";
import { parseAdminQualityCommand } from "../src/http/admin-quality.js";
import { saveDataQualityRun } from "../src/db/data-quality-repository.js";
const addReport = (
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  id: number,
  listingId: number,
  status = "open",
  at = `2026-09-08T00:00:${String(id).padStart(2, "0")}.000Z`,
) =>
  sqlite
    .prepare(
      "INSERT INTO product_correction_reports(id,listing_product_id,product_key,reason,status,created_at,updated_at,resolved_at,snapshot_shop_key,snapshot_model) VALUES(?,?,?,'wrong_model',?,?,?,?,'audiounion','D-1000')",
    )
    .run(id, listingId, `listing:${listingId}`, status, at, at, status === "accepted" ? at : null);

test("retained correction projections rank repeated reports and follow status transitions and retention", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    addReport(sqlite, 1, 11);
    sqlite.exec(
      "UPDATE product_correction_reports SET status='in_review' WHERE id=1; UPDATE product_correction_reports SET status='accepted',resolved_at='2026-09-08T00:00:02.000Z',updated_at='2026-09-08T00:00:02.000Z' WHERE id=1;",
    );
    addReport(sqlite, 3, 11);
    addReport(sqlite, 4, 12);
    const page = await readAdminQualityReports(db);
    assert.equal(page.items[0].listingId, 11);
    assert.equal(page.items[0].recurrenceCount, 1);
    assert.equal(page.items[0].reportCount, 2);
    assert.equal(page.items[0].relatedOfferCount, null);
    sqlite.exec("DELETE FROM product_correction_reports WHERE id=1;");
    assert.equal((await readAdminQualityReports(db)).items[0].reportCount, 1);
    sqlite.exec("DELETE FROM product_correction_reports WHERE id=3;");
    const remaining = await readAdminQualityReports(db);
    assert.equal(remaining.items.length, 1);
    assert.equal(remaining.items[0].listingId, 12);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_quality_report_members").get()?.n, 1);
  } finally {
    sqlite.close();
  }
});

test("the additive migration initializes repeated-report flags for preexisting retained history", async () => {
  const { sqlite } = migratedSqlite({ before: "0116_admin_quality_priority.sql" });
  try {
    addReport(sqlite, 1, 11, "accepted");
    addReport(sqlite, 3, 11);
    addReport(sqlite, 4, 12);
    // Exercise the pinned deployment splitter, including CASE expressions inside triggers.
    const sql = migrationSources.find((row) => row.name === "0116_admin_quality_priority.sql")!.sql;
    for (const statement of unstable_splitSqlQuery(sql)) sqlite.exec(statement);
    const group = sqlite
      .prepare("SELECT * FROM admin_quality_report_groups WHERE target_key='listing:11'")
      .get();
    assert.equal(group?.recurrence_count, 1);
    assert.equal(group?.open_count, 1);
    assert.equal(group?.report_count, 2);
  } finally {
    sqlite.close();
  }
});

test("quality overview reuses latest saved snapshots and identifies shops without observations", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    await saveDataQualityRun(db, {
      shopKey: "audiounion",
      evaluatedAt: "2026-09-08T00:00:00.000Z",
    });
    sqlite.exec(
      "UPDATE data_quality_runs SET manufacturer_missing_count=5,manufacturer_unresolved_count=3,category_unclassified_count=2,manufacturer_status='critical',category_status='warning',total_items=100 WHERE shop_key='audiounion'",
    );
    const writes = sqlite.prepare("SELECT total_changes() n").get()?.n;
    const result = await readAdminQualityOverview(db, [
      { key: "audiounion", name: "AU" },
      { key: "hifido", name: "HF" },
    ]);
    assert.deepEqual(result.missingShops, [{ shopKey: "hifido", shopName: "HF" }]);
    assert.equal(result.issues[0].kind, "manufacturer");
    assert.equal(result.issues[0].count, 8);
    assert.equal(result.issues[0].total, 100);
    assert.deepEqual(result.snapshots, [
      { shopKey: "audiounion", shopName: "AU", snapshotAt: "2026-09-08T00:00:00.000Z", total: 100 },
    ]);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, writes);
  } finally {
    sqlite.close();
  }
});

test("quality sample windows advance through sparse issues without losing next-page matches", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<100230) INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,manufacturer_resolution_status,classification_status) SELECT id,'audiounion','quality-'||id,'LUXMAN D-1000','https://example.test/','','','',CASE WHEN id=100225 THEN 'unresolved' ELSE 'resolved' END,'classified' FROM n",
    );
    const first = await readAdminQualitySamples(db, "audiounion", "manufacturer", 0);
    assert.equal(first.scanned, 200);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.items, []);
    const second = await readAdminQualitySamples(
      db,
      "audiounion",
      "manufacturer",
      first.nextAfterId,
    );
    assert.equal(second.items[0].id, 100225);
    assert.equal(second.hasMore, false);
  } finally {
    sqlite.close();
  }
});

test("priority cursors cover tied report groups and saved catalog candidate priorities without duplicates", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    for (let id = 1; id <= 30; id++) addReport(sqlite, id, id, "open", "2026-09-08T00:00:00.000Z");
    const first = await readAdminQualityReports(db),
      second = await readAdminQualityReports(db, first.nextBefore!);
    assert.equal(first.items.length, 25);
    assert.equal(second.items.length, 5);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.targetKey)).size, 30);
    sqlite.exec(
      "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<100030) INSERT INTO knowledge_catalog_candidates(id,manufacturer_id,normalized_model,observed_manufacturer,observed_model,active_listing_count,priority_score,last_reviewed_at,created_at,updated_at) SELECT id,'test-brand','M'||id,'Test','M'||id,1,10,'','','' FROM n",
    );
    const a = await readAdminQualityCandidates(db),
      b = await readAdminQualityCandidates(db, a.nextBefore!);
    assert.equal(a.items.length, 25);
    assert.equal(b.items.length, 5);
    assert.equal(new Set([...a.items, ...b.items].map((row) => row.id)).size, 30);
  } finally {
    sqlite.close();
  }
});

test("quality API rejects unregistered shops and malformed cursors", () => {
  assert.equal(
    parseAdminQualityCommand({
      action: "samples",
      shopKey: "unknown",
      kind: "manufacturer",
      afterId: 0,
    }),
    null,
  );
  assert.equal(
    parseAdminQualityCommand({ action: "reports", before: [1, 2, "date", "key"] }),
    null,
  );
  assert.equal(
    parseAdminQualityCommand({
      action: "samples",
      shopKey: "audiounion",
      kind: ["manufacturer"],
      afterId: 0,
    }),
    null,
  );
});
