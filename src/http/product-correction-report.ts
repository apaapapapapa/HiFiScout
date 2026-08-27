import {
  PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES,
  parseProductCorrectionReportRequest,
} from "../api/product-correction-report-contract.js";
import { createProductCorrectionReport } from "../db/product-correction-report-repository.js";
import { productSearchDetail } from "../db/product-search-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { json } from "./response.js";

const REQUEST_BODY_TOO_LARGE = Symbol("request_body_too_large");

interface ProductCorrectionReportEnv {
  readonly DB: QueryableDatabase;
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function isSameOriginMutation(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== url.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

async function readBoundedJson(
  request: Request,
): Promise<unknown | typeof REQUEST_BODY_TOO_LARGE | null> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES) {
    return REQUEST_BODY_TOO_LARGE;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES) {
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
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function handleProductCorrectionReport(
  request: Request,
  env: ProductCorrectionReportEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isJsonRequest(request)) return json({ error: "application_json_required" }, { status: 415 });
  if (!isSameOriginMutation(request, url))
    return json({ error: "same_origin_required" }, { status: 403 });

  const body = await readBoundedJson(request);
  if (body === REQUEST_BODY_TOO_LARGE)
    return json({ error: "request_body_too_large" }, { status: 413 });
  if (body === null) return json({ error: "invalid_json" }, { status: 400 });
  const input = parseProductCorrectionReportRequest(body);
  if (!input) return json({ error: "invalid_correction_report" }, { status: 400 });

  const detail = await productSearchDetail(env.DB, input.productKey);
  if (!detail) return json({ error: "report_target_not_found" }, { status: 404 });
  const offer =
    input.listingProductId === undefined
      ? null
      : detail.offers.find(
          (candidate) => candidate.listing_product_id === input.listingProductId,
        ) || null;
  if (input.listingProductId !== undefined && !offer) {
    return json({ error: "report_listing_not_in_product" }, { status: 400 });
  }

  await createProductCorrectionReport(env.DB, {
    productKey: input.productKey,
    listingProductId: input.listingProductId ?? null,
    reason: input.reason,
    explanation: input.explanation || "",
    manufacturer: detail.product.manufacturer || "",
    model: detail.product.model || "",
    category: detail.product.category || "",
    shopKey: offer?.shop_key || "",
  });

  // Deliberately generic: callers cannot use the response to enumerate queue state or duplicates.
  return json({ accepted: true }, { status: 202 });
}
