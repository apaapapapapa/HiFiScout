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
      source_id: "onkyo",
      manufacturer: "ONKYO",
      manufacturer_id: "onkyo",
      raw_manufacturer: "ONKYO",
      normalized_raw_manufacturer: "onkyo",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
    });
    const behringer = insertListing(sqlite, {
      source_id: "behringer",
      manufacturer: "BEHRINGER",
      manufacturer_id: "behringer",
      raw_manufacturer: "BEHRINGER ベリンガー",
      normalized_raw_manufacturer: "behringerベリンガー",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
    });
    const unrelated = insertListing(sqlite, {
      source_id: "unrelated",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
    });
    const manual = insertListing(sqlite, {
      source_id: "manual",
      manufacturer: "ONKYO",
      manufacturer_id: "onkyo",
      raw_manufacturer: "ONKYO",
      normalized_raw_manufacturer: "onkyo",
      canonical_manufacturer_id: "",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
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
  } finally {
    sqlite.close();
  }
});
