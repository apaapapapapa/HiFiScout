import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const MIGRATION = "0129_onkyo_behringer_manufacturer_aliases.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-14T10:00:00.000Z";

test("ONKYO and bilingual BEHRINGER aliases replay only affected listings", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec(`
      INSERT OR IGNORE INTO knowledge_catalog_manufacturers
        (id,canonical_name,verification_status,source,created_at,updated_at)
      VALUES
        ('onkyo','ONKYO','verified','https://onkyo.com/','${AT}','${AT}'),
        ('behringer','BEHRINGER','verified','https://www.behringer.com/','${AT}','${AT}');
    `);
    const onkyo = insertListing(sqlite, {
      shop_key: "avac",
      source_id: "onkyo",
      manufacturer: "ONKYO",
      manufacturer_id: "onkyo",
      raw_manufacturer: "ONKYO",
      normalized_raw_manufacturer: "onkyo",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
      raw_category: "AVアンプ",
      category: "未分類",
      primary_category_id: "UNCLASSIFIED",
      category_ids: '["UNCLASSIFIED"]',
      direct_category_ids: '["UNCLASSIFIED"]',
      classification_status: "unclassified",
      metadata_json: JSON.stringify({
        categoryClassification: { version: RESOLUTION_VERSIONS.category, evidence: [] },
      }),
    });
    const behringer = insertListing(sqlite, {
      shop_key: "hifido",
      source_id: "behringer",
      manufacturer: "BEHRINGER",
      manufacturer_id: "behringer",
      raw_manufacturer: "BEHRINGER ベリンガー",
      normalized_raw_manufacturer: "behringerベリンガー",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
      metadata_json: JSON.stringify({
        categoryClassification: { version: RESOLUTION_VERSIONS.category, evidence: [] },
      }),
    });
    const unrelated = insertListing(sqlite, {
      shop_key: "avac",
      source_id: "unrelated",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
      raw_category: "フロア型スピーカー(ペア)",
      metadata_json: JSON.stringify({
        categoryClassification: { version: RESOLUTION_VERSIONS.category, evidence: [] },
      }),
    });
    const manual = insertListing(sqlite, {
      shop_key: "avac",
      source_id: "manual",
      manufacturer: "ONKYO",
      manufacturer_id: "onkyo",
      raw_manufacturer: "ONKYO",
      normalized_raw_manufacturer: "onkyo",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
      raw_category: "AVアンプ",
      metadata_json: JSON.stringify({
        categoryClassification: { version: RESOLUTION_VERSIONS.category, evidence: [] },
      }),
    });
    sqlite.exec(`
      INSERT INTO product_admin_overrides
        (listing_product_id,manufacturer_id,manufacturer_name,created_at,updated_at)
      VALUES (${manual},'other-audio','Other Audio','${AT}','${AT}');
    `);

    sqlite.exec(migration);
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT normalized_alias FROM knowledge_catalog_manufacturer_aliases WHERE manufacturer_id IN ('onkyo','behringer') AND normalized_alias IN ('onkyo','behringer','behringerベリンガー') ORDER BY normalized_alias",
        )
        .all()
        .map((row) => row.normalized_alias),
      ["behringer", "behringerベリンガー", "onkyo"],
    );
    for (const id of [onkyo, behringer])
      assert.equal(
        sqlite.prepare("SELECT manufacturer_resolver_version AS v FROM products WHERE id=?").get(id)
          ?.v,
        1,
      );
    for (const id of [unrelated, manual])
      assert.equal(
        sqlite.prepare("SELECT manufacturer_resolver_version AS v FROM products WHERE id=?").get(id)
          ?.v,
        RESOLUTION_VERSIONS.manufacturer,
      );
    assert.equal(
      sqlite
        .prepare(
          "SELECT CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER) AS v FROM products WHERE id=?",
        )
        .get(onkyo)?.v,
      1,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER) AS v FROM products WHERE id=?",
        )
        .get(unrelated)?.v,
      RESOLUTION_VERSIONS.category,
    );

    const sweep = await runDataQualityRemediationSweep(db, {
      seedLimit: 10,
      claimLimit: 10,
      now: new Date(AT),
    });
    assert.equal(sweep.failed, 0);
    for (const [id, expected] of [
      [onkyo, "onkyo"],
      [behringer, "behringer"],
    ] as const) {
      const row = sqlite
        .prepare(
          "SELECT manufacturer_id,canonical_manufacturer_id,manufacturer_resolver_version FROM products WHERE id=?",
        )
        .get(id);
      assert.equal(row?.manufacturer_id, expected);
      assert.equal(row?.canonical_manufacturer_id, expected);
      assert.equal(row?.manufacturer_resolver_version, RESOLUTION_VERSIONS.manufacturer);
    }
    const category = sqlite
      .prepare(
        "SELECT primary_category_id,classification_status,CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER) AS version FROM products WHERE id=?",
      )
      .get(onkyo);
    assert.equal(category?.primary_category_id, "AMP.RECEIVER");
    assert.equal(category?.classification_status, "classified");
    assert.equal(category?.version, RESOLUTION_VERSIONS.category);
  } finally {
    sqlite.close();
  }
});
