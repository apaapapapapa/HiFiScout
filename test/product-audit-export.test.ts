import assert from "node:assert/strict";
import test from "node:test";

import type { CatalogAdminProductExportRow, CatalogAdminRpc } from "../src/admin/contracts.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import {
  PRODUCT_AUDIT_CSV_BOM,
  productAuditCsvHeader,
  productAuditCsvRow,
} from "../src/admin/product-audit-csv.js";
import { listProductAuditExportPage } from "../src/db/product-audit-export-repository.js";
import {
  encodeProductAuditExportChunk,
  PRODUCT_AUDIT_EXPORT_PAGE_SIZE,
} from "../src/product-audit-export/csv.js";
import type {
  ProductAuditExportJob,
  ProductAuditExportScope,
} from "../src/product-audit-export/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function exportRow(
  overrides: Partial<CatalogAdminProductExportRow> = {},
): CatalogAdminProductExportRow {
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

const EXPORT_JOB_ID = "0198d32e-6800-7b10-9000-000000000001";

function exportJob(overrides: Partial<ProductAuditExportJob> = {}): ProductAuditExportJob {
  return {
    id: EXPORT_JOB_ID,
    scope: "active",
    status: "queued",
    maxListingId: 20,
    afterId: 0,
    chunkCount: 0,
    rowCount: 0,
    byteCount: 0,
    deliveryAttempts: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    completedAt: null,
    expiresAt: null,
    error: "",
    ...overrides,
  };
}

function exportEnv(
  overrides: Partial<CatalogAdminRpc> = {},
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
      async startProductAuditExport(
        scope: ProductAuditExportScope,
      ): Promise<ProductAuditExportJob> {
        return exportJob({ scope });
      },
      async latestProductAuditExportJob(): Promise<ProductAuditExportJob | null> {
        return null;
      },
      async getProductAuditExportJob(): Promise<ProductAuditExportJob | null> {
        return null;
      },
      async downloadProductAuditExport(): Promise<Response> {
        return new Response(null, { status: 404 });
      },
      ...overrides,
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
  const headers = productAuditCsvHeader().split(",");
  for (const column of [
    "listing_id",
    "canonical_manufacturer_id",
    "normalized_model",
    "primary_category_id",
    "search_entity_key",
    "identity_status",
    "catalog_primary_category_id",
  ]) {
    assert.ok(headers.includes(column), column);
  }

  const line = productAuditCsvRow(
    exportRow({
      title: '=HYPERLINK("https://example.test","seller, title")',
      rawModel: 'Model "quoted"\nsecond line',
    }),
  );
  assert.match(line, /"'=HYPERLINK\(""https:\/\/example\.test"",""seller, title""\)"/u);
  assert.match(line, /"Model ""quoted""\nsecond line"/u);

  const csv = `${PRODUCT_AUDIT_CSV_BOM}${productAuditCsvHeader()}\r\n${line}\r\n`;
  const bytes = new TextEncoder().encode(csv);
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.ok(csv.endsWith("\r\n"));
});

test("protected product export starts one asynchronous job and reports queue failures", async () => {
  const scopes: ProductAuditExportScope[] = [];
  const acceptedJob = exportJob({ scope: "all" });
  const accepted = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    }),
    exportEnv({
      async startProductAuditExport(scope) {
        scopes.push(scope);
        return acceptedJob;
      },
    }),
  );

  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), acceptedJob);
  assert.deepEqual(scopes, ["all"]);
  assertAdminSecurityHeaders(accepted);

  const unavailable = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "active" }),
    }),
    exportEnv({
      async startProductAuditExport() {
        throw new Error("queue unavailable");
      },
    }),
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "product_audit_export_start_failed" });
  assertAdminSecurityHeaders(unavailable);
});

test("product export validates scopes before invoking the service binding", async () => {
  let calls = 0;
  const env = exportEnv({
    async startProductAuditExport() {
      calls += 1;
      return exportJob();
    },
  });
  for (const request of [
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "deleted" }),
    }),
    new Request("https://admin.example.test/api/admin/product-audit-exports"),
    new Request("https://admin.example.test/api/admin/product-audit-exports?scope=deleted"),
  ]) {
    const response = await handleAuthenticatedCatalogAdminRequest(request, env);
    assert.equal(response.status, 400);
    assertAdminSecurityHeaders(response);
  }
  assert.equal(calls, 0);
});

test("product export rejects cross-site, non-JSON, and oversized generation requests", async () => {
  let calls = 0;
  const env = exportEnv({
    async startProductAuditExport() {
      calls += 1;
      return exportJob();
    },
  });
  const crossSite = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ scope: "active" }),
    }),
    env,
  );
  assert.equal(crossSite.status, 403);

  const simpleCrossSite = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ scope: "active" }),
    }),
    env,
  );
  assert.equal(simpleCrossSite.status, 415);

  const oversized = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "active", padding: "x".repeat(1_024) }),
    }),
    env,
  );
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

