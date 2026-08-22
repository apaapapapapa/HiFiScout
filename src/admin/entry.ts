import catalogAdmin, { withCatalogAdminSecurityHeaders } from "./index.js";
import { verifyCloudflareAccessRequest } from "./access.js";
import type { CatalogAdminRpc } from "./contracts.js";
import {
  parseListingAdminListQuery,
  parseListingAdminUpdate,
  type ListingAdminListOptions,
  type ListingAdminUpdateInput,
} from "../http/listing-admin.js";

interface ListingAdminRpc extends CatalogAdminRpc {
  listListings(options: ListingAdminListOptions): Promise<unknown>;
  updateListing(listingId: number, input: ListingAdminUpdateInput): Promise<unknown>;
}

interface AdminEnv {
  ADMIN_ASSETS: Fetcher;
  CATALOG_ADMIN: ListingAdminRpc;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const LISTING_COLLECTION_PATH = "/api/admin/listings";
const LISTING_PATH = /^\/api\/admin\/listings\/(\d{1,15})$/u;
const CONSOLE_ASSET_PATHS = new Set([
  "/admin-console.css",
  "/admin-console.js",
  "/catalog-admin.css",
  "/catalog-admin.js",
  "/listing-admin.css",
  "/listing-admin.js",
]);
const INTERNAL_FRAGMENT_PATHS = new Set(["/catalog-admin.html", "/listing-admin.html"]);
const LEGACY_PAGE_PATHS = new Set(["/catalog-admin", "/listing-admin"]);
const REQUEST_BODY_TOO_LARGE = Symbol("request_body_too_large");

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return withCatalogAdminSecurityHeaders(new Response(JSON.stringify(value), { ...init, headers }));
}

function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

async function adminAsset(env: AdminEnv, request: Request): Promise<Response> {
  return withCatalogAdminSecurityHeaders(await env.ADMIN_ASSETS.fetch(request));
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

function isAdminEntryRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    CONSOLE_ASSET_PATHS.has(pathname) ||
    INTERNAL_FRAGMENT_PATHS.has(pathname) ||
    LEGACY_PAGE_PATHS.has(pathname) ||
    pathname === LISTING_COLLECTION_PATH ||
    LISTING_PATH.test(pathname)
  );
}

function updateError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "listing_admin_manufacturer_not_verified") {
    return json({ error: message }, { status: 400 });
  }
  if (message === "listing_admin_category_invalid") {
    return json({ error: message }, { status: 400 });
  }
  console.error(JSON.stringify({ message: "listing admin update failed", error: message }));
  return json({ error: "listing_admin_update_failed" }, { status: 500 });
}

export async function handleAuthenticatedAdminEntryRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === LISTING_COLLECTION_PATH) {
    const options = parseListingAdminListQuery(url);
    if (!options) return json({ error: "invalid_listing_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listListings(options));
  }

  const listingMatch = url.pathname.match(LISTING_PATH);
  if (request.method === "PATCH" && listingMatch) {
    if (!isJsonRequest(request)) {
      return json({ error: "application_json_required" }, { status: 415 });
    }
    if (!isSameOriginBrowserMutation(request, url)) {
      return json({ error: "same_origin_required" }, { status: 403 });
    }
    const listingId = Number(listingMatch[1]);
    if (!Number.isSafeInteger(listingId) || listingId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await readJsonBody(request);
    if (body === REQUEST_BODY_TOO_LARGE) {
      return json({ error: "request_body_too_large" }, { status: 413 });
    }
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const input = parseListingAdminUpdate(body);
    if (!input) return json({ error: "invalid_listing_update" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.updateListing(listingId, input);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return updateError(error);
    }
  }

  if (request.method === "GET" && url.pathname === "/") {
    return adminAsset(env, assetRequest(request, "/index.html"));
  }
  if (request.method === "GET" && CONSOLE_ASSET_PATHS.has(url.pathname)) {
    return adminAsset(env, request);
  }
  if (request.method === "GET" && INTERNAL_FRAGMENT_PATHS.has(url.pathname)) {
    if (request.headers.get("x-admin-fragment") !== "1") {
      return json({ error: "not_found" }, { status: 404 });
    }
    return adminAsset(env, request);
  }
  if (request.method === "GET" && LEGACY_PAGE_PATHS.has(url.pathname)) {
    return json({ error: "not_found" }, { status: 404 });
  }
  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!isAdminEntryRoute(pathname)) return catalogAdmin.fetch(request, env);

    const claims = await verifyCloudflareAccessRequest(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN || "",
      audience: env.ACCESS_AUD || "",
    });
    if (!claims) return json({ error: "cloudflare_access_required" }, { status: 403 });
    return handleAuthenticatedAdminEntryRequest(request, env);
  },
} satisfies ExportedHandler<AdminEnv>;
