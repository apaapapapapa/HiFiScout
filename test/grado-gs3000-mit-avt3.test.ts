import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { resolveModel } from "../src/catalog/model-resolver.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { resolveProductIdentity } from "../src/catalog/product-identity.js";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { inferSaleSubject } from "../src/catalog/sale-subject.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import {
  HIFIDO_CATEGORY_MAPPING,
  extractHifidoDetailCategoryEvidence,
  parseHifidoListing,
} from "../src/crawler/shops/hifido.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { seedDataQualityRemediationQueue } from "../src/db/data-quality-remediation-queue-repository.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { detailFetchOptions, parsedProduct } from "./helpers/fixtures.js";
import { productQuery } from "./helpers/product-query.js";

const MIGRATION = "0131_grado_gs3000_and_mit_avt3.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-15T00:55:00.000Z";
const CURRENT_REPLAY_STATE = {
  manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
  model_resolver_version: RESOLUTION_VERSIONS.model,
  metadata_json: JSON.stringify({
    categoryClassification: { version: RESOLUTION_VERSIONS.category },
  }),
} as const;

test("reviewed MIT line-RCA seller path is authoritative while broad cable stays unresolved", () => {
  const reviewed = normalizeCatalogProduct(
    parsedProduct({
      title: "AVt 3 ic/1.5m",
      manufacturer: "MIT",
      rawManufacturer: "MIT エムアイティー",
      model: "AVt 3 ic/1.5m",
      rawModel: "AVt 3 ic/1.5m",
      rawCategory: "ケーブル ラインRCAケーブル",
    }),
    { categoryMapping: HIFIDO_CATEGORY_MAPPING },
    { shopKey: "hifido" },
  );
  assert.equal(reviewed.primaryCategoryId, "CAB.ANALOG");
  assert.equal(reviewed.categoryEvidence[0]?.strength, "authoritative");

  const broad = normalizeCatalogProduct(
    parsedProduct({ title: "Example EC-1", rawCategory: "ケーブル" }),
    { categoryMapping: HIFIDO_CATEGORY_MAPPING },
    { shopKey: "hifido" },
  );
  assert.equal(broad.primaryCategoryId, "unclassified");
});

test("all Hifido extraction paths preserve the exact line-RCA seller path", () => {
  const sourceId = "26-51058-21475-00";
  const detail = `<div>${sourceId}</div><div>ケーブル ラインRCAケーブル</div><div>日本</div>`;
  assert.deepEqual(
    extractHifidoDetailCategoryEvidence(detail, { sourceId })[0]?.value,
    "ケーブル ラインRCAケーブル",
  );

  const legacy = `<div class="list-item"><a href="/${sourceId}.html">AVt 3 ic/1.5m</a><p>メーカー:MIT エムアイティー</p><p>売価:39,800円</p><p>ケーブル ラインRCAケーブル</p><span>注文</span></div>`;
  assert.equal(parseHifidoListing(legacy)[0]?.rawCategory, "ケーブル ラインRCAケーブル");
});

test("Fujiya strips Grado's exact collection suffix without erasing other identities", () => {
  const resolved = resolveModel({
    rawModel: "GS3000-Classic Series",
    title: "GRADO グラド GS3000-Classic Series",
    manufacturerId: "grado",
    shopKey: "fujiya-avic",
  });
  assert.equal(resolved.model, "GS3000");
  assert.equal(resolved.normalizedModel, "GS3000");
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.removedAnnotations, ["seller_series"]);

  for (const input of [
    { manufacturerId: "other", shopKey: "fujiya-avic" },
    { manufacturerId: "grado", shopKey: "other-shop" },
  ]) {
    assert.equal(
      resolveModel({
        rawModel: "GS3000-Classic Series",
        title: "GS3000-Classic Series",
        ...input,
      }).model,
      "GS3000-Classic Series",
    );
  }
  assert.equal(
    resolveModel({
      rawModel: "RS1-Classic Series",
      title: "GRADO RS1-Classic Series",
      manufacturerId: "grado",
      shopKey: "fujiya-avic",
    }).model,
    "RS1-Classic Series",
  );
});

