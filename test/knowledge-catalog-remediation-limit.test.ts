import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { selectListingsForCatalogRemediation } from "../src/db/knowledge-catalog-remediation-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";

test("catalog remediation pages multiple verified aliases within real D1 compound limits", async () => {
  const { db, dispose } = await database();
  try {
    let previous = 0;
    for (const size of [501, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,
        first_seen_at,last_seen_at,last_changed_at,is_active,
        canonical_manufacturer_id,normalized_model,model_resolution_status)
      SELECT i,'aliases',CAST(i AS TEXT),'target','https://example.test/'||i,
        ?3,?3,?3,1,'target-maker','MODEL-'||(i%20),
        CASE i%3 WHEN 0 THEN 'resolved' WHEN 1 THEN 'candidate' ELSE 'unresolved' END FROM n`)
        .bind(previous + 1, size, AT)
        .run();
      const models = Array.from({ length: 20 }, (_, i) => `MODEL-${i}`);
      for (const afterId of [0, size - 30, size]) {
        const measured = accountReads(db);
        const result = await selectListingsForCatalogRemediation(
          measured.db,
          {
            catalogProductId: 1,
            manufacturerId: "target-maker",
            canonicalModel: "MODEL-0",
            identityModels: [...models, ...models],
          },
          { afterId, limit: 25 },
        );
        assert.deepEqual(
          result.rows.map((row) => row.id),
          Array.from({ length: Math.min(25, size - afterId) }, (_, i) => afterId + i + 1),
        );
        assert.equal(result.hasMore, size - afterId > 25);
        assert.equal(measured.rowsWritten(), 0);
        assert.equal(measured.statementCount(), 4);
        assert.ok(
          measured.rowsRead() <= 60 * (26 + 3),
          JSON.stringify({ size, afterId, reads: measured.rowsRead() }),
        );
      }
      previous = size;
    }
  } finally {
    await dispose();
  }
}, 60_000);
