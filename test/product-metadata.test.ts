import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  normalizeMetadataJson,
  syncProductMetadata,
} from "../src/db/product-metadata-repository.js";

import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("product metadata is stored as stable JSON", () => {
  assert.equal(
    normalizeMetadataJson({ warranty: "6 months", storeName: "Tokyo", rank: "A" }),
    '{"rank":"A","storeName":"Tokyo","warranty":"6 months"}',
  );
});

test("missing or non-object metadata becomes an empty object", () => {
  assert.equal(normalizeMetadataJson(undefined), "{}");
  assert.equal(normalizeMetadataJson(null), "{}");
  assert.equal(normalizeMetadataJson(["not", "allowed"]), "{}");
});

test("oversized product metadata is rejected", () => {
  assert.throws(
    () => normalizeMetadataJson({ note: "x".repeat(9000) }),
    /product metadata exceeds 8192 bytes/,
  );
});

// The clock guard must preserve changes that control enrichment and user-visible metadata.

for (const [label, changed] of [
  ["catalog target", { catalogProductId: 2 }],
  ["classification version", { version: 2 }],
  ["detail negative-cache clock", { detailCheckedAt: "2026-09-05T02:00:00Z" }],
  [
    "classification evidence",
    { evidence: [{ source: "knowledge_catalog", categoryIds: ["AMP.INT"] }] },
  ],
] as const) {
  test(`metadata clock guard preserves a changed ${label}`, async () => {
    const { sqlite, db } = migratedSqlite();
    try {
      const before = {
        categoryClassification: {
          catalogProductId: 1,
          catalogMatchType: "exact",
          catalogMatchedAt: "2026-09-05T00:00:00Z",
          version: 1,
          detailCheckedAt: "2026-09-04T00:00:00Z",
          evidence: [],
        },
      };
      sqlite
        .prepare(`INSERT INTO products(shop_key,source_id,title,source_url,metadata_json,first_seen_at,last_seen_at,last_changed_at)
        VALUES ('hifido','one','Example','https://example.test',?,'before','before','before')`)
        .run(normalizeMetadataJson(before));
      const metadata = {
        categoryClassification: {
          ...before.categoryClassification,
          ...changed,
          catalogMatchedAt: "2026-09-05T02:00:00Z",
        },
      };
      assert.equal(
        await syncProductMetadata(db, "hifido", [{ sourceId: "one", metadata }], "after"),
        1,
      );
      const row = sqlite.prepare("SELECT metadata_json, last_changed_at FROM products").get();
      assert.deepEqual(JSON.parse(String(row?.metadata_json)), metadata);
      assert.equal(row?.last_changed_at, "after");
    } finally {
      sqlite.close();
    }
  });
}

test("another metadata field changes without advancing an unchanged catalog decision time", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    const classification = {
      catalogProductId: 1,
      catalogMatchType: "exact",
      catalogMatchedAt: "before",
    };
    sqlite
      .prepare(`INSERT INTO products(shop_key,source_id,title,source_url,metadata_json,first_seen_at,last_seen_at,last_changed_at)
      VALUES ('hifido','one','Example','https://example.test',?,'before','before','before')`)
      .run(normalizeMetadataJson({ warranty: "3 months", categoryClassification: classification }));
    await syncProductMetadata(
      db,
      "hifido",
      [
        {
          sourceId: "one",
          metadata: {
            warranty: "6 months",
            categoryClassification: { ...classification, catalogMatchedAt: "after" },
          },
        },
      ],
      "after",
    );
    const row = sqlite.prepare("SELECT metadata_json FROM products").get();
    assert.deepEqual(JSON.parse(String(row?.metadata_json)), {
      warranty: "6 months",
      categoryClassification: classification,
    });
  } finally {
    sqlite.close();
  }
});
