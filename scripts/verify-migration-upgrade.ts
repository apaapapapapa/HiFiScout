import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkMigrationHistory } from "./lib/migration-history.js";
import { applyMigration, localD1 } from "../test/helpers/local-d1.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { backfillRecentPriceIndexes } from "../src/db/knowledge-catalog-price-index-recent-refresh.js";

const root = process.cwd();
const history = checkMigrationHistory(root, process.env.MIGRATION_BASE_REF || "origin/main");
mkdirSync(join(root, ".generated"), { recursive: true });
const previousRoot = mkdtempSync(join(root, ".generated/migration-upgrade-"));

async function runtime(directory: string) {
  const moduleAt = (path: string): Promise<unknown> =>
    import(pathToFileURL(join(directory, path)).href);
  return {
    ...((await moduleAt("src/http/meta.ts")) as typeof import("../src/http/meta.js")),
    ...((await moduleAt("frontend/api-client.ts")) as typeof import("../frontend/api-client.js")),
    ...((await moduleAt(
      "src/db/product-search-repository.ts",
    )) as typeof import("../src/db/product-search-repository.js")),
    ...((await moduleAt(
      "src/api/product-query.ts",
    )) as typeof import("../src/api/product-query.js")),
    ...((await moduleAt(
      "src/catalog/product-normalizer.ts",
    )) as typeof import("../src/catalog/product-normalizer.js")),
    ...((await moduleAt(
      "src/db/product-write-repository.ts",
    )) as typeof import("../src/db/product-write-repository.js")),
    ...((await moduleAt(
      "src/db/product-identity-repository.ts",
    )) as typeof import("../src/db/product-identity-repository.js")),
    ...((await moduleAt(
      "src/db/product-search-projection-repository.ts",
    )) as typeof import("../src/db/product-search-projection-repository.js")),
    ...((await moduleAt(
      "src/db/product-search-entity-repository.ts",
    )) as typeof import("../src/db/product-search-entity-repository.js")),
  };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;
const AT = "2026-09-05T00:00:00.000Z";

async function crawl(
  code: Runtime,
  db: QueryableDatabase,
  price: number,
  at: string,
  sellerModel = "C10",
) {
  const products = [
    code.normalizeCatalogProduct({
      sourceId: "upgrade-fixture",
      manufacturer: "LUXMAN",
      model: sellerModel,
      title: "LUXMAN C10",
      conditionText: "中古",
      priceYen: price,
      stockStatus: "in_stock",
      sourceUrl: "https://example.test/upgrade-fixture",
    }),
  ];
  await code.upsertProducts(db, "hifido", products, at);
  await code.syncProductSearchProjections(db, "hifido", ["upgrade-fixture"]);
  await code.syncProductIdentityResolutions(db, "hifido", ["upgrade-fixture"]);
  await code.syncProductSearchEntities(db, "hifido", ["upgrade-fixture"]);
}

async function seed(code: Runtime, db: QueryableDatabase) {
  await db
    .prepare(`
    DELETE FROM knowledge_catalog_products;
    INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','${AT}','${AT}');
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
      VALUES (1,'luxman','C10','C10','LUXMAN C10','verified','${AT}','${AT}');
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES (2,'luxman','M20','M20','LUXMAN M20','${AT}','${AT}');
    INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES (1,'AMP.PRE',1);
    INSERT INTO knowledge_catalog_price_index_samples(event_key,catalog_product_id,listing_product_id,shop_key,source_id,sample_kind,signal_kind,price_yen,observed_at)
      VALUES ('upgrade-second-product',2,9999,'fixture','second','asking','asking',50000,'${AT}');
    INSERT OR REPLACE INTO shop_sync_state(shop_key,last_success_at,last_item_count) VALUES ('hifido','${AT}',1);
  `)
    .run();
  await crawl(code, db, 100000, AT);
  await crawl(code, db, 90000, "2026-09-05T00:01:00.000Z");
  await db
    .prepare(`
    INSERT INTO product_admin_overrides(listing_product_id,model,normalized_model,created_at,updated_at)
      SELECT id,'C10','C10','${AT}','${AT}' FROM products WHERE source_id='upgrade-fixture';
    UPDATE knowledge_catalog_price_index_recent_backfill_runs SET after_catalog_product_id=0,status='running',completed_at=NULL;
    UPDATE knowledge_catalog_price_indexes SET recent_asking_median_yen=NULL;
  `)
    .run();
}

async function preservedData(db: QueryableDatabase) {
  const queries = [
    "SELECT id,shop_key,source_id,first_seen_at,price_yen,model,normalized_model FROM products WHERE source_id='upgrade-fixture' ORDER BY id",
    "SELECT h.id,h.product_id,h.price_yen,h.observed_at FROM price_history h JOIN products p ON p.id=h.product_id WHERE p.source_id='upgrade-fixture' ORDER BY h.id",
    "SELECT listing_product_id,model,created_at FROM product_admin_overrides ORDER BY listing_product_id",
    "SELECT listing_product_id,catalog_product_id,status FROM product_identity_resolutions ORDER BY listing_product_id",
  ];
  return Promise.all(queries.map(async (sql) => (await db.prepare(sql).all()).results));
}

async function probe(server: Runtime, browser: Runtime, db: QueryableDatabase, stage: string) {
  const metadata: unknown = JSON.parse(
    JSON.stringify(await server.meta({ DB: db } as unknown as Env)),
  );
  assert.ok(browser.isMetaResponse(metadata), `${stage}: metadata/browser contract`);
  const response = await server.searchProducts(
    db,
    server.parseProductQuery(new URL("https://example.test/api/products?q=LUXMAN+C10")),
  );
  const serialized: unknown = JSON.parse(JSON.stringify(response));
  assert.ok(browser.isProductsResponse(serialized), `${stage}: search/browser contract`);
  assert.equal(response.items.length, 1, `${stage}: seeded product remains searchable`);
  assert.equal(
    response.items[0]?.representative_offer?.price_yen,
    90000,
    `${stage}: latest price is preserved`,
  );
  assert.deepEqual(
    (await db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
    `${stage}: foreign keys`,
  );
}

async function schema(db: QueryableDatabase) {
  return (
    await db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name",
      )
      .all()
  ).results;
}

try {
  const archive = execFileSync("git", ["archive", history.baseSha, "src", "frontend"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", previousRoot], { input: archive });
  writeFileSync(join(previousRoot, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(root, "node_modules"), join(previousRoot, "node_modules"), "dir");
  const previous = await runtime(previousRoot);
  const current = await runtime(root);
  const upgraded = await localD1();
  try {
    for (const migration of history.baseline) await applyMigration(upgraded.db, migration);
    await seed(previous, upgraded.db);
    const preserved = await preservedData(upgraded.db);
    assert.equal(preserved[1]?.length, 2, "fixture must contain real price history");
    await probe(previous, previous, upgraded.db, "baseline");
    for (const migration of history.additions) {
      await applyMigration(upgraded.db, migration);
      await probe(previous, previous, upgraded.db, `previous runtime after ${migration.name}`);
      assert.deepEqual(
        await preservedData(upgraded.db),
        preserved,
        `${migration.name}: durable data`,
      );
    }
    await probe(current, previous, upgraded.db, "new server / cached old browser, before backfill");
    await probe(previous, current, upgraded.db, "old server / new browser");
    await crawl(current, upgraded.db, 90000, "2026-09-05T02:00:00.000Z", "C99");
    assert.deepEqual(
      await preservedData(upgraded.db),
      preserved,
      "admin correction overrides new crawler's conflicting model",
    );
    await crawl(previous, upgraded.db, 90000, "2026-09-05T03:00:00.000Z", "C98");
    assert.deepEqual(
      await preservedData(upgraded.db),
      preserved,
      "new and rolled-back crawlers preserve history and overrides",
    );
    const partial = await backfillRecentPriceIndexes(upgraded.db, { now: new Date(AT), limit: 1 });
    assert.equal(partial.status, "running", "fixture must exercise a partially backfilled DB");
    await probe(current, previous, upgraded.db, "during bounded backfill");
    await probe(previous, current, upgraded.db, "old runtime during bounded backfill");
    assert.equal(
      (await backfillRecentPriceIndexes(upgraded.db, { now: new Date("2026-09-05T01:00:00.000Z") }))
        .status,
      "completed",
    );
    await probe(current, previous, upgraded.db, "after completed backfill");
    const fresh = await localD1();
    try {
      for (const migration of history.current) await applyMigration(fresh.db, migration);
      assert.deepEqual(
        await schema(upgraded.db),
        await schema(fresh.db),
        "seeded upgrade and fresh install schemas match",
      );
    } finally {
      await fresh.dispose();
    }

    // A partially executed file must roll back, while earlier successful files stay committed.
    await applyMigration(upgraded.db, {
      name: "test_committed.sql",
      sql: "CREATE TABLE upgrade_probe(id INTEGER PRIMARY KEY); INSERT INTO upgrade_probe VALUES (1);",
    });
    await assert.rejects(
      applyMigration(upgraded.db, {
        name: "test_failed.sql",
        sql: "INSERT INTO upgrade_probe VALUES (2); CREATE TABLE upgrade_rolled_back(id INTEGER); INSERT INTO missing_upgrade_table VALUES (1);",
      }),
    );
    assert.deepEqual((await upgraded.db.prepare("SELECT id FROM upgrade_probe").all()).results, [
      { id: 1 },
    ]);
    assert.equal(
      await upgraded.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='upgrade_rolled_back'")
        .first("count"),
      0,
    );
    assert.equal(
      await upgraded.db
        .prepare("SELECT COUNT(*) AS count FROM d1_migrations WHERE name='test_failed.sql'")
        .first("count"),
      0,
    );
    await applyMigration(upgraded.db, {
      name: "test_failed.sql",
      sql: "INSERT INTO upgrade_probe VALUES (2);",
    });
    await probe(previous, current, upgraded.db, "retry after failed migration");
  } finally {
    await upgraded.dispose();
  }
  console.log(
    `Seeded D1 upgrade verified against ${history.baseSha}: ${history.additions.length} new migrations, previous/current code, browser contracts, backfill, failure and retry.`,
  );
} finally {
  rmSync(previousRoot, { recursive: true, force: true });
}
