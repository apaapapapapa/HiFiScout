import assert from "node:assert/strict";
import test from "node:test";

import type {
  CatalogAdminProductExportOptions,
  CatalogAdminProductExportRow,
} from "../src/admin/contracts.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import {
  PRODUCT_AUDIT_CSV_BOM,
  productAuditCsvHeader,
  productAuditCsvRow,
} from "../src/admin/product-audit-csv.js";
import { listProductAuditExportPage } from "../src/db/product-audit-export-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function exportRow(overrides: Partial<CatalogAdminProductExportRow> = {}): CatalogAdminProductExportRow {
  return {
    listingId: 1,
    shopKey: "shop-a",
    sourceId: "source-1",
    sourceUrl: "https://example.test/product/1",
    isActive: 1,
    stockStatus: "in_stock",
    priceYen: 120_000,
    conditionText: "中古",
    title: "EDISCREATION Fiber Box 2 JPSM",
    rawManufacturer: "EDISCREATION",
    manufacturer: "EDISCREATION",
    manufacturerId: "ediscreation",
    canonicalManufacturerId: "ediscreation",
    manufacturerResolutionStatus: "resolved",
    manufacturerResolutionMethod: "bootstrap_alias",
    manufacturerResolutionConfidence: "high",
    rawModel: "Fiber Box 2 JPSM",
    model: "Fiber Box 2 JPSM",
    normalizedModel: "FIBERBOX2JPSM",
    modelResolutionStatus: "resolved",
    modelResolutionMethod: "seller_model",
    modelResolutionConfidence: "high",
    rawCategory: "光アイソレーター",
    category: "その他",
    primaryCategoryId: "other",
    categoryIds: '["other"]',
    classificationStatus: "classified",
    searchEntityKey: "l-1",
    searchEntityKind: "unresolved_listing",
    searchEntityPrimaryCategoryId: "other",
    searchEntityOfferCount: 2,
    searchEntityShopCount: 2,
    identityStatus: "unresolved",
    identityMatchMethod: "none",
    identityConfidence: "none",
    identityCatalogProductId: null,
    identityCandidateCatalogProductId: null,
    catalogCanonicalName: "",
    catalogCanonicalModel: "",
    catalogPrimaryCategoryId: "",
    candidateCatalogCanonicalName: "",
    candidateCatalogCanonicalModel: "",
    candidateCatalogPrimaryCategoryId: "",
    firstSeenAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-22T00:00:00.000Z",
    lastChangedAt: "2026-08-21T00:00:00.000Z",
    lastActivityAt: "2026-08-21T00:00:00.000Z",
    sourcePublishedAt: "",
    ...overrides,
  };
}

function exportEnv(
  exportPage: (options: CatalogAdminProductExportOptions) => Promise<unknown>,
): Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1] {
  return {
    ADMIN_ASSETS: {
      async fetch(): Promise<Response> {
        return new Response("catalog admin");
      },
    },
    CATALOG_ADMIN: {
      async listProducts(): Promise<unknown> {
        return {};
      },
      async updateProduct(): Promise<unknown> {
        return {};
      },
      exportProductAuditPage: exportPage,
    },
  } as unknown as Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1];
}

function assertAdminSecurityHeaders(response: Response): void {
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/u);
}

test("AI audit CSV has stable diagnostic columns and neutralises spreadsheet formulas", () => {
  const header = productAuditCsvHeader();
  for (const column of [
    "listing_id",
    "canonical_manufacturer_id",
    "normalized_model",
    "primary_category_id",
    "search_entity_key",
    "identity_status",
    "catalog_primary_category_id",
  ]) {
    assert.ok(header.split(",").includes(column), column);
  }

  const line = productAuditCsvRow(
    exportRow({
      title: '=HYPERLINK("https://example.test","seller, title")',
      rawModel: 'Model "quoted"\nsecond line',
    }),
  );
  assert.match(line, /"'=HYPERLINK\(""https:\/\/example\.test"",""seller, title""\)"/u);
  assert.match(line, /"Model ""quoted""\nsecond line"/u);
});

