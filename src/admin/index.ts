import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import type { CategoryDefinition } from "../catalog/types.js";
import type { CatalogAdminProductExportScope, CatalogAdminRpc } from "./contracts.js";
import {
  parseKnowledgeCatalogAdminListQuery,
  parseKnowledgeCatalogAdminUpdate,
} from "../http/knowledge-catalog-admin.js";
import { verifyCloudflareAccessRequest } from "./access.js";

interface CatalogAdminEnv {
  ADMIN_ASSETS: Fetcher;
  CATALOG_ADMIN: CatalogAdminRpc;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const COLLECTION_PATH = "/api/admin/knowledge-catalog/products";
const PRODUCT_EXPORT_COLLECTION_PATH = "/api/admin/product-audit-exports";
const PRODUCT_EXPORT_JOB_PATH =
  /^\/api\/admin\/product-audit-exports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/download)?$/iu;
const PRODUCT_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})$/;
const ADMIN_ASSET_PATHS = new Set([
  "/catalog-admin.html",
  "/catalog-admin.css",
  "/catalog-admin.js",
]);
const ADMIN_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
const REQUEST_BODY_TOO_LARGE = Symbol("request_body_too_large");

/** Browser hardening is enforced by the Worker so Access policy changes cannot remove it. */
export function withCatalogAdminSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", ADMIN_CONTENT_SECURITY_POLICY);
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return withCatalogAdminSecurityHeaders(new Response(JSON.stringify(value), { ...init, headers }));
}

async function readJsonBody(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown | typeof REQUEST_BODY_TOO_LARGE> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel("request_body_too_large");
      return REQUEST_BODY_TOO_LARGE;
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function isSameOriginBrowserMutation(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

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

export async function handleAuthenticatedCatalogAdminRequest(
  request: Request,
  env: CatalogAdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/meta") {
    return json({ categoryFacets: categoryFacets() });
  }
  if (request.method === "POST" && url.pathname === PRODUCT_EXPORT_COLLECTION_PATH) {
    if (!isJsonRequest(request)) {
      return json({ error: "application_json_required" }, { status: 415 });
    }
    if (!isSameOriginBrowserMutation(request, url)) {
      return json({ error: "same_origin_required" }, { status: 403 });
    }
    const body = await readJsonBody(request, 1024);
    if (body === REQUEST_BODY_TOO_LARGE) {
      return json({ error: "request_body_too_large" }, { status: 413 });
    }
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
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

  const productMatch = url.pathname.match(PRODUCT_PATH);
  if (request.method === "PATCH" && productMatch) {
    const productId = Number(productMatch[1]);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await readJsonBody(request);
    if (body === REQUEST_BODY_TOO_LARGE) {
      return json({ error: "request_body_too_large" }, { status: 413 });
    }
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const input = parseKnowledgeCatalogAdminUpdate(body);
    if (!input) return json({ error: "invalid_catalog_update" }, { status: 400 });
    const result = await env.CATALOG_ADMIN.updateProduct(productId, input);
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
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
