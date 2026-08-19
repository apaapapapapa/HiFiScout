import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import type { CategoryDefinition } from "../catalog/types.js";
import type { CatalogAdminRpc } from "./contracts.js";
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
const PRODUCT_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})$/;
const ADMIN_ASSET_PATHS = new Set([
  "/catalog-admin.html",
  "/catalog-admin.css",
  "/catalog-admin.js",
]);

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
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

async function handleAuthenticatedRequest(
  request: Request,
  env: CatalogAdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/meta") {
    return json({ categoryFacets: categoryFacets() });
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
    return env.ADMIN_ASSETS.fetch(assetRequest(request, "/catalog-admin.html"));
  }
  if (request.method === "GET" && ADMIN_ASSET_PATHS.has(url.pathname)) {
    return env.ADMIN_ASSETS.fetch(request);
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
    return handleAuthenticatedRequest(request, env);
  },
} satisfies ExportedHandler<CatalogAdminEnv>;
