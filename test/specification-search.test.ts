import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import { productQuery } from "./helpers/product-query.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { updateCatalogSpecifications } from "../src/db/catalog-specification-repository.js";
import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "../src/api/product-query.js";
import { parseFeedQuery, validateFeedQuery } from "../src/api/feed-query.js";

const AT = "2026-09-07T00:00:00Z";
const specs = {
  widthMm: 440,
  heightMm: 150,
  depthMm: 400,
  weightKg: 12.5,
  inputs: [{ connector: "RCA", count: 2 }],
  outputs: [{ connector: "XLR", count: 3 }],
  main: [],
  sourceUrl: "https://example.test/official",
};

function seed(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<6)
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
    SELECT 700000+i,'fixture','Model '||i,'MODEL'||i,'${AT}','${AT}' FROM n;
    INSERT INTO product_search_entities(id,entity_key,entity_kind,catalog_product_id,model,offer_count,in_stock_offer_count,lowest_price_yen,lowest_in_stock_price_yen)
    SELECT id,'c-'||id,'catalog',id,canonical_model,1,1,id,id FROM knowledge_catalog_products WHERE id BETWEEN 700001 AND 700006;`);
}

test("specification query bounds and canonicalization are shared by search and Atom", () => {
  const url = new URL(
    "https://example.test/api/product-search?maxWidthMm=00440.000&minXlrOutputs=03&maxWeightKg=12.5",
  );
  assert.equal(validateProductQuery(url), null);
  assert.equal(validateFeedQuery(url), null);
  const query = parseProductQuery(url);
  assert.deepEqual(query.specificationFilters, {
    maxWidthMm: 440,
    maxWeightKg: 12.5,
    minXlrOutputs: 3,
  });
  assert.deepEqual(parseFeedQuery(url).specificationFilters, query.specificationFilters);
  assert.equal(canonicalProductQueryUrl(url, query).searchParams.get("maxWidthMm"), "440");
  for (const input of [
    "maxWidthMm=0",
    "maxWeightKg=NaN",
    "maxDepthMm=1e3",
    "minXlrOutputs=1.5",
    "minRcaInputs=129",
    "maxHeightMm=100001",
    "maxWidthMm=1&maxWidthMm=2",
  ]) {
    assert.ok(validateProductQuery(new URL(`https://example.test/?${input}`)), input);
  }
});

test("dimensions and connector counts intersect on one verified model and exclude unknowns", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    seed(sqlite);
    await updateCatalogSpecifications(db, 700001, specs);
    await updateCatalogSpecifications(db, 700002, { ...specs, widthMm: 460 });
    await updateCatalogSpecifications(db, 700003, {
      ...specs,
      outputs: [{ connector: "XLR", count: null }],
    });
    await updateCatalogSpecifications(db, 700004, { ...specs, widthMm: null });
    await updateCatalogSpecifications(db, 700005, specs);
    sqlite.exec(
      "UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=700005",
    );
    await updateCatalogSpecifications(db, 700006, {
      ...specs,
      outputs: [
        { connector: "XLR", count: 2 },
        { connector: "xlr", count: 2 },
      ],
    });
    const result = await searchProducts(
      db,
      productQuery(
        "?maxWidthMm=450&minXlrOutputs=3&maxWeightKg=13&includeTotal=true&sort=priceAsc",
      ),
    );
    assert.equal(result.totalCount, 1);
    assert.deepEqual(
      result.items.map((item) => item.key),
      ["c-700001"],
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT port_count FROM catalog_specification_ports WHERE catalog_product_id=700006 AND direction='output'",
        )
        .get()?.port_count,
      null,
    );
    const plans = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT catalog_product_id FROM catalog_product_specifications WHERE json_type(specification_json,'$.widthMm') IN ('integer','real') AND json_extract(specification_json,'$.widthMm')>0 AND json_extract(specification_json,'$.widthMm')<=450",
      )
      .all();
    assert.match(JSON.stringify(plans), /SEARCH .*idx_catalog_specs_width/);
  } finally {
    sqlite.close();
  }
});

test("port projection migrates retained facts and changed specification writes are atomic and minimal", async () => {
  const { db, sqlite } = migratedSqlite({ before: "0108_catalog_specification_search.sql" });
  try {
    seed(sqlite);
    await updateCatalogSpecifications(db, 700001, specs);
    sqlite.exec(
      migrationSources.find(
        (migration) => migration.name === "0108_catalog_specification_search.sql",
      )!.sql,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT port_count FROM catalog_specification_ports WHERE catalog_product_id=700001 AND direction='output'",
        )
        .get()?.port_count,
      3,
    );
    const before = Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n);
    await updateCatalogSpecifications(db, 700001, { ...specs, widthMm: 430 });
    assert.equal(Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before, 1);
    const changed = Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n);
    await updateCatalogSpecifications(db, 700001, { ...specs, widthMm: 430 });
    assert.equal(Number(sqlite.prepare("SELECT total_changes() AS n").get()?.n), changed);
    sqlite.exec(
      "CREATE TRIGGER fail_ports BEFORE UPDATE ON catalog_specification_ports BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    await assert.rejects(
      updateCatalogSpecifications(db, 700001, {
        ...specs,
        outputs: [{ connector: "XLR", count: 4 }],
      }),
      /injected/,
    );
    assert.equal(
      JSON.parse(
        String(
          sqlite
            .prepare(
              "SELECT specification_json FROM catalog_product_specifications WHERE catalog_product_id=700001",
            )
            .get()?.specification_json,
        ),
      ).widthMm,
      430,
    );
    sqlite.exec("DELETE FROM catalog_product_specifications WHERE catalog_product_id=700001");
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_specification_ports").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});