test("official GS3000 evidence classifies only the reviewed product, not accessories", async () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      title: "GRADO グラド GS3000-Classic Series",
      manufacturer: "GRADO",
      rawManufacturer: "GRADO",
      model: "GS3000-Classic Series",
      rawModel: "GS3000-Classic Series",
    }),
    {},
    { shopKey: "fujiya-avic" },
  );
  assert.equal(product.primaryCategoryId, "PER.HEADPHONE");
  assert.ok(
    product.categoryEvidence.some(
      (item) =>
        item.source === "reviewed_product_type" &&
        item.value === "https://gradolabs.com/collections/classic-headphones",
    ),
  );

  for (const title of [
    "GRADO GS3000 headphones with ear-pads",
    "GRADO GS3000 headphones, ear-pads included",
    "GRADO GS3000 イヤーパッド付き",
    "GRADO GS3000 イヤーパッドを付属",
    "GRADO GS3000 イヤーパッドが付属",
  ]) {
    const completeProduct = normalizeCatalogProduct(
      parsedProduct({
        title,
        manufacturer: "GRADO",
        rawManufacturer: "GRADO",
        model: "GS3000",
        rawModel: "GS3000",
      }),
    );
    assert.equal(completeProduct.primaryCategoryId, "PER.HEADPHONE");
  }

  for (const title of [
    "GRADO GS3000交換ケーブル",
    "GRADO GS3000用ケース",
    "GRADO GS3000 イヤーパッド",
    "GRADO GS3000 ear-pad",
    "GRADO GS3000 headphone stand",
  ]) {
    const accessory = normalizeCatalogProduct(
      parsedProduct({
        title,
        manufacturer: "GRADO",
        rawManufacturer: "GRADO",
        model: "GS3000",
        rawModel: "GS3000",
      }),
    );
    assert.notEqual(accessory.primaryCategoryId, "PER.HEADPHONE");
    if (title !== "GRADO GS3000 ear-pad") continue;
    const identity = resolveProductIdentity(accessory, [
      {
        id: 1,
        manufacturerId: "grado",
        canonicalModel: "GS3000",
        categoryIds: ["PER.HEADPHONE"],
      },
    ]);
    assert.equal(identity.status, "unresolved");
    assert.equal(identity.catalogProductId, null);

    const { sqlite, db } = migratedSqlite({ before: MIGRATION });
    try {
      sqlite.exec(migration);
      const adapter = getShopPlugin("fujiya-avic");
      assert.ok(adapter);
      const enriched = await enrichProductCategories({
        db,
        adapter,
        products: [accessory],
        existingRows: [],
        transport: {
          async fetchHtmlPage() {
            throw new Error("classified accessory must not need detail evidence");
          },
        },
        fetchOptions: detailFetchOptions(),
        now: new Date(AT),
      });
      assert.equal(enriched.catalogMatches, 0);
      assert.equal(enriched.products[0]?.primaryCategoryId, "ACC.WEAR");
    } finally {
      sqlite.close();
    }
  }
});

test("ear-tip size contents do not replace an explicitly named earphone sale object", () => {
  assert.deepEqual(
    inferSaleSubject("SONY WF-1000XM5 ワイヤレスイヤホン イヤーピース S/M/L", "WF-1000XM5"),
    { kind: "unspecified", ruleId: "sale_subject.unspecified" },
  );
  assert.deepEqual(
    inferSaleSubject("SONY WH-1000XM5 ヘッドホン 交換用イヤーパッド", "WH-1000XM5"),
    { kind: "accessory", categoryId: "ACC.WEAR", ruleId: "sale_subject.ACC.WEAR" },
  );
});

