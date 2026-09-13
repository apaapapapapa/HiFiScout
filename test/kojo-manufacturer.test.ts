import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { resolveManufacturer } from "../src/catalog/manufacturer-resolver.js";
import {
  manufacturerFilterIds,
  manufacturerIdForFilter,
  normalizeManufacturerKey,
  splitKnownManufacturerModel,
} from "../src/catalog/manufacturers.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { replayAdminCsvListings } from "../src/db/data-quality-remediation-service.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

const MIGRATION = "0126_kojo_manufacturer_aliases.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-13T00:00:00.000Z";
const spellings = [
  "KOJO",
  "ＫＯＪＯ",
  "KOJO TECHNOLOGY",
  "光城精工",
  "株式会社光城精工",
  "コージョー",
  "KOJO TECHNOLOGY コウジョウテクノロジー",
  "KOJO（光城精工）",
];

test("KOJO brand and company spellings share identity and stale search IDs", () => {
  for (const rawManufacturer of spellings) {
    const result = resolveManufacturer({ rawManufacturer });
    assert.equal(result.canonicalManufacturerId, "kojo", rawManufacturer);
    assert.equal(result.displayName, "KOJO");
    assert.equal(result.status, "resolved");
    assert.equal(manufacturerIdForFilter(rawManufacturer), "kojo");
    const ids = manufacturerFilterIds(rawManufacturer);
    for (const legacy of ["kojo", "kojotechnology", "brand-1l713dr"])
      assert.ok(ids.includes(legacy), `${rawManufacturer}: ${legacy}`);
  }
  assert.equal(
    splitKnownManufacturerModel("KOJO TECHNOLOGY コウジョウテクノロジー Crystal E")?.model,
    "Crystal E",
  );
  const listing = normalizeCatalogProduct({
    sourceId: "kojo-truncated",
    sourceUrl: "https://example.test/kojo-truncated",
    manufacturer: "KOJO",
    model: "TECHNOLOGY DA-6",
    title: "KOJO TECHNOLOGY DA-6",
    conditionText: "中古",
    priceYen: 10000,
    stockStatus: "in_stock",
  });
  assert.equal(listing.manufacturerId, "kojo");
  assert.equal(listing.model, "DA-6");
  assert.equal(listing.rawModel, "TECHNOLOGY DA-6");

  for (const title of ["KOJONES X1", "Other Audio KOJO Crystal E用ケース"])
    assert.equal(resolveManufacturer({ rawManufacturer: "", title }).canonicalManufacturerId, "");
  assert.equal(
    resolveManufacturer({ rawManufacturer: "Other Audio", title: "KOJO Crystal E用ケース" })
      .canonicalManufacturerId,
    "",
  );
});

