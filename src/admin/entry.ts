import { json, isSameOriginBrowserMutation, withCatalogAdminSecurityHeaders } from "./http.js";
import { isJsonRequest, readJsonBody, REQUEST_BODY_TOO_LARGE } from "../http/request.js";
import catalogAdmin from "./index.js";
import { requireCloudflareAccess } from "./access.js";
import type { CatalogAdminRpc } from "./contracts.js";
import { parseOfferFactChanges } from "../catalog/offer-fact-decisions.js";
import type { OfferFactChanges } from "../catalog/offer-fact-decisions.js";
import {
  parseListingAdminListQuery,
  parseListingAdminUpdate,
  type ListingAdminListOptions,
  type ListingAdminUpdateInput,
} from "../http/listing-admin.js";
import {
  parseProductCorrectionReportAction,
  parseProductCorrectionReportListQuery,
} from "../http/product-correction-report-admin.js";
import type {
  ProductCorrectionReportAdminAction,
  ProductCorrectionReportListOptions,
} from "../db/product-correction-report-repository.js";

interface ListingAdminRpc extends CatalogAdminRpc {
  getOfferFacts(listingId: number): Promise<unknown>;
  updateOfferFacts(listingId: number, changes: OfferFactChanges): Promise<unknown>;
  listListings(options: ListingAdminListOptions): Promise<unknown>;
  updateListing(listingId: number, input: ListingAdminUpdateInput): Promise<unknown>;
  listCorrectionReports(options: ProductCorrectionReportListOptions): Promise<unknown>;
  updateCorrectionReport(
    reportId: number,
    action: ProductCorrectionReportAdminAction,
    note: string,
  ): Promise<unknown>;
}

interface AdminEnv {
  ADMIN_ASSETS: Fetcher;
  CATALOG_ADMIN: ListingAdminRpc;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const LISTING_COLLECTION_PATH = "/api/admin/listings";
const LISTING_PATH = /^\/api\/admin\/listings\/(\d{1,15})$/u;
const OFFER_FACT_PATH = /^\/api\/admin\/listings\/(\d{1,15})\/offer-facts$/u;
const CORRECTION_REPORT_COLLECTION_PATH = "/api/admin/correction-reports";
const CORRECTION_REPORT_PATH = /^\/api\/admin\/correction-reports\/(\d{1,15})$/u;
const CONSOLE_ASSET_PATHS = new Set([
  "/admin-console.css",
  "/admin-console.js",
  "/catalog-admin.css",
  "/hifiscout-mark.jpg",
  "/listing-admin.css",
]);
const RETIRED_LEGACY_PATHS = new Set([
  "/catalog-admin",
  "/listing-admin",
  "/catalog-admin.html",
  "/listing-admin.html",
  "/catalog-admin.js",
  "/catalog-admin-operations.js",
  "/listing-admin.js",
]);
function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

async function adminAsset(env: AdminEnv, request: Request): Promise<Response> {
  return withCatalogAdminSecurityHeaders(await env.ADMIN_ASSETS.fetch(request));
}

function isAdminEntryRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    CONSOLE_ASSET_PATHS.has(pathname) ||
    RETIRED_LEGACY_PATHS.has(pathname) ||
    pathname === LISTING_COLLECTION_PATH ||
    LISTING_PATH.test(pathname) ||
    OFFER_FACT_PATH.test(pathname) ||
    pathname === CORRECTION_REPORT_COLLECTION_PATH ||
    CORRECTION_REPORT_PATH.test(pathname)
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

function correctionReportUpdateError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "invalid_correction_report_transition" ||
    message === "correction_report_resolution_reference_required" ||
    message === "correction_report_resolution_note_required"
  ) {
    return json({ error: message }, { status: 409 });
  }
  console.error(JSON.stringify({ message: "correction report update failed", error: message }));
  return json({ error: "correction_report_update_failed" }, { status: 500 });
}

export async function handleAuthenticatedAdminEntryRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  const url = new URL(request.url);

  const offerFactMatch = url.pathname.match(OFFER_FACT_PATH);
  if (offerFactMatch && (request.method === "GET" || request.method === "PATCH")) {
    const listingId = Number(offerFactMatch[1]);
    if (!Number.isSafeInteger(listingId) || listingId <= 0)
      return json({ error: "invalid_id" }, { status: 400 });
    if (request.method === "GET") {
      const result = await env.CATALOG_ADMIN.getOfferFacts(listingId);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    }
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 4096);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    const changes = parseOfferFactChanges(body);
    if (!changes) return json({ error: "invalid_offer_fact_changes" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.updateOfferFacts(listingId, changes);
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return updateError(error);
    }
  }

  if (request.method === "GET" && url.pathname === LISTING_COLLECTION_PATH) {
    const options = parseListingAdminListQuery(url);
    if (!options) return json({ error: "invalid_listing_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listListings(options));
  }

  if (request.method === "GET" && url.pathname === CORRECTION_REPORT_COLLECTION_PATH) {
    const options = parseProductCorrectionReportListQuery(url);
    if (!options) return json({ error: "invalid_correction_report_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.listCorrectionReports(options));
  }

  const correctionReportMatch = url.pathname.match(CORRECTION_REPORT_PATH);
  if (request.method === "PATCH" && correctionReportMatch) {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const reportId = Number(correctionReportMatch[1]);
    if (!Number.isSafeInteger(reportId) || reportId <= 0)
      return json({ error: "invalid_id" }, { status: 400 });
    const body = await readJsonBody(request, 4 * 1024);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const parsed = parseProductCorrectionReportAction(body);
    if (!parsed) return json({ error: "invalid_correction_report_action" }, { status: 400 });
    try {
      const result = await env.CATALOG_ADMIN.updateCorrectionReport(
        reportId,
        parsed.action,
        parsed.note,
      );
      return result ? json(result) : json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return correctionReportUpdateError(error);
    }
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
  if (request.method === "GET" && RETIRED_LEGACY_PATHS.has(url.pathname)) {
    return json({ error: "not_found" }, { status: 404 });
  }
  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!isAdminEntryRoute(pathname)) return catalogAdmin.fetch(request, env);

    const denied = await requireCloudflareAccess(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN || "",
      audience: env.ACCESS_AUD || "",
    });
    if (denied) return denied;
    return handleAuthenticatedAdminEntryRequest(request, env);
  },
} satisfies ExportedHandler<AdminEnv>;
