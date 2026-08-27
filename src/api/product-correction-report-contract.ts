import { PRODUCT_CORRECTION_REPORT_REASONS } from "./contracts.js";
import type { ProductCorrectionReportReason, ProductCorrectionReportRequest } from "./contracts.js";
import { parseProductSearchKey } from "./product-search-key.js";

export {
  PRODUCT_CORRECTION_REPORT_REASONS,
  PRODUCT_CORRECTION_REPORT_STATUSES,
} from "./contracts.js";
export type {
  ProductCorrectionReportReason,
  ProductCorrectionReportRequest,
  ProductCorrectionReportStatus,
} from "./contracts.js";

export const PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES = 2 * 1024;
export const PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_CHARS = 500;
export const PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_BYTES = 1_000;

const ALLOWED_REQUEST_KEYS = new Set(["productKey", "listingProductId", "reason", "explanation"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReason(value: unknown): value is ProductCorrectionReportReason {
  return (
    typeof value === "string" &&
    PRODUCT_CORRECTION_REPORT_REASONS.includes(value as ProductCorrectionReportReason)
  );
}

function hasHtmlLikeMarkup(value: string): boolean {
  return value.includes("<") || value.includes(">");
}

export function parseProductCorrectionReportRequest(
  value: unknown,
): ProductCorrectionReportRequest | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !ALLOWED_REQUEST_KEYS.has(key))) return null;
  if (typeof value.productKey !== "string" || !parseProductSearchKey(value.productKey)) return null;
  if (!isReason(value.reason)) return null;

  let listingProductId: number | undefined;
  if (Object.hasOwn(value, "listingProductId")) {
    if (
      typeof value.listingProductId !== "number" ||
      !Number.isSafeInteger(value.listingProductId) ||
      value.listingProductId <= 0
    ) {
      return null;
    }
    listingProductId = value.listingProductId;
  }

  let explanation: string | undefined;
  if (Object.hasOwn(value, "explanation")) {
    if (typeof value.explanation !== "string") return null;
    const text = value.explanation.trim();
    if (
      [...text].length > PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_CHARS ||
      new TextEncoder().encode(text).byteLength > PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_BYTES ||
      hasHtmlLikeMarkup(text)
    ) {
      return null;
    }
    explanation = text;
  }

  return {
    productKey: value.productKey,
    ...(listingProductId === undefined ? {} : { listingProductId }),
    reason: value.reason,
    ...(explanation === undefined ? {} : { explanation }),
  };
}
