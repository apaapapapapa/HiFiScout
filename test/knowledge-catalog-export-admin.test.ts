import assert from "node:assert/strict";
import { test } from "vitest";

import type { CatalogAdminRpc } from "../src/admin/contracts.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import type { KnowledgeCatalogExportJob } from "../src/knowledge-catalog-export/types.js";

const EXPORT_JOB_ID = "0198d32e-6800-7b10-9000-000000000101";

function exportJob(overrides: Partial<KnowledgeCatalogExportJob> = {}): KnowledgeCatalogExportJob {
  return {
    id: EXPORT_JOB_ID,
    status: "queued",
    maxCatalogProductId: 20,
    afterId: 0,
    chunkCount: 0,
    rowCount: 0,
    byteCount: 0,
    deliveryAttempts: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-23T00:00:00.000Z",
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
      async startKnowledgeCatalogExport(): Promise<KnowledgeCatalogExportJob> {
        return exportJob();
      },
      async latestKnowledgeCatalogExportJob(): Promise<KnowledgeCatalogExportJob | null> {
        return null;
      },
      async getKnowledgeCatalogExportJob(): Promise<KnowledgeCatalogExportJob | null> {
        return null;
      },
      async downloadKnowledgeCatalogExport(): Promise<Response> {
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

test("protected Knowledge Catalog export starts one asynchronous job", async () => {
  let calls = 0;
  const acceptedJob = exportJob();
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    exportEnv({
      async startKnowledgeCatalogExport() {
        calls += 1;
        return acceptedJob;
      },
    }),
  );

  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), acceptedJob);
  assertAdminSecurityHeaders(response);
});

test("Knowledge Catalog export reports queue failures without exposing details", async () => {
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    exportEnv({
      async startKnowledgeCatalogExport() {
        throw new Error("queue unavailable");
      },
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "knowledge_catalog_export_start_failed" });
  assertAdminSecurityHeaders(response);
});

test("Knowledge Catalog generation rejects invalid, cross-site, and oversized requests", async () => {
  let calls = 0;
  const env = exportEnv({
    async startKnowledgeCatalogExport() {
      calls += 1;
      return exportJob();
    },
  });
  const cases: Array<[Request, number]> = [
    [
      new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      415,
    ],
    [
      new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      }),
      403,
    ],
    [
      new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      400,
    ],
    [
      new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unexpected: true }),
      }),
      400,
    ],
    [
      new Request("https://admin.example.test/api/admin/knowledge-catalog-exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_024) }),
      }),
      413,
    ],
  ];

  for (const [request, expectedStatus] of cases) {
    const response = await handleAuthenticatedCatalogAdminRequest(request, env);
    assert.equal(response.status, expectedStatus);
    assertAdminSecurityHeaders(response);
  }
  assert.equal(calls, 0);
});

test("Knowledge Catalog export restores latest state and addresses jobs by UUID", async () => {
  const readyJob = exportJob({
    status: "ready",
    rowCount: 12,
    completedAt: "2026-08-22T00:05:00.000Z",
    expiresAt: "2026-08-29T00:05:00.000Z",
  });
  const requestedIds: string[] = [];
  const env = exportEnv({
    async latestKnowledgeCatalogExportJob() {
      return readyJob;
    },
    async getKnowledgeCatalogExportJob(jobId) {
      requestedIds.push(jobId);
      return jobId === readyJob.id ? readyJob : null;
    },
  });

  const latest = await handleAuthenticatedCatalogAdminRequest(
    new Request("https://admin.example.test/api/admin/knowledge-catalog-exports"),
    env,
  );
  assert.equal(latest.status, 200);
  assert.deepEqual(await latest.json(), { job: readyJob });

  const found = await handleAuthenticatedCatalogAdminRequest(
    new Request(`https://admin.example.test/api/admin/knowledge-catalog-exports/${readyJob.id}`),
    env,
  );
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), readyJob);

  const missingId = "0198d32e-6800-7b10-9000-000000000102";
  const missing = await handleAuthenticatedCatalogAdminRequest(
    new Request(`https://admin.example.test/api/admin/knowledge-catalog-exports/${missingId}`),
    env,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  assert.deepEqual(requestedIds, [readyJob.id, missingId]);
});

test("Knowledge Catalog download preserves attachment and admin security headers", async () => {
  const requestedIds: string[] = [];
  const response = await handleAuthenticatedCatalogAdminRequest(
    new Request(
      `https://admin.example.test/api/admin/knowledge-catalog-exports/${EXPORT_JOB_ID}/download`,
    ),
    exportEnv({
      async downloadKnowledgeCatalogExport(jobId) {
        requestedIds.push(jobId);
        return new Response("\uFEFFcatalog_product_id\r\n", {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition":
              'attachment; filename="hifiscout-knowledge-catalog-2026-08-22.csv"',
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
    'attachment; filename="hifiscout-knowledge-catalog-2026-08-22.csv"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertAdminSecurityHeaders(response);
});

test("Knowledge Catalog reads degrade to a retryable response during RPC version skew", async () => {
  const unavailable = async (): Promise<never> => {
    throw new Error("RPC method unavailable");
  };
  const env = exportEnv({
    latestKnowledgeCatalogExportJob: unavailable,
    getKnowledgeCatalogExportJob: unavailable,
    downloadKnowledgeCatalogExport: unavailable,
  });
  const paths = [
    "/api/admin/knowledge-catalog-exports",
    `/api/admin/knowledge-catalog-exports/${EXPORT_JOB_ID}`,
    `/api/admin/knowledge-catalog-exports/${EXPORT_JOB_ID}/download`,
  ];

  for (const path of paths) {
    const response = await handleAuthenticatedCatalogAdminRequest(
      new Request(`https://admin.example.test${path}`),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.deepEqual(await response.json(), {
      error: "knowledge_catalog_export_unavailable",
    });
    assertAdminSecurityHeaders(response);
  }
});
