import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { categoryFilterIds } from "../src/catalog/categories.js";
import {
  manufacturerFilterIds,
  manufacturerFilterPresentations,
} from "../src/catalog/manufacturers.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

function fixture() {
  const { sqlite, db } = migratedSqlite();
  const at = new Date().toISOString();
  sqlite.exec(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,price_yen,
    previous_price_yen,is_active,first_seen_at,last_seen_at,last_changed_at,last_activity_at) VALUES
    (1,'hifido','1','LUXMAN amplifier','https://example.test/1','in_stock',100,NULL,1,'${at}','${at}','${at}','${at}'),
    (2,'audiounion','2','LUXMAN amplifier','https://example.test/2','in_stock',10,NULL,1,'${at}','${at}','${at}','${at}'),
    (3,'hifido','3','LUXMAN amplifier','https://example.test/3','in_stock',150,NULL,1,'${at}','${at}','${at}','${at}'),
    (4,'hifido','4','LUXMAN amplifier','https://example.test/4','sold_out',200,NULL,1,'${at}','${at}','${at}','${at}'),
    (5,'audiounion','5','LUXMAN amplifier','https://example.test/5','in_stock',50,NULL,1,'${at}','${at}','${at}','${at}'),
    (6,'hifido','6','LUXMAN amplifier','https://example.test/6','in_stock',300,NULL,0,'${at}','${at}','${at}','${at}'),
    (7,'hifido','7','MSB amplifier','https://example.test/7','in_stock',500,NULL,1,'2000-01-01','${at}','${at}','${at}'),
    (8,'hifido','8','LUXMAN amplifier','https://example.test/8','in_stock',600,800,1,'${at}','${at}','${at}','${at}'),
    (9,'hifido','9','Other amplifier','https://example.test/9','sold_out',700,NULL,1,'${at}','${at}','${at}','${at}'),
    (10,'audiounion','10','LUXMAN amplifier','https://example.test/10','in_stock',800,NULL,1,'${at}','${at}','${at}','${at}'),
    (11,'hifido','11','LUXMAN amplifier','https://example.test/11','unknown',100,NULL,1,'${at}','${at}','${at}','${at}');
    INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,manufacturer_id,manufacturer,model,manufacturer_terms,model_terms)
    VALUES (1,'l-1','unresolved_listing',1,'luxman','LUXMAN','amplifier','LUXMAN','amplifier'),
      (4,'l-4','unresolved_listing',4,'legacy-a','【中古品】ラックスマン','amplifier','LUXMAN','amplifier'),
      (6,'l-6','unresolved_listing',6,'luxman','LUXMAN','amplifier','LUXMAN','amplifier'),
      (7,'l-7','unresolved_listing',7,'msb','MSB Technology','amplifier','MSB','amplifier'),
      (8,'l-8','unresolved_listing',8,'legacy-b','〖新品〗LUXMAN','amplifier','LUXMAN','amplifier'),
      (9,'l-9','unresolved_listing',9,'legacy-c','NotLUXMAN','amplifier','Other','amplifier'),
      (10,'l-10','unresolved_listing',10,'legacy-d','[中古] L U X M A N','amplifier','LUXMAN','amplifier'),
      (11,'l-11','unresolved_listing',11,'legacy-e',' ラックスマン　','amplifier','LUXMAN','amplifier');
    INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
    SELECT id,CASE WHEN id IN (2,3) THEN 1 WHEN id=5 THEN 4 ELSE id END,shop_key FROM products;`);
  for (const id of [1, 8])
    sqlite
      .prepare(
        "INSERT INTO product_search_entity_categories(entity_id,category_id,is_direct) VALUES(?,?,1)",
      )
      .run(id, categoryFilterIds("dac")[0]);
  return { sqlite, db };
}

test("shop counts preserve entity distinctness and same-offer conditions across filters and pages", async () => {
  const { sqlite, db } = fixture();
  try {
    const cases: [string, number[]][] = [
      ["shop=hifido", [1, 4, 7, 8, 9, 11]],
      ["shop=hifido&inStock=true", [1, 7, 8]],
      ["shop=hifido&inStock=true&maxPrice=200", [1]],
      ["shop=hifido&inStock=true&maxPrice=50", []],
      ["shop=hifido&inStock=true&minPrice=400", [7, 8]],
      ["shop=hifido&inStock=true&priceDropped=true", [8]],
      ["shop=hifido&inStock=true&newOnly=true", [1, 8]],
      ["shop=hifido&manufacturer=luxman", [1, 4, 8, 11]],
      ["shop=hifido&manufacturer=luxman&inStock=true", [1, 8]],
      ["shop=hifido&inStock=true&q=LUXMAN", [1, 8]],
      ["shop=hifido&inStock=true&category=dac", [1, 8]],
      ["shop=missing&inStock=true", []],
    ];
    for (const [filter, ids] of cases) {
      const result = await searchProducts(db, productQuery(`?${filter}&includeTotal=true`));
      assert.equal(result.totalCount, ids.length, filter);
      assert.deepEqual(
        result.items.map((row) => Number(row.key.slice(2))).sort((a, b) => a - b),
        ids,
        filter,
      );
    }
    for (const sort of ["newest", "oldest", "updated", "priceAsc", "priceDesc", "dealScore"]) {
      const base = `?shop=hifido&inStock=true&sort=${sort}&limit=1&includeTotal=true`;
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await searchProducts(
          db,
          productQuery(base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")),
        );
        assert.equal(page.totalCount, 3, "the cursor cannot narrow the total");
        assert.equal(page.totalPages, 3);
        ids.push(...page.items.map((row) => row.key));
        cursor = page.nextCursor;
        assert.ok(ids.length <= 3, `repeated page for ${sort}`);
      } while (cursor);
      assert.deepEqual(ids.sort(), ["l-1", "l-7", "l-8"], sort);
    }
    const priced = await searchProducts(
      db,
      productQuery("?shop=hifido&inStock=true&sort=priceAsc"),
    );
    assert.equal(priced.items[0].key, "l-1");
    assert.equal(priced.items[0].offer_count, 2);
    assert.equal(
      priced.items[0].lowest_price_yen,
      100,
      "the other shop's cheaper offer is excluded",
    );
  } finally {
    sqlite.close();
  }
});

test("manufacturer set lookup preserves the prior canonical, alias and badge-suffix matching", async () => {
  const { sqlite, db } = fixture();
  try {
    const normalized = "LOWER(REPLACE(REPLACE(TRIM(e.manufacturer), ' ', ''), '　', ''))";
    for (const manufacturer of ["luxman", "ラックスマン", "MSB Technology", "missing"]) {
      // Independent reference for the pre-optimization predicate, including its legacy suffix rule.
      const expected = sqlite
        .prepare(`SELECT e.id FROM product_search_entities e WHERE (
        e.manufacturer_id IN (SELECT value FROM json_each(?)) OR EXISTS (
          SELECT 1 FROM json_each(?) presentation WHERE ${normalized}=presentation.value
          OR ((${normalized} LIKE '【%】%' OR ${normalized} LIKE '〖%〗%' OR ${normalized} LIKE '[%]%')
            AND substr(${normalized},-length(presentation.value))=presentation.value)
        )) ORDER BY e.id`)
        .all(
          JSON.stringify(manufacturerFilterIds(manufacturer)),
          JSON.stringify(
            manufacturerFilterPresentations(manufacturer).map((value) =>
              value.toLowerCase().replace(/\s+/gu, ""),
            ),
          ),
        )
        .map((row) => row.id);
      const result = await searchProducts(
        db,
        productQuery(`?manufacturer=${encodeURIComponent(manufacturer)}&includeTotal=true`),
      );
      assert.equal(result.totalCount, expected.length);
      assert.deepEqual(
        result.items.map((row) => Number(row.key.slice(2))).sort((a, b) => a - b),
        expected,
        manufacturer,
      );
    }
  } finally {
    sqlite.close();
  }
});
