import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const MIGRATION = "0132_attached_manufacturer_and_category_audit.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-15T10:00:00.000Z";

test("audit migration adds the exact DIATONE alias and targets only the seven reviewed listings", () => {
  const { sqlite } = migratedSqlite({ before: MIGRATION });
  try {
    const listings = [
      ["shimamusen", "000000019826", "ゼンハイザーHD800S", "※送料無料"],
      ["shimamusen", "000000019831", "ゼンハイザーHDVD800", "※送料無料"],
      ["hifido", "26-32956-21049-00", "SONY ソニー", "VM-27G"],
      ["hifido", "26-51044-21358-00", "ONKYO オンキョー", "TX-NR656"],
      ["audiounion", "226575", "DENON", "PMA-50"],
      ["avac", "51990", "Bluesound", "POWERNODE"],
      ["avac", "51982", "DIATONE", "DS-A3"],
    ] as const;
    for (const [shopKey, sourceId, rawManufacturer, rawModel] of listings) {
      insertListing(sqlite, {
        at: AT,
        shop_key: shopKey,
        source_id: sourceId,
        title: `${rawManufacturer}${shopKey === "shimamusen" ? "" : " "}${rawModel}`,
        raw_manufacturer: rawManufacturer,
        manufacturer: rawManufacturer,
        raw_model: rawModel,
        model: rawModel,
      });
    }

    sqlite.exec(migration);

    assert.deepEqual(
      {
        ...sqlite
          .prepare(`SELECT manufacturer_id,alias,normalized_alias,verification_status,rule_version
          FROM knowledge_catalog_manufacturer_aliases
          WHERE manufacturer_id='diatone' AND normalized_alias='diatone'`)
          .get(),
      },
      {
        manufacturer_id: "diatone",
        alias: "DIATONE",
        normalized_alias: "diatone",
        verification_status: "verified",
        rule_version: 16,
      },
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM data_quality_targeted_replay_requests").get()?.n,
      7,
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT reason,COUNT(*) AS n FROM data_quality_targeted_replay_requests GROUP BY reason ORDER BY reason",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { reason: "attached_manufacturer_model_and_reviewed_product_type", n: 2 },
        { reason: "reviewed_exact_category", n: 4 },
        { reason: "verified_bare_manufacturer_alias", n: 1 },
      ],
    );

    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
  } finally {
    sqlite.close();
  }
});
