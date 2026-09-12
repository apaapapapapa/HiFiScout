import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import { readCatalogSpecifications } from "../src/db/catalog-specification-repository.js";

test("reviewed specifications seed only exact verified models and preserve existing decisions", async () => {
  const name = "0119_verified_luxman_specifications.sql";
  const { sqlite, db } = migratedSqlite({ before: name });
  try {
    const insert = sqlite.prepare(`INSERT OR IGNORE INTO knowledge_catalog_products
      (id,manufacturer_id,canonical_model,normalized_model,verification_status,created_at,updated_at)
      VALUES (?,'luxman',?,?,?,'2026-09-11','2026-09-11')`);
    insert.run(9000001, "D-07X", "D-07X", "verified");
    insert.run(9000002, "D-10X", "D-10X", "verified");
    const smallerId = Number(
      sqlite
        .prepare(
          "SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='luxman' AND normalized_model='D-07X'",
        )
        .get()!.id,
    );
    const largerId = Number(
      sqlite
        .prepare(
          "SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='luxman' AND normalized_model='D-10X'",
        )
        .get()!.id,
    );
    insert.run(9000003, "D-10X Special", "D-10X SPECIAL", "verified");
    const migration = migrationSources.find((s) => s.name === name)!.sql;
    sqlite.exec(migration);
    const smaller = (await readCatalogSpecifications(db, smallerId))!.specifications!;
    const larger = (await readCatalogSpecifications(db, largerId))!.specifications!;
    assert.deepEqual(
      [smaller.widthMm, smaller.heightMm, smaller.depthMm, smaller.weightKg],
      [440, 132, 410, 17],
    );
    assert.deepEqual(
      [larger.widthMm, larger.heightMm, larger.depthMm, larger.weightKg],
      [440, 154, 418, 22.4],
    );
    assert.equal(larger.inputs!.find((p) => p.connector === "光デジタル")!.count, 2);
    assert.equal((await readCatalogSpecifications(db, 9000003))!.specifications, null);
    const ports = sqlite
      .prepare(`SELECT direction,connector,port_count FROM catalog_specification_ports
      WHERE catalog_product_id=? ORDER BY connector`)
      .all(largerId);
    assert.deepEqual(
      ports.map((p) => ({ ...p })),
      [
        { direction: "output", connector: "RCA", port_count: 1 },
        { direction: "output", connector: "XLR", port_count: 1 },
      ],
    );
    sqlite
      .prepare(
        `UPDATE catalog_product_specifications SET updated_at='2026-09-12T00:00:00Z' WHERE catalog_product_id=?`,
      )
      .run(smallerId);
    const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.equal(
      (await readCatalogSpecifications(db, smallerId))!.specifications!.updatedAt,
      "2026-09-12T00:00:00Z",
    );
  } finally {
    sqlite.close();
  }
});