test("migration registers GS3000 once and targets only the reviewed stale rows", () => {
  const { sqlite } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec(`
      INSERT OR IGNORE INTO knowledge_catalog_manufacturers(
        id,canonical_name,verification_status,source,provenance_json,created_at,updated_at
      ) VALUES ('grado','GRADO','verified','test','{}','${AT}','${AT}');
    `);
    const grado = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "fujiya-avic",
      source_id: "/shop/g/g240004022712/",
      title: "GRADO グラド GS3000-Classic Series",
      manufacturer: "GRADO",
      raw_manufacturer: "GRADO",
      normalized_raw_manufacturer: "grado",
      manufacturer_id: "grado",
      canonical_manufacturer_id: "",
      raw_model: "GS3000-Classic Series",
      model: "GS3000-Classic Series",
      normalized_model: "GS3000CLASSICSERIES",
      raw_category: "",
    });
    const otherGrado = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "other-shop",
      source_id: "grado-gs3000",
      title: "GRADO GS3000",
      manufacturer: "GRADO",
      raw_manufacturer: "GRADO",
      normalized_raw_manufacturer: "grado",
      manufacturer_id: "grado",
      canonical_manufacturer_id: "",
      raw_model: "GS3000",
      model: "GS3000",
      normalized_model: "GS3000",
      raw_category: "",
    });
    const mit = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "26-51058-21475-00",
      title: "AVt 3 ic/1.5m",
      manufacturer: "MIT",
      raw_manufacturer: "MIT エムアイティー",
      normalized_raw_manufacturer: "mitエムアイティー",
      manufacturer_id: "mit",
      canonical_manufacturer_id: "",
      raw_model: "AVt 3 ic/1.5m",
      model: "AVt 3 ic/1.5m",
      normalized_model: "AVT3IC15M",
      raw_category: "ケーブル ラインRCAケーブル",
    });
    const otherCable = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "26-99999-99999-00",
      title: "Example RCA interconnect",
      manufacturer: "TRANSPARENT",
      raw_manufacturer: "TRANSPARENT",
      normalized_raw_manufacturer: "transparent",
      manufacturer_id: "transparent",
      canonical_manufacturer_id: "",
      raw_model: "Example RCA",
      model: "Example RCA",
      normalized_model: "EXAMPLERCA",
      raw_category: "ケーブル ラインRCAケーブル",
    });
    const earPads = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "other-shop",
      source_id: "hd650-ear-pads",
      title: "Sennheiser HD650 ear pads",
      manufacturer: "Sennheiser",
      raw_manufacturer: "Sennheiser",
      normalized_raw_manufacturer: "sennheiser",
      manufacturer_id: "sennheiser",
      canonical_manufacturer_id: "sennheiser",
      raw_model: "HD650",
      model: "HD650",
      normalized_model: "HD650",
      raw_category: "",
      category: "ヘッドホン",
      primary_category_id: "PER.HEADPHONE",
      category_ids: '["PER.HEADPHONE"]',
    });

    sqlite.exec(migration);
    const catalog = sqlite
      .prepare(`SELECT id,canonical_model,canonical_name FROM knowledge_catalog_products
        WHERE manufacturer_id='grado' AND normalized_model='GS3000'`)
      .get() as { id: number; canonical_model: string; canonical_name: string };
    assert.deepEqual(
      { canonical_model: catalog.canonical_model, canonical_name: catalog.canonical_name },
      { canonical_model: "GS3000", canonical_name: "GRADO GS3000" },
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT category_id FROM knowledge_catalog_product_categories WHERE product_id=? AND is_primary=1",
        )
        .get(catalog.id)?.category_id,
      "PER.HEADPHONE",
    );
    assert.equal(
      sqlite
        .prepare("SELECT source_type FROM knowledge_catalog_sources WHERE product_id=?")
        .get(catalog.id)?.source_type,
      "manufacturer_official",
    );
    for (const id of [grado, otherGrado, mit, otherCable, earPads]) {
      assert.equal(
        sqlite.prepare("SELECT model_resolver_version FROM products WHERE id=?").get(id)
          ?.model_resolver_version,
        RESOLUTION_VERSIONS.model,
      );
      assert.equal(
        sqlite
          .prepare(
            "SELECT json_extract(metadata_json,'$.categoryClassification.version') AS version FROM products WHERE id=?",
          )
          .get(id)?.version,
        RESOLUTION_VERSIONS.category,
      );
    }
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT listing_product_id,request_key FROM data_quality_targeted_replay_requests ORDER BY listing_product_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { listing_product_id: grado, request_key: "0131-grado-gs3000" },
        { listing_product_id: otherGrado, request_key: "0131-grado-gs3000" },
        { listing_product_id: mit, request_key: "0131-hifido-line-rca" },
        { listing_product_id: otherCable, request_key: "0131-hifido-line-rca" },
      ],
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_scans").get()?.n,
      1,
    );
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
  } finally {
    sqlite.close();
  }
});

