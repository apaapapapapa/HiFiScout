import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  scanManufacturerImpact,
  applyManufacturerRegistry,
  manufacturerRevision,
  registryVersion,
  readManufacturerRegistry,
} from "../src/db/admin-manufacturer-management.js";
test("manufacturer scans and retry receipts have fixed D1 budgets amid unrelated inventory", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(
        "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000) INSERT INTO products(id,shop_key,is_active,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at) SELECT id,'hifido',id%2,'budget-'||id,'Other','https://example.test/','','','' FROM n",
      )
      .run();
    const measured = accountReads(db);
    const page = await scanManufacturerImpact(
      measured.db,
      { manufacturerId: "luxman", shopKey: "audiounion", keys: ["デモラボ"] },
      0,
      104000,
      5,
    );
    assert.equal(page.scanned, 0);
    assert.equal(measured.statementCount(), 2);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 20, `scoped reads=${measured.rowsRead()}`);
    const global = accountReads(db);
    await scanManufacturerImpact(
      global.db,
      { manufacturerId: "luxman", shopKey: "", keys: ["デモラボ"] },
      0,
      104000,
      5,
    );
    assert.ok(global.rowsRead() < 60, `global reads=${global.rowsRead()}`);
    const edit = {
      manufacturerId: "luxman",
      canonicalName: "LUXMAN",
      nameJa: "",
      nameEn: "",
      alias: { alias: "デモラボ", shopKey: "audiounion", enabled: true },
    };
    const revision = await manufacturerRevision(await registryVersion(db), edit),
      id = crypto.randomUUID();
    await applyManufacturerRegistry(db, edit, revision, id);
    const retry = accountReads(db);
    await applyManufacturerRegistry(retry.db, edit, revision, id);
    assert.equal(retry.statementCount(), 1);
    assert.equal(retry.rowsWritten(), 0);
    assert.ok(retry.rowsRead() < 5);
    const detail = accountReads(db);
    await readManufacturerRegistry(detail.db, "luxman");
    assert.ok(detail.rowsRead() < 50, `detail reads=${detail.rowsRead()}`);
    assert.equal(detail.rowsWritten(), 0);
  } finally {
    await dispose();
  }
}, 30_000);
