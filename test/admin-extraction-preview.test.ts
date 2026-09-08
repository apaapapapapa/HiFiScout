import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { previewAdminExtraction } from "../src/admin/extraction-preview.js";
import { parseAdminExtractionRequest } from "../src/http/admin-extraction-preview.js";

const sample = {
  title: "デモラボ D-1000 CDプレーヤー",
  rawManufacturer: "デモラボ",
  rawModel: "デモラボ D-1000",
  rawCategory: "CDプレーヤー",
  shopKey: "audiounion",
};
test("draft aliases preview manufacturer and model changes only in the selected shop without writes", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at) VALUES('luxman','LUXMAN','verified','','')",
    );
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const result = await previewAdminExtraction(db, {
      samples: [sample, { ...sample, shopKey: "hifido" }],
      draftAlias: { manufacturerId: "luxman", alias: "デモラボ", shopKey: "audiounion" },
    });
    assert.equal(result.items[0].current?.manufacturerId, "");
    assert.equal(result.items[0].proposed?.manufacturerId, "luxman");
    assert.equal(result.items[0].proposed?.model, "D-1000");
    assert.deepEqual(result.items[1].proposed, result.items[1].current);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
  } finally {
    sqlite.close();
  }
});

test("saved samples preserve manual authority and retained category evidence", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at) VALUES('luxman','LUXMAN','verified','','')",
    );
    const metadata = {
      categoryClassification: {
        evidence: [
          {
            categoryIds: ["AMP.INTEGRATED"],
            source: "detail_metadata",
            strength: "strong",
            value: "official specification",
          },
        ],
      },
    };
    sqlite
      .prepare(`INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,
      manufacturer,raw_manufacturer,raw_model,model,normalized_model,primary_category_id,metadata_json)
      VALUES (100001,'audiounion','preview','LUXMAN L-505 アンプ','https://example.test/item','','','','LUXMAN','LUXMAN','L-505','手動型番','MANUAL','AMP.INTEGRATED',?)`)
      .run(JSON.stringify(metadata));
    sqlite.exec(
      "INSERT INTO product_admin_overrides(listing_product_id,model,normalized_model,created_at,updated_at) VALUES(100001,'手動型番','MANUAL','','')",
    );
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const result = await previewAdminExtraction(db, {
      samples: [{ listingId: 100001 }, { listingId: 999999 }],
    });
    assert.equal(result.items[0].current?.model, "L-505");
    assert.equal(result.items[0].withOverrides?.model, "手動型番");
    assert.equal(result.items[0].withOverrides?.normalizedModel, "MANUAL");
    assert.equal(result.items[0].current?.categoryId, "AMP.INTEGRATED");
    assert.deepEqual(result.items[0].overrides, ["型番"]);
    assert.match(result.items[1].error ?? "", /見つかりません/);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
  } finally {
    sqlite.close();
  }
});

test("preview refuses oversized samples, unregistered shops and truncated alias dictionaries", async () => {
  assert.equal(
    parseAdminExtractionRequest({ samples: Array.from({ length: 21 }, () => sample) }),
    null,
  );
  assert.equal(parseAdminExtractionRequest({ samples: [{ ...sample, shopKey: "unknown" }] }), null);
  assert.equal(
    parseAdminExtractionRequest({ samples: [{ ...sample, title: "x".repeat(4097) }] }),
    null,
  );
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at) VALUES('luxman','LUXMAN','verified','','')",
    );
    sqlite.exec(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<1001)
      INSERT INTO knowledge_catalog_manufacturer_aliases(manufacturer_id,alias,normalized_alias,verification_status,created_at,updated_at)
      SELECT 'luxman','extra-'||id,'extra'||id,'rejected','','' FROM n`);
    await assert.rejects(() => previewAdminExtraction(db, { samples: [sample] }), /別名辞書/);
  } finally {
    sqlite.close();
  }
});
