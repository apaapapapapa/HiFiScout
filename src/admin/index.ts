import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import type { CategoryDefinition } from "../catalog/types.js";
import type {
  CatalogAdminProductExportScope,
  CatalogAdminRpc,
} from "./contracts.js";
import {
  PRODUCT_AUDIT_CSV_BOM,
  productAuditCsvHeader,
  productAuditCsvRow,
} from "./product-audit-csv.js";
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
const PRODUCT_EXPORT_PATH = "/api/admin/products/export.csv";
const PRODUCT_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})$/;
const PRODUCT_EXPORT_PAGE_SIZE = 500;
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

function csv(value: string, filename: string): Response {
  return withCatalogAdminSecurityHeaders(
    new Response(value, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    }),
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
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

function productExportScope(url: URL): CatalogAdminProductExportScope | null {
  const value = url.searchParams.get("scope") || "active";
  return value === "active" || value === "all" ? value : null;
}

async function productAuditCsv(
  env: CatalogAdminEnv,
  scope: CatalogAdminProductExportScope,
): Promise<Response> {
  const lines = [`${PRODUCT_AUDIT_CSV_BOM}${productAuditCsvHeader()}`];
  let afterId = 0;
  for (;;) {
    const page = await env.CATALOG_ADMIN.exportProductAuditPage({
      scope,
      afterId,
      limit: PRODUCT_EXPORT_PAGE_SIZE,
    });
    for (const item of page.items) lines.push(productAuditCsvRow(item));
    if (page.nextAfterId === null) break;
    if (page.nextAfterId <= afterId) throw new Error("catalog_admin_export_cursor_did_not_advance");
    afterId = page.nextAfterId;
  }

  const date = new Date().toISOString().slice(0, 10);
  return csv(`${lines.join("\r\n")}\r\n`, `hifiscout-product-audit-${scope}-${date}.csv`);
}

export async function handleAuthenticatedCatalogAdminRequest(
  request: Request,
  env: CatalogAdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/meta") {
    return json({ categoryFacets: categoryFacets() });
  }
  if (request.method === "GET" && url.pathname === PRODUCT_EXPORT_PATH) {
    const scope = productExportScope(url);
    if (!scope) return json({ error: "invalid_product_export_scope" }, { status: 400 });
    return productAuditCsv(env, scope);
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