test("targeted replay is consumed once and retires requests for listings that became inactive", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec(`
      INSERT OR IGNORE INTO knowledge_catalog_manufacturers(
        id,canonical_name,verification_status,source,provenance_json,created_at,updated_at
      ) VALUES ('grado','GRADO','verified','test','{}','${AT}','${AT}');
    `);
    const grado = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "other-shop",
      source_id: "grado-gs3000-once",
      title: "GRADO GS3000",
      manufacturer: "GRADO",
      raw_manufacturer: "GRADO",
      normalized_raw_manufacturer: "grado",
      manufacturer_id: "grado",
      canonical_manufacturer_id: "grado",
      raw_model: "GS3000",
      model: "GS3000",
      normalized_model: "GS3000",
      primary_category_id: "PER.HEADPHONE",
      category_ids: '["PER.HEADPHONE"]',
    });
    const inactive = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "inactive-line-rca",
      title: "Inactive RCA cable",
      manufacturer: "MIT",
      raw_manufacturer: "MIT",
      manufacturer_id: "mit",
      canonical_manufacturer_id: "mit",
      raw_model: "Inactive RCA",
      model: "Inactive RCA",
      normalized_model: "INACTIVERCA",
      raw_category: "ケーブル ラインRCAケーブル",
    });
    sqlite.exec(migration);
    sqlite.prepare("UPDATE products SET is_active=0 WHERE id=?").run(inactive);

    const first = await runDataQualityRemediationSweep(db, {
      preferQueuedWork: true,
      seedLimit: 10,
      claimLimit: 10,
      now: new Date(AT),
    });
    assert.equal(first.resolved, 2);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_requests").get()?.n,
      0,
    );

    const second = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date(AT),
    });
    assert.equal(second.seeded, 0);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM data_quality_remediation_queue WHERE work_key=? AND status='resolved'",
        )
        .get(`targeted:0131-grado-gs3000:listing:${grado}`)?.n,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_requests").get()?.n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_scans").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("replay converges GS3000 catalog identity and both corrected search categories", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    // Apply the migration while there are no matching listings. All four scan signals must still
    // survive for the replacement runtime because the previous Worker can create the first match
    // before deployment completes.
    sqlite.exec(migration);
    const grado = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "fujiya-avic",
      source_id: "/shop/g/g240004022712/",
      source_url: "https://www.fujiya-avic.co.jp/shop/g/g240004022712/",
      title: "GRADO グラド GS3000-Classic Series",
      manufacturer: "GRADO",
      raw_manufacturer: "GRADO",
      manufacturer_id: "grado",
      canonical_manufacturer_id: "grado",
      raw_model: "GS3000",
      model: "GS3000",
      normalized_model: "GS3000",
      raw_category: "",
      category: "ヘッドホン",
      primary_category_id: "PER.HEADPHONE",
      category_ids: '["PER.HEADPHONE"]',
    });
    const mit = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "26-51058-21475-00",
      source_url: "https://www.hifido.co.jp/26-51058-21475-00.html?LNG=J",
      title: "AVt 3 ic/1.5m",
      manufacturer: "MIT",
      raw_manufacturer: "MIT エムアイティー",
      manufacturer_id: "mit",
      canonical_manufacturer_id: "mit",
      raw_model: "AVt 3 ic/1.5m",
      model: "AVt 3 ic/1.5m",
      normalized_model: "AVT3IC15M",
      raw_category: "ケーブル ラインRCAケーブル",
      category: "未分類",
      primary_category_id: "unclassified",
      category_ids: '["unclassified"]',
    });

    // Simulate writes from the previous Worker after migrations but before replacement deployment.
    // Only the replacement runtime understands the durable scan signals, so its first sweep must
    // materialize all of these late rows as targeted work.
    const lateHifido = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "26-51058-21476-00",
      source_url: "https://www.hifido.co.jp/26-51058-21476-00.html?LNG=J",
      title: "Late deployment-window RCA interconnect",
      manufacturer: "TRANSPARENT",
      raw_manufacturer: "TRANSPARENT",
      manufacturer_id: "transparent",
      canonical_manufacturer_id: "transparent",
      raw_model: "Late RCA",
      model: "Late RCA",
      normalized_model: "LATERCA",
      raw_category: "ケーブル ラインRCAケーブル",
      category: "未分類",
      primary_category_id: "unclassified",
      category_ids: '["unclassified"]',
    });
    const lateEarPads = insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "other-shop",
      source_id: "late-hd650-ear-pads",
      title: "Sennheiser HD650 ear-pads",
      manufacturer: "Sennheiser",
      raw_manufacturer: "Sennheiser",
      manufacturer_id: "sennheiser",
      canonical_manufacturer_id: "sennheiser",
      raw_model: "HD650",
      model: "HD650",
      normalized_model: "HD650",
      raw_category: "",
      category: "ヘッドホン",
      primary_category_id: "PER.HEADPHONE",
      category_ids: '["PER.HEADPHONE"]',
    });
    const sweep = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date(AT),
      categoryConfigForShop: (shopKey) => getShopPlugin(shopKey)?.capabilities.catalog ?? {},
    });
    assert.equal(sweep.seeded, 4);
    assert.equal(sweep.resolved, 4);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_requests").get()?.n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_scans").get()?.n,
      0,
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT work_key,status FROM data_quality_remediation_queue WHERE work_key LIKE 'targeted:%' ORDER BY work_key",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          work_key: `targeted:0131-ear-wear-accessory:listing:${lateEarPads}`,
          status: "resolved",
        },
        { work_key: `targeted:0131-grado-gs3000:listing:${grado}`, status: "resolved" },
        { work_key: `targeted:0131-hifido-line-rca:listing:${mit}`, status: "resolved" },
        {
          work_key: `targeted:0131-hifido-line-rca:listing:${lateHifido}`,
          status: "resolved",
        },
      ],
    );

    const gradoRow = sqlite
      .prepare(
        "SELECT model,normalized_model,primary_category_id,remediation_projection_required FROM products WHERE id=?",
      )
      .get(grado);
    assert.deepEqual(
      { ...gradoRow },
      {
        model: "GS3000",
        normalized_model: "GS3000",
        primary_category_id: "PER.HEADPHONE",
        remediation_projection_required: 0,
      },
    );
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=?").get(mit)
        ?.primary_category_id,
      "CAB.ANALOG",
    );
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=?").get(lateHifido)
        ?.primary_category_id,
      "CAB.ANALOG",
    );
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=?").get(lateEarPads)
        ?.primary_category_id,
      "ACC.WEAR",
    );
    assert.equal(
      sqlite
        .prepare("SELECT status FROM product_identity_resolutions WHERE listing_product_id=?")
        .get(lateEarPads)?.status,
      "unresolved",
    );
    const catalog = sqlite
      .prepare(
        "SELECT id FROM knowledge_catalog_products WHERE manufacturer_id='grado' AND normalized_model='GS3000'",
      )
      .get() as { id: number };
    assert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT status,match_method,catalog_product_id FROM product_identity_resolutions WHERE listing_product_id=?",
          )
          .get(grado),
      },
      {
        status: "matched",
        match_method: "manufacturer_model_exact",
        catalog_product_id: catalog.id,
      },
    );
    const gradoSearch = await searchProducts(db, productQuery("?q=GS3000"));
    assert.equal(gradoSearch.items[0]?.key, `c-${catalog.id}`);
    assert.equal(gradoSearch.items[0]?.category, "ヘッドホン");
    const mitSearch = await searchProducts(db, productQuery("?q=AVt%203%20ic"));
    assert.equal(mitSearch.items[0]?.category, "アナログケーブル");
  } finally {
    sqlite.close();
  }
});

