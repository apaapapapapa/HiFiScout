import type {
  AdminQualityOverview,
  AdminQualityShopIssue,
  AdminQualityKind,
  AdminQualityReportPage,
  AdminQualityReportCursor,
  AdminQualitySamples,
  AdminQualityCandidateCursor,
  AdminQualityCandidatePage,
} from "../api/admin-listing-contracts.js";
import type { ReadableDatabase } from "./types.js";
interface Snapshot {
  evaluated_at: string;
  total_items: number;
  manufacturer_missing_count: number;
  manufacturer_unresolved_count: number;
  category_unclassified_count: number;
  identity_veto_count: number;
  identity_candidate_count: number;
  manufacturer_status: AdminQualityShopIssue["severity"];
  category_status: AdminQualityShopIssue["severity"];
  identity_status: AdminQualityShopIssue["severity"];
}
const severityOrder = { critical: 3, warning: 2, healthy: 1, unknown: 0 };
export async function readAdminQualityOverview(
  db: ReadableDatabase,
  shops: readonly { key: string; name: string }[],
): Promise<AdminQualityOverview> {
  if (shops.length > 32) throw new Error("quality_shop_registry_limit");
  const issues: AdminQualityShopIssue[] = [],
    snapshots: AdminQualityOverview["snapshots"] = [],
    missingShops: AdminQualityOverview["missingShops"] = [];
  for (const shop of shops) {
    const snapshot = (
      await db
        .prepare(`SELECT evaluated_at,total_items,manufacturer_missing_count,manufacturer_unresolved_count,category_unclassified_count,identity_veto_count,identity_candidate_count,manufacturer_status,category_status,identity_status
   FROM data_quality_runs WHERE shop_key=? ORDER BY evaluated_at DESC,id DESC LIMIT 1`)
        .bind(shop.key)
        .all<Snapshot>()
    ).results[0];
    if (!snapshot) {
      missingShops.push({ shopKey: shop.key, shopName: shop.name });
      continue;
    }
    snapshots.push({
      shopKey: shop.key,
      shopName: shop.name,
      snapshotAt: snapshot.evaluated_at,
      total: snapshot.total_items,
    });
    const values: [AdminQualityKind, number, AdminQualityShopIssue["severity"]][] = [
      [
        "manufacturer",
        snapshot.manufacturer_missing_count + snapshot.manufacturer_unresolved_count,
        snapshot.manufacturer_status,
      ],
      ["category", snapshot.category_unclassified_count, snapshot.category_status],
      ["identity_veto", snapshot.identity_veto_count, snapshot.identity_status],
      ["identity_candidate", snapshot.identity_candidate_count, snapshot.identity_status],
    ];
    for (const [kind, count, severity] of values)
      if (count > 0)
        issues.push({
          shopKey: shop.key,
          shopName: shop.name,
          kind,
          count,
          total: snapshot.total_items,
          severity,
          snapshotAt: snapshot.evaluated_at,
        });
  }
  issues.sort(
    (a, b) =>
      severityOrder[b.severity] - severityOrder[a.severity] ||
      b.count - a.count ||
      a.shopKey.localeCompare(b.shopKey) ||
      a.kind.localeCompare(b.kind),
  );
  return { observedAt: new Date().toISOString(), issues, snapshots, missingShops };
}
const REPORT_TARGET =
  "CASE WHEN listing_product_id IS NOT NULL THEN 'listing:'||listing_product_id ELSE 'product:'||product_key END";
