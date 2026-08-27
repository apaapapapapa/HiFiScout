import type {
  ProductCorrectionReportReason,
  ProductCorrectionReportStatus,
} from "../api/product-correction-report-contract.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export const PRODUCT_CORRECTION_REPORT_DEDUPE_HOURS = 24;
export const PRODUCT_CORRECTION_REPORT_PENDING_RETENTION_DAYS = 180;
export const PRODUCT_CORRECTION_REPORT_RESOLVED_RETENTION_DAYS = 730;

export interface ProductCorrectionReportSnapshot {
  productKey: string;
  listingProductId: number | null;
  reason: ProductCorrectionReportReason;
  explanation: string;
  manufacturer: string;
  model: string;
  category: string;
  shopKey: string;
}

interface ProductCorrectionReportRow {
  id: number;
  product_key: string;
  listing_product_id: number | null;
  reason: ProductCorrectionReportReason;
  explanation: string;
  snapshot_manufacturer: string;
  snapshot_model: string;
  snapshot_category: string;
  snapshot_shop_key: string;
  status: ProductCorrectionReportStatus;
  resolution_note: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ProductCorrectionReport {
  id: number;
  productKey: string;
  listingProductId: number | null;
  reason: ProductCorrectionReportReason;
  explanation: string;
  snapshot: {
    manufacturer: string;
    model: string;
    category: string;
    shopKey: string;
  };
  status: ProductCorrectionReportStatus;
  resolutionNote: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ProductCorrectionReportListOptions {
  status: ProductCorrectionReportStatus | "";
  reason: ProductCorrectionReportReason | "";
  shopKey: string;
  maxAgeDays: number | null;
  beforeId: number | null;
  limit: number;
}

export interface ProductCorrectionReportListResult {
  items: ProductCorrectionReport[];
  nextBeforeId: number | null;
  hasMore: boolean;
}

export type ProductCorrectionReportAdminAction =
  | "review_started"
  | "accepted"
  | "rejected"
  | "duplicate";

function cutoffIso(now: Date, amount: number, unit: "hours" | "days"): string {
  const milliseconds = amount * (unit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
  return new Date(now.getTime() - milliseconds).toISOString();
}

function toReport(row: ProductCorrectionReportRow): ProductCorrectionReport {
  return {
    id: Number(row.id),
    productKey: row.product_key,
    listingProductId: row.listing_product_id == null ? null : Number(row.listing_product_id),
    reason: row.reason,
    explanation: row.explanation || "",
    snapshot: {
      manufacturer: row.snapshot_manufacturer || "",
      model: row.snapshot_model || "",
      category: row.snapshot_category || "",
      shopKey: row.snapshot_shop_key || "",
    },
    status: row.status,
    resolutionNote: row.resolution_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

const REPORT_COLUMNS = `
  id, product_key, listing_product_id, reason, explanation,
  snapshot_manufacturer, snapshot_model, snapshot_category, snapshot_shop_key,
  status, resolution_note, created_at, updated_at, resolved_at
`;

export async function createProductCorrectionReport(
  db: QueryableDatabase,
  snapshot: ProductCorrectionReportSnapshot,
  now = new Date(),
): Promise<{ accepted: true; deduplicated: boolean }> {
  const createdAt = now.toISOString();
  const dedupeAfter = cutoffIso(now, PRODUCT_CORRECTION_REPORT_DEDUPE_HOURS, "hours");
  const result = await db
    .prepare(`
      INSERT INTO product_correction_reports(
        product_key, listing_product_id, reason, explanation,
        snapshot_manufacturer, snapshot_model, snapshot_category, snapshot_shop_key,
        status, resolution_note, created_at, updated_at, resolved_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM product_correction_reports
        WHERE product_key = ?
          AND ((listing_product_id IS NULL AND ? IS NULL) OR listing_product_id = ?)
          AND reason = ?
          AND status IN ('open', 'in_review')
          AND created_at >= ?
      )
    `)
    .bind(
      snapshot.productKey,
      snapshot.listingProductId,
      snapshot.reason,
      snapshot.explanation,
      snapshot.manufacturer,
      snapshot.model,
      snapshot.category,
      snapshot.shopKey,
      createdAt,
      createdAt,
      snapshot.productKey,
      snapshot.listingProductId,
      snapshot.listingProductId,
      snapshot.reason,
      dedupeAfter,
    )
    .run();
  return { accepted: true, deduplicated: Number(result.meta?.changes || 0) === 0 };
}

export async function listProductCorrectionReports(
  db: ReadableDatabase,
  options: ProductCorrectionReportListOptions,
  now = new Date(),
): Promise<ProductCorrectionReportListResult> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (options.status) {
    where.push("status = ?");
    binds.push(options.status);
  }
  if (options.reason) {
    where.push("reason = ?");
    binds.push(options.reason);
  }
  if (options.shopKey) {
    where.push("snapshot_shop_key = ?");
    binds.push(options.shopKey);
  }
  if (options.maxAgeDays !== null) {
    where.push("created_at >= ?");
    binds.push(cutoffIso(now, options.maxAgeDays, "days"));
  }
  if (options.beforeId !== null) {
    where.push("id < ?");
    binds.push(options.beforeId);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await db
    .prepare(`
      SELECT ${REPORT_COLUMNS}
      FROM product_correction_reports
      ${filter}
      ORDER BY id DESC
      LIMIT ?
    `)
    .bind(...binds, options.limit + 1)
    .all<ProductCorrectionReportRow>();
  const rows = result.results || [];
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit).map(toReport);
  return {
    items: page,
    hasMore,
    nextBeforeId: hasMore && page.length ? page[page.length - 1].id : null,
  };
}

async function getProductCorrectionReport(
  db: ReadableDatabase,
  reportId: number,
): Promise<ProductCorrectionReport | null> {
  const row = await db
    .prepare(`SELECT ${REPORT_COLUMNS} FROM product_correction_reports WHERE id = ? LIMIT 1`)
    .bind(reportId)
    .first<ProductCorrectionReportRow>();
  return row ? toReport(row) : null;
}

function nextStatus(action: ProductCorrectionReportAdminAction): ProductCorrectionReportStatus {
  if (action === "review_started") return "in_review";
  return action;
}

function transitionAllowed(
  current: ProductCorrectionReportStatus,
  action: ProductCorrectionReportAdminAction,
): boolean {
  if (current === "open") return action === "review_started" || action === "rejected" || action === "duplicate";
  if (current === "in_review") return action === "accepted" || action === "rejected" || action === "duplicate";
  return false;
}

export async function updateProductCorrectionReport(
  db: QueryableDatabase,
  reportId: number,
  action: ProductCorrectionReportAdminAction,
  note: string,
  now = new Date(),
): Promise<ProductCorrectionReport | null> {
  const current = await getProductCorrectionReport(db, reportId);
  if (!current) return null;
  if (!transitionAllowed(current.status, action)) throw new Error("invalid_correction_report_transition");
  if (action === "accepted" && !note.trim()) throw new Error("correction_report_resolution_reference_required");
  if ((action === "rejected" || action === "duplicate") && !note.trim()) {
    throw new Error("correction_report_resolution_note_required");
  }

  const status = nextStatus(action);
  const at = now.toISOString();
  const resolved = status === "accepted" || status === "rejected" || status === "duplicate";
  await db.batch([
    db
      .prepare(`
        UPDATE product_correction_reports
        SET status = ?, resolution_note = ?, updated_at = ?, resolved_at = ?
        WHERE id = ? AND status = ?
      `)
      .bind(status, note.trim(), at, resolved ? at : null, reportId, current.status),
    db
      .prepare(`
        INSERT INTO product_correction_report_events(
          report_id, action, previous_status, new_status, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(reportId, action, current.status, status, note.trim(), at),
  ]);
  return getProductCorrectionReport(db, reportId);
}

export async function cleanupProductCorrectionReports(
  db: QueryableDatabase,
  limit: number,
  now = new Date(),
): Promise<number> {
  const pendingBefore = cutoffIso(now, PRODUCT_CORRECTION_REPORT_PENDING_RETENTION_DAYS, "days");
  const resolvedBefore = cutoffIso(now, PRODUCT_CORRECTION_REPORT_RESOLVED_RETENTION_DAYS, "days");
  const result = await db
    .prepare(`
      DELETE FROM product_correction_reports
      WHERE id IN (
        SELECT id
        FROM product_correction_reports
        WHERE (
          status IN ('open', 'in_review') AND created_at < ?
        ) OR (
          status IN ('accepted', 'rejected', 'duplicate')
          AND resolved_at IS NOT NULL
          AND resolved_at < ?
        )
        ORDER BY COALESCE(resolved_at, created_at) ASC, id ASC
        LIMIT ?
      )
    `)
    .bind(pendingBefore, resolvedBefore, limit)
    .run();
  return Number(result.meta?.changes || 0);
}