test("product export restores the latest job and polls an individual UUID", async () => {
  const readyJob = exportJob({
    status: "ready",
    rowCount: 2,
    completedAt: "2026-08-22T00:05:00.000Z",
    expiresAt: "2026-08-29T00:05:00.000Z",
  });
  const latestScopes: ProductAuditExportScope[] = [];
  const requestedIds: string[] = [];
  const env = exportEnv({
    async latestProductAuditExportJob(scope) {
      latestScopes.push(scope);
      return readyJob;
    },
    async getProductAuditExportJob(jobId) {
      requestedIds.push(jobId);
      return jobId === readyJob.id ? readyJob : null;
    },
  });

  const latest = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/product-audit-exports?scope=active"),
    env,
  );
  assert.equal(latest.status, 200);
  assert.deepEqual(await latest.json(), { job: readyJob });
  assert.deepEqual(latestScopes, ["active"]);

  const found = await handleAuthenticatedCatalogAdminRequest(
    new Request(`https://admin.example.test/api/admin/product-audit-exports/${readyJob.id}`),
    env,
  );
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), readyJob);
  assert.deepEqual(requestedIds, [readyJob.id]);

  const missingId = "0198d32e-6800-7b10-9000-000000000002";
  const missing = await handleAuthenticatedCatalogAdminRequest(
    new Request(`https://admin.example.test/api/admin/product-audit-exports/${missingId}`),
    env,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
});

test("product export download preserves attachment metadata and admin security headers", async () => {
  const requestedIds: string[] = [];
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request(
      `https://admin.example.test/api/admin/product-audit-exports/${EXPORT_JOB_ID}/download`,
    ),
    exportEnv({
      async downloadProductAuditExport(jobId) {
        requestedIds.push(jobId);
        return new Response(`${PRODUCT_AUDIT_CSV_BOM}${productAuditCsvHeader()}\r\n`, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="hifiscout-product-audit-active.csv"',
            "cache-control": "no-store",
          },
        });
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requestedIds, [EXPORT_JOB_ID]);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="hifiscout-product-audit-active.csv"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertAdminSecurityHeaders(response);
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

  const active = await listProductAuditExportPage(db, {
    scope: "active",
    afterId: 0,
    maxId: inactiveId,
    limit: 50,
  });
  assert.equal(active.items.length, 1);
  assert.equal(active.items[0]?.listingId, activeId);
  assert.equal(active.items[0]?.normalizedModel, "FIBERBOX2JPSM");
  assert.equal(active.items[0]?.searchEntityKey, `l-${activeId}`);
  assert.equal(active.items[0]?.identityStatus, "unresolved");
  assert.equal(active.nextAfterId, null);

  const all = await listProductAuditExportPage(db, {
    scope: "all",
    afterId: 0,
    maxId: inactiveId,
    limit: 50,
  });
  assert.deepEqual(
    all.items.map((item) => item.listingId),
    [activeId, inactiveId],
  );
  assert.equal(all.items[1]?.searchEntityKey, "");

  const oversizedText = "x".repeat(100_000);
  const nulTerminatedTitle = `seller-title\0${"y".repeat(100_000)}`;
  sqlite
    .prepare(`
      UPDATE products SET
        shop_key = @wide,
        source_id = @wide,
        source_url = @wide,
        condition_text = @wide,
        title = @nulTitle,
        raw_manufacturer = @wide,
        manufacturer = @wide,
        manufacturer_id = @wide,
        canonical_manufacturer_id = @wide,
        raw_model = @wide,
        model = @wide,
        normalized_model = @wide,
        raw_category = @wide,
        category = @wide,
        primary_category_id = @wide,
        category_ids = @wide,
        first_seen_at = @wide,
        last_seen_at = @wide,
        last_changed_at = @wide,
        last_activity_at = @wide,
        source_published_at = @wide
      WHERE id = @id
    `)
    .run({ wide: oversizedText, nulTitle: nulTerminatedTitle, id: inactiveId });

  const bounded = await listProductAuditExportPage(db, {
    scope: "all",
    afterId: activeId,
    maxId: inactiveId,
    limit: 1_000,
  });
  const boundedRow = bounded.items[0];
  assert.ok(boundedRow);
  for (const value of Object.values(boundedRow)) {
    if (typeof value !== "string") continue;
    assert.ok(value.length <= 2_048, "every D1 text projection has a fixed character ceiling");
    assert.equal(value.includes("\0"), false, "an embedded NUL cannot bypass SQLite length() caps");
  }
  assert.match(boundedRow.title, / \[truncated\]$/u);
  assert.match(boundedRow.sourceUrl, / \[truncated\]$/u);
  assert.ok(boundedRow.firstSeenAt.length <= 128);

  const stored = sqlite
    .prepare("SELECT CAST(title AS BLOB) AS title_bytes, source_url FROM products WHERE id = ?")
    .get(inactiveId) as { title_bytes: Uint8Array; source_url: string };
  assert.deepEqual(
    stored.title_bytes,
    new TextEncoder().encode(nulTerminatedTitle),
    "export caps must not rewrite seller raw evidence",
  );
  assert.equal(stored.source_url, oversizedText);

  const maximumPageChunk = encodeProductAuditExportChunk(
    Array.from({ length: PRODUCT_AUDIT_EXPORT_PAGE_SIZE }, () => boundedRow),
    0,
  );
  assert.ok(
    maximumPageChunk.byteLength < 16 * 1024 * 1024,
    "one 250-row Queue delivery remains well below the Worker memory ceiling",
  );
});