test("KOJO migration and scoped replay converge search without replacing catalog or seller evidence", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    const ids = [
      ["KOJO", "kojo"],
      ["KOJO TECHNOLOGY", "kojotechnology"],
      ["光城精工", "brand-1l713dr"],
    ].map(([name, id], index) =>
      insertListing(sqlite, {
        at: AT,
        shop_key: ["fujiya-avic", "hifido", "afroaudio"][index],
        source_id: `kojo-${index}`,
        source_url: `https://example.test/kojo-${index}`,
        manufacturer: name,
        raw_manufacturer: name,
        normalized_raw_manufacturer: normalizeManufacturerKey(name),
        manufacturer_id: id,
        canonical_manufacturer_id: "",
        manufacturer_resolution_status: "unresolved",
        model: "Crystal E",
        raw_model: "Crystal E",
        normalized_model: "CRYSTAL E",
        title: `${name} Crystal E 仮想アース`,
        category: "仮想アース・ノイズ対策",
        raw_category: "仮想アース",
        primary_category_id: "ACC.GROUND_NOISE",
        category_ids: '["ACC.GROUND_NOISE","ACC"]',
        direct_category_ids: '["ACC.GROUND_NOISE"]',
      }),
    );
    sqlite.exec(`INSERT INTO knowledge_catalog_products
      (id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      VALUES (90000,'kojo','Crystal E','CRYSTAL E','${AT}','${AT}');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      VALUES (90000,'ACC.GROUND_NOISE',1);`);
    const catalogBefore = sqlite
      .prepare("SELECT * FROM knowledge_catalog_products WHERE id=90000")
      .get();
    sqlite.exec(migration);
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM products WHERE remediation_projection_required=1")
        .get()?.n,
      3,
    );
    await replayAdminCsvListings(db, ids, AT);
    const rows = sqlite
      .prepare(
        "SELECT manufacturer_id,canonical_manufacturer_id,raw_manufacturer,raw_model,remediation_projection_required FROM products ORDER BY id",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => row.raw_manufacturer),
      ["KOJO", "KOJO TECHNOLOGY", "光城精工"],
    );
    assert.ok(
      rows.every(
        (row) => row.manufacturer_id === "kojo" && row.canonical_manufacturer_id === "kojo",
      ),
    );
    assert.ok(
      rows.every(
        (row) => row.raw_model === "Crystal E" && row.remediation_projection_required === 0,
      ),
    );
    for (const name of ["KOJO", "KOJO TECHNOLOGY", "光城精工"]) {
      for (const key of ["q", "manufacturer"]) {
        const result = await searchProducts(
          db,
          productQuery(`?${key}=${encodeURIComponent(name)}`),
        );
        assert.equal(result.items.length, 1, `${key}=${name}`);
        assert.equal(result.items[0].offer_count, 3);
      }
    }
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM knowledge_catalog_products WHERE id=90000").get(),
      catalogBefore,
    );
    const changesBefore = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changesBefore);
  } finally {
    sqlite.close();
  }
});

test("KOJO migration preserves manual decisions, unrelated rows and pending tokens", () => {
  const { sqlite } = migratedSqlite({ before: MIGRATION });
  try {
    const existing = insertListing(sqlite, {
      source_id: "pending",
      manufacturer_id: "kojo",
      canonical_manufacturer_id: "",
      raw_manufacturer: "KOJO",
      normalized_raw_manufacturer: "kojo",
      remediation_projection_required: 1,
      remediation_projection_token: "existing-work",
    });
    const manual = insertListing(sqlite, {
      source_id: "manual",
      manufacturer_id: "brand-1l713dr",
      raw_manufacturer: "光城精工",
      normalized_raw_manufacturer: "光城精工",
    });
    const other = insertListing(sqlite, { source_id: "other", title: "Other Audio KOJO用ケース" });
    sqlite.exec(`INSERT INTO product_admin_overrides(listing_product_id,manufacturer_id,manufacturer_name,created_at,updated_at)
      VALUES (${manual},'other-audio','Other Audio','${AT}','${AT}');
      INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,name_ja,name_en,created_at,updated_at)
      VALUES ('kojo','KOJO','管理者指定名','KOJO TECHNOLOGY','${AT}','${AT}');
      INSERT INTO knowledge_catalog_manufacturer_aliases(manufacturer_id,alias,normalized_alias,verification_status,source,created_at,updated_at)
      VALUES ('kojo','コージョー','コージョー','rejected','admin_alias_control','${AT}','${AT}');`);
    sqlite.exec(migration);
    assert.equal(
      sqlite
        .prepare("SELECT remediation_projection_token AS token FROM products WHERE id=?")
        .get(existing)?.token,
      "existing-work",
    );
    for (const id of [manual, other])
      assert.equal(
        sqlite
          .prepare("SELECT remediation_projection_required AS pending FROM products WHERE id=?")
          .get(id)?.pending,
        0,
      );
    assert.equal(
      sqlite.prepare("SELECT name_ja FROM knowledge_catalog_manufacturers WHERE id='kojo'").get()
        ?.name_ja,
      "管理者指定名",
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT verification_status FROM knowledge_catalog_manufacturer_aliases WHERE manufacturer_id='kojo' AND normalized_alias='コージョー'",
        )
        .get()?.verification_status,
      "rejected",
    );
  } finally {
    sqlite.close();
  }
});