interface GroupRow {
  target_key: string;
  reason: string;
  open_count: number;
  report_count: number;
  recurrence_count: number;
  updated_at: string;
}
interface ReportRow {
  id: number;
  listing_product_id: number | null;
  product_key: string;
  snapshot_shop_key: string;
  snapshot_manufacturer: string;
  snapshot_model: string;
}
export async function readAdminQualityReports(
  db: ReadableDatabase,
  before?: AdminQualityReportCursor,
): Promise<AdminQualityReportPage> {
  const result = await db
    .prepare(`SELECT target_key,reason,open_count,report_count,recurrence_count,updated_at FROM admin_quality_report_groups
  WHERE open_count>0 ${before ? "AND (recurrence_count,open_count,updated_at,target_key,reason)<(?,?,?,?,?)" : ""}
  ORDER BY recurrence_count DESC,open_count DESC,updated_at DESC,target_key DESC,reason DESC LIMIT 26`)
    .bind(...(before ?? []))
    .all<GroupRow>();
  const page = result.results.slice(0, 25),
    items: AdminQualityReportPage["items"] = [];
  for (const group of page) {
    const rows = (
      await db
        .prepare(`WITH latest_open AS MATERIALIZED (
   SELECT id,created_at FROM product_correction_reports WHERE (${REPORT_TARGET})=? AND reason=? AND status='open' ORDER BY created_at DESC,id DESC LIMIT 1
  ), latest_review AS MATERIALIZED (
   SELECT id,created_at FROM product_correction_reports WHERE (${REPORT_TARGET})=? AND reason=? AND status='in_review' ORDER BY created_at DESC,id DESC LIMIT 1
  ), latest AS (SELECT * FROM latest_open UNION ALL SELECT * FROM latest_review)
  SELECT r.id,r.listing_product_id,r.product_key,r.snapshot_shop_key,r.snapshot_manufacturer,r.snapshot_model FROM product_correction_reports r
  WHERE r.id=(SELECT id FROM latest ORDER BY created_at DESC,id DESC LIMIT 1)`)
        .bind(group.target_key, group.reason, group.target_key, group.reason)
        .all<ReportRow>()
    ).results;
    const report = rows[0];
    // A report may have been resolved between the projection read and these primary-key probes.
    if (!report) continue;
    const entity = (
      report.listing_product_id !== null
        ? await db
            .prepare(
              "SELECT e.offer_count FROM product_search_entity_offers m JOIN product_search_entities e ON e.id=m.entity_id WHERE m.listing_product_id=?",
            )
            .bind(report.listing_product_id)
            .all<{ offer_count: number }>()
        : await db
            .prepare("SELECT offer_count FROM product_search_entities WHERE entity_key=?")
            .bind(report.product_key)
            .all<{ offer_count: number }>()
    ).results[0];
    items.push({
      targetKey: group.target_key,
      reason: group.reason,
      openCount: group.open_count,
      reportCount: group.report_count,
      recurrenceCount: group.recurrence_count,
      updatedAt: group.updated_at,
      reportId: report.id,
      listingId: report.listing_product_id,
      productKey: report.product_key,
      shopKey: report.snapshot_shop_key,
      manufacturer: report.snapshot_manufacturer,
      model: report.snapshot_model,
      relatedOfferCount: entity?.offer_count ?? null,
      relatedAt: null,
    });
  }
  const last = page.at(-1);
  return {
    observedAt: new Date().toISOString(),
    items,
    nextBefore:
      result.results.length > 25 && last
        ? [last.recurrence_count, last.open_count, last.updated_at, last.target_key, last.reason]
        : null,
  };
}
interface SampleRow {
  id: number;
  title: string;
  manufacturer: string;
  model: string;
  primary_category_id: string;
  manufacturer_resolution_status: string;
  classification_status: string;
  match_method: string | null;
  identity_status: string | null;
  candidate_catalog_product_id: number | null;
}
export async function readAdminQualitySamples(
  db: ReadableDatabase,
  shopKey: string,
  kind: AdminQualityKind,
  afterId: number,
): Promise<AdminQualitySamples> {
  const rows = (
    await db
      .prepare(`WITH page AS MATERIALIZED (
  SELECT id,substr(title,1,1000) AS title,manufacturer,model,primary_category_id,manufacturer_resolution_status,classification_status FROM products INDEXED BY idx_products_admin_shop_cursor
  WHERE shop_key=? AND is_active=1 AND id>? ORDER BY id LIMIT 201
 ) SELECT p.*,r.match_method,r.status AS identity_status,r.candidate_catalog_product_id FROM page p LEFT JOIN product_identity_resolutions r ON r.listing_product_id=p.id ORDER BY p.id`)
      .bind(shopKey, afterId)
      .all<SampleRow>()
  ).results;
  const items: AdminQualitySamples["items"] = [];
  let scanned = 0,
    cursor = afterId;
  for (const row of rows.slice(0, 200)) {
    scanned++;
    cursor = row.id;
    const matches =
      kind === "manufacturer"
        ? row.manufacturer_resolution_status !== "resolved"
        : kind === "category"
          ? row.classification_status !== "classified"
          : kind === "identity_veto"
            ? row.match_method === "vetoed"
            : row.identity_status === "unresolved" && row.candidate_catalog_product_id !== null;
    if (matches)
      items.push({
        id: row.id,
        title: row.title,
        manufacturer: row.manufacturer,
        model: row.model,
        categoryId: row.primary_category_id,
      });
    if (items.length >= 20) break;
  }
  return {
    observedAt: new Date().toISOString(),
    shopKey,
    kind,
    items,
    scanned,
    afterId,
    nextAfterId: cursor,
    hasMore: rows.length > scanned,
  };
}
export async function readAdminQualityCandidates(
  db: ReadableDatabase,
  before?: AdminQualityCandidateCursor,
): Promise<AdminQualityCandidatePage> {
  const rows = (
    await db
      .prepare(`SELECT id,manufacturer_id,observed_manufacturer,observed_model,active_listing_count,shop_count,priority_score,updated_at FROM knowledge_catalog_candidates
  WHERE review_status='pending' AND active_listing_count>0 ${before ? "AND (priority_score,updated_at,id)<(?,?,?)" : ""}
  ORDER BY priority_score DESC,updated_at DESC,id DESC LIMIT 26`)
      .bind(...(before ?? []))
      .all<{
        id: number;
        manufacturer_id: string;
        observed_manufacturer: string;
        observed_model: string;
        active_listing_count: number;
        shop_count: number;
        priority_score: number;
        updated_at: string;
      }>()
  ).results;
  const page = rows.slice(0, 25),
    last = page.at(-1);
  return {
    observedAt: new Date().toISOString(),
    items: page.map((row) => ({
      id: row.id,
      manufacturerId: row.manufacturer_id,
      manufacturer: row.observed_manufacturer,
      model: row.observed_model,
      listingCount: row.active_listing_count,
      shopCount: row.shop_count,
      priorityScore: row.priority_score,
      updatedAt: row.updated_at,
    })),
    nextBefore: rows.length > 25 && last ? [last.priority_score, last.updated_at, last.id] : null,
  };
}
