import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const MIGRATION = "0130_verified_seller_manufacturer_aliases.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-14T13:00:00.000Z";

const CASES = [
  ["hamilex", "HAMILEX ハミレックス", "hamilexハミレックス"],
  ["sansui", "SANSUI サンスイ", "sansuiサンスイ"],
  ["diatone", "DIATONE ダイヤトーン", "diatoneダイヤトーン"],
  ["transparent", "TRANSPARENT トランスペアレント", "transparentトランスペアレント"],
  ["mit", "MIT エムアイティー", "mitエムアイティー"],
  ["belden", "BELDEN ベルデン", "beldenベルデン"],
  ["toshiba", "TOSHIBA トウシバ", "toshibaトウシバ"],
  ["rca", "RCA アールシーエー", "rcaアールシーエー"],
  ["grado", "GRADO", "grado"],
] as const;

test("reviewed exact seller spellings resolve only their verified manufacturer rows", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    const listings = CASES.map(([manufacturerId, rawManufacturer, normalizedRaw], index) => ({
      manufacturerId,
      id: insertListing(sqlite, {
        at: AT,
        shop_key: index === CASES.length - 1 ? "fujiya-avic" : "hifido",
        source_id: `alias-${manufacturerId}`,
        title: `${rawManufacturer} MODEL-${index}`,
        manufacturer: rawManufacturer.split(" ")[0] || rawManufacturer,
        manufacturer_id: manufacturerId,
        raw_manufacturer: rawManufacturer,
        normalized_raw_manufacturer: normalizedRaw,
        canonical_manufacturer_id: "",
        manufacturer_resolution_status: "unresolved",
        manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
        raw_model: `MODEL-${index}`,
        model: `MODEL-${index}`,
      }),
    }));

    const manualId = insertListing(sqlite, {
      at: AT,
      shop_key: "hifido",
      source_id: "manual-hamilex",
      title: "HAMILEX ハミレックス MANUAL",
      manufacturer: "HAMILEX",
      manufacturer_id: "hamilex",
      raw_manufacturer: "HAMILEX ハミレックス",
      normalized_raw_manufacturer: "hamilexハミレックス",
      canonical_manufacturer_id: "",
      manufacturer_resolution_status: "unresolved",
      manufacturer_resolver_version: RESOLUTION_VERSIONS.manufacturer,
    });
    sqlite.exec(`
      INSERT INTO product_admin_overrides
        (listing_product_id,manufacturer_id,manufacturer_name,created_at,updated_at)
      VALUES (${manualId},'other-audio','Other Audio','${AT}','${AT}');
    `);

    sqlite.exec(migration);

    assert.deepEqual(
      sqlite
        .prepare(`
          SELECT manufacturer_id,normalized_alias
          FROM knowledge_catalog_manufacturer_aliases
          WHERE normalized_alias IN (${CASES.map(() => "?").join(",")})
          ORDER BY manufacturer_id
        `)
        .all(...CASES.map((item) => item[2]))
        .map((row) => [row.manufacturer_id, row.normalized_alias]),
      [...CASES].map(([manufacturerId, , normalizedAlias]) => [manufacturerId, normalizedAlias]).sort(),
    );
    for (const { id } of listings) {
      assert.equal(
        sqlite.prepare("SELECT manufacturer_resolver_version AS v FROM products WHERE id=?").get(id)
          ?.v,
        1,
      );
    }
    assert.equal(
      sqlite
        .prepare("SELECT manufacturer_resolver_version AS v FROM products WHERE id=?")
        .get(manualId)?.v,
      RESOLUTION_VERSIONS.manufacturer,
    );

    const afterFirstRun = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, afterFirstRun);

    const sweep = await runDataQualityRemediationSweep(db, {
      seedLimit: 20,
      claimLimit: 20,
      now: new Date(AT),
    });
    assert.equal(sweep.failed, 0);
    for (const { id, manufacturerId } of listings) {
      const row = sqlite
        .prepare(`
          SELECT canonical_manufacturer_id,manufacturer_resolution_status,
            manufacturer_resolver_version
          FROM products WHERE id=?
        `)
        .get(id);
      assert.equal(row?.canonical_manufacturer_id, manufacturerId);
      assert.equal(row?.manufacturer_resolution_status, "resolved");
      assert.equal(row?.manufacturer_resolver_version, RESOLUTION_VERSIONS.manufacturer);
    }
  } finally {
    sqlite.close();
  }
});