test("protected product export paginates the service binding and downloads UTF-8 CSV", async () => {
  const calls: CatalogAdminProductExportOptions[] = [];
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/products/export.csv?scope=all"),
    exportEnv(async (options) => {
      calls.push(options);
      return options.afterId === 0
        ? { items: [exportRow()], nextAfterId: 1 }
        : { items: [exportRow({ listingId: 2, sourceId: "source-2" })], nextAfterId: null };
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-disposition") || "",
    /attachment; filename="hifiscout-product-audit-all-\d{4}-\d{2}-\d{2}\.csv"/u,
  );
  assertAdminSecurityHeaders(response);
  assert.deepEqual(calls, [
    { scope: "all", afterId: 0, limit: 500 },
    { scope: "all", afterId: 1, limit: 500 },
  ]);

  const body = await response.text();
  assert.ok(body.startsWith(`${PRODUCT_AUDIT_CSV_BOM}listing_id,shop_key`));
  assert.match(body, /"source-1"/u);
  assert.match(body, /"source-2"/u);
});

test("product export defaults to active listings and rejects an unknown scope", async () => {
  const calls: CatalogAdminProductExportOptions[] = [];
  const env = exportEnv(async (options) => {
    calls.push(options);
    return { items: [], nextAfterId: null };
  });

  const active = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/products/export.csv"),
    env,
  );
  assert.equal(active.status, 200);
  assert.deepEqual(calls, [{ scope: "active", afterId: 0, limit: 500 }]);

  const invalid = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/products/export.csv?scope=deleted"),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_product_export_scope" });
  assert.equal(calls.length, 1, "invalid input must not reach the main Worker RPC");
});

test("product audit repository exports active rows by default and all history on request", async () => {
  const { sqlite, db } = migratedSqlite();
  const insert = sqlite.prepare(`
    INSERT INTO products(
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
      is_active, raw_manufacturer, manufacturer_id, normalized_raw_manufacturer,
      canonical_manufacturer_id, manufacturer_resolution_status,
      manufacturer_resolution_method, manufacturer_resolution_confidence,
      raw_model, normalized_model, model_resolution_status, model_resolution_method,
      model_resolution_confidence, raw_category, primary_category_id, category_ids,
      classification_status
    ) VALUES (
      ?, ?, 'EDISCREATION', 'Fiber Box 2 JPSM', ?, 'その他', '中古',
      ?, 'in_stock', ?, ?, ?, ?,
      ?, 'EDISCREATION', 'ediscreation', 'ediscreation',
      'ediscreation', 'resolved', 'bootstrap_alias', 'high',
      'Fiber Box 2 JPSM', 'FIBERBOX2JPSM', 'resolved', 'seller_model',
      'high', '光アイソレーター', 'other', '["other"]', 'classified'
    )
  `);
  const activeId = Number(
    insert.run(
      "shop-a",
      "a-1",
      "EDISCREATION Fiber Box 2 JPSM",
      125_000,
      "https://example.test/a-1",
      "2026-08-20T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
      1,
    ).lastInsertRowid,
  );
  const inactiveId = Number(
    insert.run(
      "shop-b",
      "b-1",
      "EDISCREATION Fiber Box 2 JPSM sold",
      118_000,
      "https://example.test/b-1",
      "2026-08-10T00:00:00.000Z",
      "2026-08-11T00:00:00.000Z",
      "2026-08-11T00:00:00.000Z",
      0,
    ).lastInsertRowid,
  );

  const entityId = Number(
    sqlite
      .prepare(`
        INSERT INTO product_search_entities(
          entity_key, entity_kind, fallback_listing_id, manufacturer_id, manufacturer,
          model, normalized_model, primary_category_id, offer_count, shop_count
        ) VALUES (?, 'unresolved_listing', ?, 'ediscreation', 'EDISCREATION',
          'Fiber Box 2 JPSM', 'FIBERBOX2JPSM', 'other', 1, 1)
      `)
      .run(`l-${activeId}`, activeId).lastInsertRowid,
  );
  sqlite
    .prepare(
      "INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (?, ?, 'shop-a')",
    )
    .run(activeId, entityId);
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, status, match_method, confidence, normalized_model, evaluated_at
      ) VALUES (?, 'unresolved', 'none', 'none', 'FIBERBOX2JPSM', ?)
    `)
    .run(activeId, "2026-08-22T00:00:00.000Z");

  const active = await listProductAuditExportPage(db, { scope: "active", afterId: 0, limit: 50 });
  assert.equal(active.items.length, 1);
  assert.equal(active.items[0]?.listingId, activeId);
  assert.equal(active.items[0]?.normalizedModel, "FIBERBOX2JPSM");
  assert.equal(active.items[0]?.searchEntityKey, `l-${activeId}`);
  assert.equal(active.items[0]?.identityStatus, "unresolved");
  assert.equal(active.nextAfterId, null);

  const all = await listProductAuditExportPage(db, { scope: "all", afterId: 0, limit: 50 });
  assert.deepEqual(
    all.items.map((item) => item.listingId),
    [activeId, inactiveId],
  );
  assert.equal(all.items[1]?.searchEntityKey, "");
});
