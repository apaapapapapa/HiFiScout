import { parseAdminQualityCommand } from "../http/admin-quality.js";
import { parseAdminManufacturerCommand } from "../http/admin-manufacturer-registry.js";
import { parseAdminExtractionRequest } from "../http/admin-extraction-preview.js";
import { parseAdminRestoreSelection } from "./change-history.js";
import type { AdminRestoreSelection } from "../api/admin-listing-contracts.js";
import { isRecord } from "../types.js";
import { json, isSameOriginBrowserMutation, withCatalogAdminSecurityHeaders } from "./http.js";
import { isJsonRequest, readJsonBody, REQUEST_BODY_TOO_LARGE } from "../http/request.js";
import catalogAdmin from "./index.js";
import { requireCloudflareAccess } from "./access.js";
import type { CatalogAdminRpc } from "./contracts.js";
import { parseAdminWorkCountCursor } from "../api/admin-work-counts-contract.js";
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
  previewExtraction(input: unknown): Promise<unknown>;
  getOperations(): Promise<unknown>;
  adminJobs(input: unknown): Promise<unknown>;
  getCrawlOverview(): Promise<unknown>;
  controlCrawl(shopKey: string, action: "pause" | "resume" | "run"): Promise<unknown>;
  getChangeHistory(kind: "listing" | "catalog", id: number): Promise<unknown>;
  previewHistoryRestore(input: AdminRestoreSelection): Promise<unknown>;
  restoreHistoryColor(
    input: AdminRestoreSelection,
    revision: string,
    operationId: string,
  ): Promise<unknown>;
  getListingDiagnosis(listingId: number): Promise<unknown>;
  getOfferFactReplay(): Promise<unknown>;
  stepOfferFactReplay(): Promise<unknown>;
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
const WORK_COUNTS_PATH = "/api/admin/work-counts";
const LISTING_PATH = /^\/api\/admin\/listings\/(\d{1,15})$/u;
const DIAGNOSIS_PATH = /^\/api\/admin\/listings\/(\d{1,15})\/diagnosis$/u;
const OFFER_FACT_PATH = /^\/api\/admin\/listings\/(\d{1,15})\/offer-facts$/u;
const OFFER_FACT_REPLAY_PATH = "/api/admin/offer-facts/replay";
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
    pathname === WORK_COUNTS_PATH ||
    pathname === "/api/admin/extraction-preview" ||
    pathname === "/api/admin/manufacturer-registry" ||
    pathname === "/api/admin/quality" ||
    pathname === "/api/admin/operations" ||
    pathname === "/api/admin/jobs" ||
    pathname === "/api/admin/crawls" ||
    pathname === "/api/admin/crawls/control" ||
    pathname === "/api/admin/change-history" ||
    pathname === "/api/admin/change-history/restore-preview" ||
    pathname === "/api/admin/change-history/restore-color" ||
    LISTING_PATH.test(pathname) ||
    OFFER_FACT_PATH.test(pathname) ||
    DIAGNOSIS_PATH.test(pathname) ||
    pathname === OFFER_FACT_REPLAY_PATH ||
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

  if (url.pathname === "/api/admin/extraction-preview" && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 128 * 1024);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    const input = parseAdminExtractionRequest(body);
    if (!input)
      return json(
        { error: "最大20件のサンプルと有効なショップ・メーカーを指定してください。" },
        { status: 400 },
      );
    try {
      return json(await env.CATALOG_ADMIN.previewExtraction(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        [
          "仮ルールには確認済みメーカーを選択してください。",
          "別名辞書がプレビュー上限を超えています。対象を限定する必要があります。",
        ].includes(message)
      )
        return json({ error: message }, { status: 409 });
      return json(
        { error: "抽出テストを実行できませんでした。入力と対象商品の状態を確認してください。" },
        { status: 503 },
      );
    }
  }

  if (url.pathname === "/api/admin/quality" && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 4096);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    const command = parseAdminQualityCommand(body);
    if (!command) return json({ error: "入力を確認してください。" }, { status: 400 });
    try {
      return json(await env.CATALOG_ADMIN.adminQuality(command));
    } catch {
      return json(
        { error: "品質点検の情報を取得できませんでした。再読み込みしてください。" },
        { status: 503 },
      );
    }
  }

  if (url.pathname === "/api/admin/manufacturer-registry" && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 8192);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    const command = parseAdminManufacturerCommand(body);
    if (!command) return json({ error: "入力を確認してください。" }, { status: 400 });
    const result = await env.CATALOG_ADMIN.manufacturerRegistry(command);
    return json(result, {
      status:
        isRecord(result) &&
        typeof result.status === "number" &&
        [400, 409, 503].includes(result.status)
          ? result.status
          : 200,
    });
  }

  if (url.pathname === "/api/admin/operations" && request.method === "GET")
    return json(await env.CATALOG_ADMIN.getOperations());

  if (url.pathname === "/api/admin/jobs" && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, ADMIN_CSV_MAX_REQUEST_BYTES);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    const command = parseAdminJobCommand(body);
    if (!command) return json({ error: "invalid_admin_job_command" }, { status: 400 });
    try {
      return json(await env.CATALOG_ADMIN.adminJobs(command));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "処理の状態を確認できませんでした。" },
        { status: 503 },
      );
    }
  }

  if (url.pathname === "/api/admin/crawls" && request.method === "GET")
    return json(await env.CATALOG_ADMIN.getCrawlOverview());
  if (url.pathname === "/api/admin/crawls/control" && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 1024);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    if (
      !isRecord(body) ||
      typeof body.shopKey !== "string" ||
      !/^[a-z0-9-]{1,64}$/u.test(body.shopKey) ||
      typeof body.action !== "string" ||
      !["pause", "resume", "run"].includes(body.action)
    )
      return json({ error: "invalid_crawl_control" }, { status: 400 });
    return json(
      await env.CATALOG_ADMIN.controlCrawl(body.shopKey, body.action as "pause" | "resume" | "run"),
    );
  }

  if (url.pathname === "/api/admin/change-history" && request.method === "GET") {
    const kind = url.searchParams.get("kind");
    const id = Number(url.searchParams.get("id"));
    if ((kind !== "listing" && kind !== "catalog") || !Number.isSafeInteger(id) || id < 1)
      return json({ error: "invalid_history_query" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.getChangeHistory(kind, id));
  }
  if (
    [
      "/api/admin/change-history/restore-preview",
      "/api/admin/change-history/restore-color",
    ].includes(url.pathname) &&
    request.method === "POST"
  ) {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 8192);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    if (!isRecord(body)) return json({ error: "invalid_history_restore" }, { status: 400 });
    const selection = parseAdminRestoreSelection(body.selection);
    if (!selection) return json({ error: "invalid_history_restore" }, { status: 400 });
    if (url.pathname.endsWith("restore-preview"))
      return json(await env.CATALOG_ADMIN.previewHistoryRestore(selection));
    if (
      typeof body.revision !== "string" ||
      !/^[\da-f]{64}$/iu.test(body.revision) ||
      typeof body.operationId !== "string" ||
      !/^[\da-f-]{36}$/iu.test(body.operationId)
    )
      return json({ error: "invalid_history_restore" }, { status: 400 });
    return json(
      await env.CATALOG_ADMIN.restoreHistoryColor(selection, body.revision, body.operationId),
    );
  }
  if (url.pathname === WORK_COUNTS_PATH && request.method === "GET") {
    const cursor = parseAdminWorkCountCursor(url);
    if (!cursor) return json({ error: "invalid_work_count_cursor" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.getWorkCounts(cursor));
  }

  if (url.pathname === OFFER_FACT_REPLAY_PATH && request.method === "GET") {
    return json(await env.CATALOG_ADMIN.getOfferFactReplay());
  }
  if (url.pathname === OFFER_FACT_REPLAY_PATH && request.method === "POST") {
    if (!isJsonRequest(request))
      return json({ error: "application_json_required" }, { status: 415 });
    if (!isSameOriginBrowserMutation(request, url))
      return json({ error: "same_origin_required" }, { status: 403 });
    const body = await readJsonBody(request, 1024);
    if (body === REQUEST_BODY_TOO_LARGE)
      return json({ error: "request_body_too_large" }, { status: 413 });
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      return json({ error: "invalid_replay_request" }, { status: 400 });
    return json(await env.CATALOG_ADMIN.stepOfferFactReplay());
  }

  const diagnosisMatch = url.pathname.match(DIAGNOSIS_PATH);
  if (diagnosisMatch && request.method === "GET") {
    const result = await env.CATALOG_ADMIN.getListingDiagnosis(Number(diagnosisMatch[1]));
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
  }

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
import { parseAdminJobCommand } from "../http/admin-jobs.js";
import { ADMIN_CSV_MAX_REQUEST_BYTES } from "../api/admin-csv-contracts.js";
