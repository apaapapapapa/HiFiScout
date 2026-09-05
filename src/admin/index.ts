import { json, isSameOriginBrowserMutation, withCatalogAdminSecurityHeaders } from "./http.js";
import { isJsonRequest, readJsonBody, REQUEST_BODY_TOO_LARGE } from "../http/request.js";
import { SHOP_DEFINITIONS } from "../config.js";
import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import type { CategoryDefinition } from "../catalog/types.js";
import type { CatalogAdminProductExportScope, CatalogAdminRpc } from "./contracts.js";
import {
  parseKnowledgeCatalogAdminCreate,
  parseKnowledgeCatalogAdminListQuery,
  parseKnowledgeCatalogAdminMerge,
  parseKnowledgeCatalogAdminUpdate,
  parseKnowledgeCatalogDuplicateListQuery,
} from "../http/knowledge-catalog-admin.js";
import { verifyCloudflareAccessRequest } from "./access.js";

interface CatalogAdminEnv {
  ADMIN_ASSETS: Fetcher;
  CATALOG_ADMIN: CatalogAdminRpc;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const COLLECTION_PATH = "/api/admin/knowledge-catalog/products";
const CANDIDATE_COLLECTION_PATH = "/api/admin/knowledge-catalog/candidates";
const DUPLICATE_COLLECTION_PATH = "/api/admin/knowledge-catalog/duplicates";
const CANDIDATE_VERIFY_PATH = /^\/api\/admin\/knowledge-catalog\/candidates\/(\d{1,15})\/verify$/u;
const PRODUCT_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})$/u;
const PRODUCT_MERGE_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})\/merge$/u;
const CATALOG_EXPORT_COLLECTION_PATH = "/api/admin/knowledge-catalog-exports";
const CATALOG_EXPORT_JOB_PATH =
  /^\/api\/admin\/knowledge-catalog-exports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/download)?$/iu;
const PRODUCT_EXPORT_COLLECTION_PATH = "/api/admin/product-audit-exports";
const PRODUCT_EXPORT_JOB_PATH =
  /^\/api\/admin\/product-audit-exports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/download)?$/iu;
const ADMIN_ASSET_PATHS = new Set([
  "/catalog-admin.html",
  "/catalog-admin.css",
  "/catalog-admin.js",
]);
function categoryHierarchy(category: CategoryDefinition): CategoryDefinition[] {
  const path: CategoryDefinition[] = [];
  const seen = new Set<string>();
  let current: CategoryDefinition | null = category;
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? getCategory(current.parentId) : null;
  }
  return path;
}

function categoryFacets() {
  return canonicalCategoryDefinitions()
    .filter((category) => category.filterable || category.classifiable)
    .map((category) => ({ category, hierarchy: categoryHierarchy(category) }))
    .sort((left, right) => {
      const depth = Math.min(left.hierarchy.length, right.hierarchy.length);
      for (let index = 0; index < depth; index += 1) {
        const difference =
          (left.hierarchy[index]?.order || 999) - (right.hierarchy[index]?.order || 999);
        if (difference) return difference;
      }
      return (
        left.hierarchy.length - right.hierarchy.length ||
        left.category.id.localeCompare(right.category.id)
      );
    })
    .map(({ category, hierarchy }) => ({
      id: category.id,
      name: `${"　".repeat(Math.max(0, hierarchy.length - 1))}${category.name}`,
      classifiable: category.classifiable,
      filterable: category.filterable,
    }));
}

function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

async function adminAsset(env: CatalogAdminEnv, request: Request): Promise<Response> {
  return withCatalogAdminSecurityHeaders(await env.ADMIN_ASSETS.fetch(request));
}

function productExportScope(value: unknown): CatalogAdminProductExportScope | null {
  return value === "active" || value === "all" ? value : null;
}

function productExportScopeFromBody(value: unknown): CatalogAdminProductExportScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return productExportScope((value as Record<string, unknown>).scope);
}

function isEmptyJsonObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function knowledgeCatalogExportUnavailable(error: unknown, operation: string): Response {
  console.error(
    JSON.stringify({
      message: "Knowledge Catalog export RPC unavailable",
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return json(
    { error: "knowledge_catalog_export_unavailable" },
    { status: 503, headers: { "retry-after": "30" } },
  );
}

function manualOperationError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("catalog_admin_product_already_exists:")) {
    const existingProductId = Number(message.split(":", 2)[1] || 0);
    return json(
      { error: "catalog_admin_product_already_exists", existingProductId },
      { status: 409 },
    );
  }
  if (
    message === "catalog_admin_category_invalid" ||
    message === "catalog_admin_model_invalid" ||
    message === "catalog_admin_merge_same_product" ||
    message === "catalog_admin_merge_target_category_missing"
  ) {
    return json({ error: message }, { status: 400 });
  }
  if (message === "catalog_admin_merge_manufacturer_mismatch") {
    return json({ error: message }, { status: 409 });
  }
  console.error(
    JSON.stringify({ message: "Catalog Admin manual operation failed", error: message }),
  );
  return json({ error: "catalog_admin_manual_operation_failed" }, { status: 500 });
}

async function mutationBody(
  request: Request,
  url: URL,
  maxBytes?: number,
): Promise<unknown | Response> {
  if (!isJsonRequest(request)) {
    return json({ error: "application_json_required" }, { status: 415 });
  }
  if (!isSameOriginBrowserMutation(request, url)) {
    return json({ error: "same_origin_required" }, { status: 403 });
  }
  const body = await readJsonBody(request, maxBytes);
  if (body === REQUEST_BODY_TOO_LARGE) {
    return json({ error: "request_body_too_large" }, { status: 413 });
  }
  if (body === null) return json({ error: "invalid_json" }, { status: 400 });
  return body;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export async function handleAuthenticatedCatalogAdminRequest(
  request: Request,
  env: CatalogAdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/meta") {
    return json({
      categoryFacets: categoryFacets(),
      shops: Object.values(SHOP_DEFINITIONS).map(({ key, name }) => ({ key, name })),
    });
  }
  if (request.method === "POST" && url.pathname === CATALOG_EXPORT_COLLECTION_PATH) {
    const body = await mutationBody(request, url, 1024);
    if (isResponse(body)) return body;
    if (!isEmptyJsonObject(body)) {
      return json({ error: "invalid_knowledge_catalog_export_request" }, { status: 400 });
    }
    try {
      const job = await env.CATALOG_ADMIN.startKnowledgeCatalogExport();
      return json(job, { status: job.status === "failed" ? 503 : 202 });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Knowledge Catalog export could not be queued",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: "knowledge_catalog_export_start_failed" }, { status: 503 });
    }
  }
  if (request.method === "GET" && url.pathname === CATALOG_EXPORT_COLLECTION_PATH) {
    try {
      return json({ job: await env.CATALOG_ADMIN.latestKnowledgeCatalogExportJob() });
    } catch (error) {
      return knowledgeCatalogExportUnavailable(error, "latest");
    }
  }

  const catalogExportJobMatch = url.pathname.match(CATALOG_EXPORT_JOB_PATH);
  if (request.method === "GET" && catalogExportJobMatch) {
    const jobId = catalogExportJobMatch[1];
    try {
      if (catalogExportJobMatch[2]) {
        return withCatalogAdminSecurityHeaders(
          await env.CATALOG_ADMIN.downloadKnowledgeCatalogExport(jobId),
        );
      }
      const job = await env.CATALOG_ADMIN.getKnowledgeCatalogExportJob(jobId);
      return job ? json(job) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return knowledgeCatalogExportUnavailable(
        error,
        catalogExportJobMatch[2] ? "download" : "status",
      );
    }
  }
  if (request.method === "POST" && url.pathname === PRODUCT_EXPORT_COLLECTION_PATH) {
    const body = await mutationBody(request, url, 1024);
    if (isResponse(body)) return body;
    const scope = productExportScopeFromBody(body);
    if (!scope) return json({ error: "invalid_product_export_scope" }, { status: 400 });
    try {
      const job = await env.CATALOG_ADMIN.startProductAuditExport(scope);
      return json(job, { status: job.status === "failed" ? 503 : 202 });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "product audit export could not be queued",
          scope,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: "product_audit_export_start_failed" }, { status: 503 });
    }
  }
  if (request.method === "GET" && url.pathname === PRODUCT_EXPORT_COLLECTION_PATH) {
    const scope = productExportScope(url.searchParams.get("scope"));
    if (!scope) return json({ error: "invalid_product_export_scope" }, { status: 400 });
    return json({ job: await env.CATALOG_ADMIN.latestProductAuditExportJob(scope) });
  }

  const exportJobMatch = url.pathname.match(PRODUCT_EXPORT_JOB_PATH);
  if (request.method === "GET" && exportJobMatch) {
    const jobId = exportJobMatch[1];
    if (exportJobMatch[2]) {
      return withCatalogAdminSecurityHeaders(
        await env.CATALOG_ADMIN.downloadProductAuditExport(jobId),
      );
    }
    const job = await env.CATALOG_ADMIN.getProductAuditExportJob(jobId);
    return job ? json(job) : json({ error: "not_found" }, { status: 404 });
  }

  if (request.method === "GET" && url.pathname === COLLECTION_PATH) {
    const options = parseKnowledgeCatalogAdminListQuery(url);
    if (!options) return json({ error: "invalid_catalog_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listProducts(options));
  }
  if (request.method === "GET" && url.pathname === CANDIDATE_COLLECTION_PATH) {
    const options = parseKnowledgeCatalogAdminListQuery(url);
    if (!options) return json({ error: "invalid_catalog_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listCandidates(options));
  }
  if (request.method === "GET" && url.pathname === DUPLICATE_COLLECTION_PATH) {
    const options = parseKnowledgeCatalogDuplicateListQuery(url);
    if (!options) return json({ error: "invalid_catalog_duplicate_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listDuplicates(options));
  }
  if (request.method === "POST" && url.pathname === COLLECTION_PATH) {
    const body = await mutationBody(request, url);
    if (isResponse(body)) return body;
    const input = parseKnowledgeCatalogAdminCreate(body);
    if (!input) return json({ error: "invalid_catalog_create" }, { status: 400 });
    try {
      return json(await env.CATALOG_ADMIN.createProduct(input), { status: 201 });
    } catch (error) {
      return manualOperationError(error);
    }
  }

  const candidateVerifyMatch = url.pathname.match(CANDIDATE_VERIFY_PATH);
  if (request.method === "POST" && candidateVerifyMatch) {
    const candidateId = Number(candidateVerifyMatch[1]);
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await mutationBody(request, url);
    if (isResponse(body)) return body;
    const input = parseKnowledgeCatalogAdminCreate(body);
    if (!input) return json({ error: "invalid_catalog_verify" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.verifyCandidate(candidateId, input);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return manualOperationError(error);
    }
  }

  const productMergeMatch = url.pathname.match(PRODUCT_MERGE_PATH);
  if (request.method === "POST" && productMergeMatch) {
    const targetProductId = Number(productMergeMatch[1]);
    if (!Number.isSafeInteger(targetProductId) || targetProductId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await mutationBody(request, url);
    if (isResponse(body)) return body;
    const input = parseKnowledgeCatalogAdminMerge(body);
    if (!input) return json({ error: "invalid_catalog_merge" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.mergeProducts(targetProductId, input.sourceProductId);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return manualOperationError(error);
    }
  }

  const productMatch = url.pathname.match(PRODUCT_PATH);
  if (request.method === "PATCH" && productMatch) {
    const productId = Number(productMatch[1]);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await mutationBody(request, url);
    if (isResponse(body)) return body;
    const input = parseKnowledgeCatalogAdminUpdate(body);
    if (!input) return json({ error: "invalid_catalog_update" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.updateProduct(productId, input);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return manualOperationError(error);
    }
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/catalog-admin")) {
    // Static Assets' default HTML handling maps the clean URL to catalog-admin.html with 200.
    // Fetching /catalog-admin.html instead returns a 307 back to /catalog-admin, which loops
    // when this Worker handles the clean route again after Cloudflare Access authentication.
    return adminAsset(env, assetRequest(request, "/catalog-admin"));
  }
  if (request.method === "GET" && ADMIN_ASSET_PATHS.has(url.pathname)) {
    return adminAsset(env, request);
  }
  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: CatalogAdminEnv): Promise<Response> {
    const claims = await verifyCloudflareAccessRequest(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN || "",
      audience: env.ACCESS_AUD || "",
    });
    if (!claims) return json({ error: "cloudflare_access_required" }, { status: 403 });
    return handleAuthenticatedCatalogAdminRequest(request, env);
  },
} satisfies ExportedHandler<CatalogAdminEnv>;
