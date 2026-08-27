import {
  PRODUCT_CORRECTION_REPORT_REASONS,
  PRODUCT_CORRECTION_REPORT_STATUSES,
  type ProductCorrectionReportReason,
  type ProductCorrectionReportStatus,
} from "../api/product-correction-report-contract.js";
import type {
  ProductCorrectionReportAdminAction,
  ProductCorrectionReportListOptions,
} from "../db/product-correction-report-repository.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_NOTE_CHARS = 500;
const ALLOWED_ACTIONS = new Set<ProductCorrectionReportAdminAction>([
  "review_started",
  "accepted",
  "rejected",
  "duplicate",
]);

function boundedText(value: string | null, maxLength: number): string | null {
  if (value === null) return "";
  const text = value.trim();
  return [...text].length <= maxLength ? text : null;
}

function positiveInteger(value: string | null, fallback: number | null): number | null {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseProductCorrectionReportListQuery(
  url: URL,
): ProductCorrectionReportListOptions | null {
  const rawStatus = boundedText(url.searchParams.get("status"), 32);
  const rawReason = boundedText(url.searchParams.get("reason"), 64);
  const shopKey = boundedText(url.searchParams.get("shopKey"), 100);
  if (rawStatus === null || rawReason === null || shopKey === null) return null;
  if (
    rawStatus &&
    !PRODUCT_CORRECTION_REPORT_STATUSES.includes(rawStatus as ProductCorrectionReportStatus)
  ) {
    return null;
  }
  if (
    rawReason &&
    !PRODUCT_CORRECTION_REPORT_REASONS.includes(rawReason as ProductCorrectionReportReason)
  ) {
    return null;
  }
  if (shopKey && !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(shopKey.toLowerCase())) return null;

  const maxAgeDays = positiveInteger(url.searchParams.get("maxAgeDays"), null);
  const beforeId = positiveInteger(url.searchParams.get("beforeId"), null);
  const limit = positiveInteger(url.searchParams.get("limit"), DEFAULT_LIMIT);
  if (limit === null || limit > MAX_LIMIT) return null;
  if (url.searchParams.has("maxAgeDays") && maxAgeDays === null) return null;
  if (url.searchParams.has("beforeId") && beforeId === null) return null;

  return {
    status: (rawStatus || "") as ProductCorrectionReportStatus | "",
    reason: (rawReason || "") as ProductCorrectionReportReason | "",
    shopKey: (shopKey || "").toLowerCase(),
    maxAgeDays,
    beforeId,
    limit,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProductCorrectionReportAction(
  value: unknown,
): { action: ProductCorrectionReportAdminAction; note: string } | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "action" && key !== "note")) return null;
  if (
    typeof value.action !== "string" ||
    !ALLOWED_ACTIONS.has(value.action as ProductCorrectionReportAdminAction)
  ) {
    return null;
  }
  if (value.note !== undefined && typeof value.note !== "string") return null;
  const note = (value.note || "").trim();
  if ([...note].length > MAX_NOTE_CHARS || note.includes("<") || note.includes(">")) return null;
  return { action: value.action as ProductCorrectionReportAdminAction, note };
}
