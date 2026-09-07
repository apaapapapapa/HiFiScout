import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseCatalogSpecifications } from "../src/api/catalog-specification-contracts.js";
import {
  readCatalogSpecifications,
  updateCatalogSpecifications,
} from "../src/db/catalog-specification-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { isCompleteExportTable } from "../src/export/complete-csv.js";
import { isProductSearchItem } from "../frontend/api-client.js";
import { productSearchDetail } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { entityRow } from "./helpers/product-search.js";

const specification = {
  widthMm: 440,
  heightMm: null,
  depthMm: 400,
  weightKg: 12.5,
  inputs: [{ connector: "RCA ライン", count: 3 }],
  outputs: [],
  main: [{ name: "定格出力", value: "100 W / 8 Ω" }],
  sourceUrl: "https://example.test/manual",
};

test("specifications distinguish unrecorded from no ports and reject invalid units or sources", () => {
  assert.deepEqual(parseCatalogSpecifications(specification), specification);
  assert.equal(parseCatalogSpecifications({ ...specification, inputs: null })?.inputs, null);
  for (const invalid of [
    { widthMm: 0 },
    { weightKg: -1 },
    { depthMm: Infinity },
    { heightMm: "20" },
    { inputs: [{ connector: "RCA", count: 0 }] },
    { inputs: [{ connector: "RCA", count: 1.5 }] },
    { inputs: Array.from({ length: 17 }, (_, i) => ({ connector: `port${i}`, count: null })) },
    {
      main: [
        { name: "出力", value: "1 W" },
        { name: "出力", value: "2 W" },
      ],
    },
    { sourceUrl: "javascript:alert(1)" },
    { sourceUrl: "https://user:secret@example.test/" },
  ])
    assert.equal(parseCatalogSpecifications({ ...specification, ...invalid }), null);
});

test("specification storage is bounded, idempotent, exported and linked only to the selected model", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      `INSERT INTO knowledge_catalog_products (id, manufacturer_id, canonical_model, normalized_model, created_at, updated_at) VALUES (9000001, 'luxman', 'test', 'TEST', '2026-09-07', '2026-09-07'), (9000002, 'luxman', 'test2', 'TEST2', '2026-09-07', '2026-09-07')`,
    );
    assert.equal(await readCatalogSpecifications(db, 999), null);
    assert.deepEqual(await readCatalogSpecifications(db, 9000001), {
      productId: 9000001,
      specifications: null,
    });
    const saved = await updateCatalogSpecifications(db, 9000001, specification);
    assert.equal(saved?.specifications?.widthMm, 440);
    const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
    assert.deepEqual(await updateCatalogSpecifications(db, 9000001, specification), saved);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.deepEqual(await readCatalogSpecifications(db, 9000002), {
      productId: 9000002,
      specifications: null,
    });
    await assert.rejects(
      updateCatalogSpecifications(db, 9000001, { ...specification, widthMm: -1 }),
    );
    assert.equal(isCompleteExportTable("catalog_product_specifications"), true);
  } finally {
    sqlite.close();
  }
});

test("detail maps source-backed specifications without a separate catalog-wide query", async () => {
  const db = captureDatabase(({ sql }) =>
    sql.includes("FROM product_search_entities e")
      ? [
          {
            ...entityRow(),
            specification_json: JSON.stringify(specification),
            specifications_updated_at: "2026-09-07T00:00:00Z",
          },
        ]
      : [],
  );
  const detail = await productSearchDetail(db, "c-1");
  assert.equal(detail?.product.specifications?.widthMm, 440);
  assert.match(db.calls[0].sql, /LEFT JOIN catalog_product_specifications/);
  assert.equal(isProductSearchItem(detail?.product), true);
  assert.equal(
    isProductSearchItem({
      ...detail!.product,
      specifications: { ...detail!.product.specifications, inputs: "RCA" },
    }),
    false,
  );
});
