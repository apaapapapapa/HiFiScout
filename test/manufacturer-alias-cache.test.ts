import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { listManufacturerAliasEvidence } from "../src/db/manufacturer-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database } from "./helpers/d1-write-budget.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function seedAliases(sqlite: ReturnType<typeof migratedSqlite>["sqlite"], count: number): void {
  sqlite.exec(`
    INSERT INTO knowledge_catalog_manufacturers(
      id,canonical_name,verification_status,source,created_at,updated_at
    ) VALUES ('cache-brand','Cache Brand','verified','test','2026','2026');
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})
    INSERT INTO knowledge_catalog_manufacturer_aliases(
      manufacturer_id,alias,normalized_alias,verification_status,source,created_at,updated_at
    ) SELECT 'cache-brand','Alias '||i,printf('alias%04d',i),'verified','test','2026','2026' FROM n;
  `);
}

test("manufacturer alias snapshots invalidate for global, shop and canonical evidence edits", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    seedAliases(sqlite, 2);
    const cacheBrandAliases = async () =>
      (await listManufacturerAliasEvidence(db)).filter(
        (alias) => alias.manufacturerId === "cache-brand",
      );
    assert.equal((await cacheBrandAliases()).length, 2);

    sqlite.exec(`
      INSERT INTO knowledge_catalog_shop_manufacturer_aliases(
        manufacturer_id,alias,normalized_alias,verification_status,source,created_at,updated_at,shop_key
      ) VALUES ('cache-brand','Shop Alias','shopalias','verified','test','2026','2026','shop');
    `);
    assert.equal((await cacheBrandAliases()).length, 3);

    sqlite.exec(`
      UPDATE knowledge_catalog_manufacturer_aliases SET rule_version=2
      WHERE normalized_alias='alias0001';
      UPDATE knowledge_catalog_manufacturers SET canonical_name='Renamed Brand'
      WHERE id='cache-brand';
    `);
    const refreshed = await cacheBrandAliases();
    assert.equal(refreshed.find((alias) => alias.normalizedAlias === "alias0001")?.ruleVersion, 2);
    assert.ok(refreshed.every((alias) => alias.canonicalName === "Renamed Brand"));

    sqlite.exec(
      "DELETE FROM knowledge_catalog_shop_manufacturer_aliases WHERE normalized_alias='shopalias'",
    );
    assert.equal((await cacheBrandAliases()).length, 2);
  } finally {
    sqlite.close();
  }
});

test("warm manufacturer alias snapshots replace a full scan with one revision row", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`
        INSERT INTO knowledge_catalog_manufacturers(
          id,canonical_name,verification_status,source,created_at,updated_at
        ) VALUES ('cache-budget','Cache Budget','verified','test','2026','2026');
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
        INSERT INTO knowledge_catalog_manufacturer_aliases(
          manufacturer_id,alias,normalized_alias,verification_status,source,created_at,updated_at
        ) SELECT 'cache-budget','Alias '||i,printf('budgetalias%04d',i),'verified','test','2026','2026' FROM n;
      `)
      .run();

    const cold = accountReads(db);
    const first = await listManufacturerAliasEvidence(cold.db);
    assert.equal(first.filter((alias) => alias.manufacturerId === "cache-budget").length, 1000);
    const warm = accountReads(db);
    const second = await listManufacturerAliasEvidence(warm.db);
    assert.deepEqual(second, first);

    assert.ok(cold.rowsRead() > 1000, `cold rows_read=${cold.rowsRead()}`);
    assert.ok(warm.rowsRead() <= 2, `warm rows_read=${warm.rowsRead()}`);
    assert.equal(warm.rowsWritten(), 0);
    console.log(
      JSON.stringify({
        event: "manufacturer_alias_cache_d1_reads",
        cold: cold.rowsRead(),
        warm: warm.rowsRead(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);