test("targeted replay advances by a bounded visited-ID window when exact matches are sparse", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec(migration);
    const ids = Array.from({ length: 25 }, (_, index) =>
      insertListing(sqlite, {
        ...CURRENT_REPLAY_STATE,
        at: AT,
        shop_key: "hifido",
        source_id: `sparse-${index}`,
        title: `Sparse unrelated cable ${index}`,
        manufacturer: "OTHER",
        raw_manufacturer: "OTHER",
        manufacturer_id: "other",
        canonical_manufacturer_id: "other",
        raw_model: `Other ${index}`,
        model: `Other ${index}`,
        normalized_model: `OTHER${index}`,
        raw_category: "ケーブル",
      }),
    );
    insertListing(sqlite, {
      ...CURRENT_REPLAY_STATE,
      at: AT,
      shop_key: "hifido",
      source_id: "sparse-target",
      title: "Sparse target RCA",
      manufacturer: "MIT",
      raw_manufacturer: "MIT",
      manufacturer_id: "mit",
      canonical_manufacturer_id: "mit",
      raw_model: "Sparse target",
      model: "Sparse target",
      normalized_model: "SPARSETARGET",
      raw_category: "ケーブル ラインRCAケーブル",
    });

    await seedDataQualityRemediationQueue(db, { limit: 10, now: AT });

    assert.equal(
      sqlite
        .prepare("SELECT hifido_line_rca_after_id FROM data_quality_targeted_replay_scans")
        .get()?.hifido_line_rca_after_id,
      ids[9],
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_requests").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});
