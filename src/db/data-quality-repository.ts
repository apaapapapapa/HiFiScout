import { evaluateQuality } from "../data-quality/quality-evaluator.js";
import type { QualityThresholdOverrides } from "../data-quality/quality-thresholds.js";
import type {
  DataQualityRunRow,
  DataQualitySnapshotAggregateRow,
  QualityCounts,
  QualityEvaluation,
  QualityMetric,
  QualityMetricTrend,
  QualityMetricTrends,
  QualityRunMetrics,
  QualitySnapshotMetrics,
  QualityStatus,
  QualityTrendMetricKey,
  QueryableDatabase,
} from "./types.js";

const MODEL_OPTIONAL_CATEGORIES = [
  "cable",
  "rack",
  "power_accessory",
  "vacuum_tube",
  "other_accessory",
  "other",
];
const MODEL_OPTIONAL_SQL = MODEL_OPTIONAL_CATEGORIES.map((category) => `'${category}'`).join(",");
const STATUS_RANK: Readonly<Record<QualityStatus, number>> = {
  unknown: 0,
  healthy: 1,
  warning: 2,
  critical: 3,
};

interface SaveDataQualityRunOptions {
  shopKey: string;
  crawlRunId?: number | null;
  evaluatedAt?: string;
  run?: Partial<QualityCounts>;
  thresholdOverrides?: QualityThresholdOverrides;
}

interface StoredQualityEvaluation {
  id: number;
  shop: string;
  crawlRunId: number | null;
  evaluatedAt: string;
  status: QualityStatus;
  snapshot: { status: QualityStatus; metrics: QualitySnapshotMetrics };
  latestRun: { status: QualityStatus; metrics: QualityRunMetrics };
  metrics: QualitySnapshotMetrics & QualityRunMetrics;
  details: Record<string, number>;
}

function number(value: unknown): number {
  return Number(value || 0);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export async function readDataQualitySnapshot(
  db: QueryableDatabase,
  shopKey: string,
): Promise<
  Pick<
    QualityCounts,
    | "totalItems"
    | "manufacturerMissingCount"
    | "manufacturerUnresolvedCount"
    | "categoryUnclassifiedCount"
    | "otherCategoryCount"
    | "identityMatchedCount"
    | "identityUnresolvedCount"
    | "identityVetoCount"
    | "identityCandidateCount"
    | "inventoryKnownCount"
    | "inventoryUnknownCount"
    | "modelExpectedCount"
    | "modelExtractedCount"
    | "modelMissingCount"
  >
> {
  const row = await db
    .prepare(`
      SELECT
        COUNT(*) AS total_items,
        SUM(CASE
          WHEN COALESCE(p.raw_manufacturer, '') = ''
           AND p.manufacturer_resolution_status <> 'resolved'
          THEN 1 ELSE 0 END) AS manufacturer_missing_count,
        SUM(CASE
          WHEN COALESCE(p.raw_manufacturer, '') <> ''
           AND p.manufacturer_resolution_status <> 'resolved'
          THEN 1 ELSE 0 END) AS manufacturer_unresolved_count,
        SUM(CASE WHEN p.classification_status <> 'classified' THEN 1 ELSE 0 END) AS category_unclassified_count,
        SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id = 'other' THEN 1 ELSE 0 END) AS other_category_count,
        SUM(CASE WHEN r.status = 'matched' THEN 1 ELSE 0 END) AS identity_matched_count,
        SUM(CASE WHEN r.status = 'unresolved' THEN 1 ELSE 0 END) AS identity_unresolved_count,
        SUM(CASE WHEN r.match_method = 'vetoed' THEN 1 ELSE 0 END) AS identity_veto_count,
        SUM(CASE WHEN r.status = 'unresolved' AND r.candidate_catalog_product_id IS NOT NULL THEN 1 ELSE 0 END) AS identity_candidate_count,
        SUM(CASE WHEN p.stock_status <> 'unknown' THEN 1 ELSE 0 END) AS inventory_known_count,
        SUM(CASE WHEN p.stock_status = 'unknown' THEN 1 ELSE 0 END) AS inventory_unknown_count,
        SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN (${MODEL_OPTIONAL_SQL}) THEN 1 ELSE 0 END) AS model_expected_count,
        SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN (${MODEL_OPTIONAL_SQL}) AND p.model_resolution_status = 'resolved' THEN 1 ELSE 0 END) AS model_extracted_count,
        SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN (${MODEL_OPTIONAL_SQL}) AND p.model_resolution_status <> 'resolved' THEN 1 ELSE 0 END) AS model_missing_count
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.shop_key = ? AND p.is_active = 1
    `)
    .bind(shopKey)
    .first<DataQualitySnapshotAggregateRow>();

  return {
    totalItems: number(row?.total_items),
    manufacturerMissingCount: number(row?.manufacturer_missing_count),
    manufacturerUnresolvedCount: number(row?.manufacturer_unresolved_count),
    categoryUnclassifiedCount: number(row?.category_unclassified_count),
    otherCategoryCount: number(row?.other_category_count),
    identityMatchedCount: number(row?.identity_matched_count),
    identityUnresolvedCount: number(row?.identity_unresolved_count),
    identityVetoCount: number(row?.identity_veto_count),
    identityCandidateCount: number(row?.identity_candidate_count),
    inventoryKnownCount: number(row?.inventory_known_count),
    inventoryUnknownCount: number(row?.inventory_unknown_count),
    modelExpectedCount: number(row?.model_expected_count),
    modelExtractedCount: number(row?.model_extracted_count),
    modelMissingCount: number(row?.model_missing_count),
  };
}

function statusColumns(evaluation: QualityEvaluation): QualityStatus[] {
  const metrics = evaluation.metrics;
  return [
    metrics.manufacturerUnknown.status,
    metrics.categoryUnclassified.status,
    metrics.identityUnresolved.status,
    metrics.inventoryUnknown.status,
    metrics.modelMissing.status,
    metrics.parserFailure.status,
    metrics.itemCount.status,
    metrics.evidenceCoverage.status,
    evaluation.snapshot.status,
    evaluation.run.status,
    evaluation.status,
  ];
}

export async function saveDataQualityRun(
  db: QueryableDatabase,
  {
    shopKey,
    crawlRunId = null,
    evaluatedAt = new Date().toISOString(),
    run = {},
    thresholdOverrides = {},
  }: SaveDataQualityRunOptions,
): Promise<QualityEvaluation & { evaluatedAt: string; crawlRunId: number | null }> {
  const snapshot = await readDataQualitySnapshot(db, shopKey);
  // A caller outside a crawl (the remediation sweep) has no crawl-time item count to pass; default
  // it to the snapshot's own active-listing total instead of falling through to zero, which would
  // otherwise read as the shop's inventory having emptied out.
  const evaluation = evaluateQuality(
    { shopKey, ...snapshot, currentItemCount: snapshot.totalItems, ...run },
    { thresholdOverrides },
  );
  const c = evaluation.counts;
  const statuses = statusColumns(evaluation);

  await db
    .prepare(`
      INSERT INTO data_quality_runs(
        shop_key, crawl_run_id, evaluated_at, total_items,
        manufacturer_missing_count, manufacturer_unresolved_count,
        category_unclassified_count, other_category_count,
        identity_matched_count, identity_unresolved_count, identity_veto_count, identity_candidate_count,
        inventory_known_count, inventory_unknown_count,
        model_expected_count, model_extracted_count, model_missing_count,
        parse_attempt_count, parse_success_count, parse_failure_count,
        evidence_expected_event_count, evidence_archived_event_count, evidence_archive_failure_count,
        previous_item_count, current_item_count, item_count_absolute_difference, item_count_change_rate,
        manufacturer_status, category_status, identity_status, inventory_status, model_status,
        parser_status, item_count_status, evidence_status, snapshot_status, run_status, quality_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(crawl_run_id) WHERE crawl_run_id IS NOT NULL DO UPDATE SET
        evaluated_at = excluded.evaluated_at,
        total_items = excluded.total_items,
        manufacturer_missing_count = excluded.manufacturer_missing_count,
        manufacturer_unresolved_count = excluded.manufacturer_unresolved_count,
        category_unclassified_count = excluded.category_unclassified_count,
        other_category_count = excluded.other_category_count,
        identity_matched_count = excluded.identity_matched_count,
        identity_unresolved_count = excluded.identity_unresolved_count,
        identity_veto_count = excluded.identity_veto_count,
        identity_candidate_count = excluded.identity_candidate_count,
        inventory_known_count = excluded.inventory_known_count,
        inventory_unknown_count = excluded.inventory_unknown_count,
        model_expected_count = excluded.model_expected_count,
        model_extracted_count = excluded.model_extracted_count,
        model_missing_count = excluded.model_missing_count,
        parse_attempt_count = excluded.parse_attempt_count,
        parse_success_count = excluded.parse_success_count,
        parse_failure_count = excluded.parse_failure_count,
        evidence_expected_event_count = excluded.evidence_expected_event_count,
        evidence_archived_event_count = excluded.evidence_archived_event_count,
        evidence_archive_failure_count = excluded.evidence_archive_failure_count,
        previous_item_count = excluded.previous_item_count,
        current_item_count = excluded.current_item_count,
        item_count_absolute_difference = excluded.item_count_absolute_difference,
        item_count_change_rate = excluded.item_count_change_rate,
        manufacturer_status = excluded.manufacturer_status,
        category_status = excluded.category_status,
        identity_status = excluded.identity_status,
        inventory_status = excluded.inventory_status,
        model_status = excluded.model_status,
        parser_status = excluded.parser_status,
        item_count_status = excluded.item_count_status,
        evidence_status = excluded.evidence_status,
        snapshot_status = excluded.snapshot_status,
        run_status = excluded.run_status,
        quality_status = excluded.quality_status
    `)
    .bind(
      shopKey,
      crawlRunId,
      evaluatedAt,
      c.totalItems,
      c.manufacturerMissingCount,
      c.manufacturerUnresolvedCount,
      c.categoryUnclassifiedCount,
      c.otherCategoryCount,
      c.identityMatchedCount,
      c.identityUnresolvedCount,
      c.identityVetoCount,
      c.identityCandidateCount,
      c.inventoryKnownCount,
      c.inventoryUnknownCount,
      c.modelExpectedCount,
      c.modelExtractedCount,
      c.modelMissingCount,
      c.parseAttemptCount,
      c.parseSuccessCount,
      c.parseFailureCount,
      c.evidenceExpectedEventCount,
      c.evidenceArchivedEventCount,
      c.evidenceArchiveFailureCount,
      c.previousItemCount,
      c.currentItemCount,
      c.itemCountAbsoluteDifference,
      c.itemCountChangeRate,
      ...statuses,
    )
    .run();
  return { ...evaluation, evaluatedAt, crawlRunId };
}

function rowMetric(count: unknown, denominator: unknown, status: QualityStatus): QualityMetric {
  const c = number(count);
  const d = number(denominator);
  return { count: c, denominator: d, rate: d ? c / d : null, status };
}

export function dataQualityRow(row: DataQualityRunRow): StoredQualityEvaluation {
  const totalItems = number(row.total_items);
  const identityMatched = number(row.identity_matched_count);
  const identityUnresolved = number(row.identity_unresolved_count);
  const identityResolutionMissing = Math.max(0, totalItems - identityMatched - identityUnresolved);
  const identityUnresolvedForQuality = identityUnresolved + identityResolutionMissing;
  const inventoryTotal = number(row.inventory_known_count) + number(row.inventory_unknown_count);
  const manufacturerUnknown =
    number(row.manufacturer_missing_count) + number(row.manufacturer_unresolved_count);
  const snapshotMetrics = {
    manufacturerUnknown: rowMetric(manufacturerUnknown, row.total_items, row.manufacturer_status),
    categoryUnclassified: rowMetric(
      row.category_unclassified_count,
      row.total_items,
      row.category_status,
    ),
    identityUnresolved: rowMetric(
      identityUnresolvedForQuality,
      row.total_items,
      row.identity_status,
    ),
    inventoryUnknown: rowMetric(row.inventory_unknown_count, inventoryTotal, row.inventory_status),
    modelMissing: rowMetric(row.model_missing_count, row.model_expected_count, row.model_status),
  };
  const runMetrics = {
    parserFailure: rowMetric(row.parse_failure_count, row.parse_attempt_count, row.parser_status),
    evidenceCoverage: rowMetric(
      row.evidence_archived_event_count,
      row.evidence_expected_event_count,
      row.evidence_status,
    ),
    itemCount: {
      previous: nullableNumber(row.previous_item_count),
      current: number(row.current_item_count),
      absoluteDifference: nullableNumber(row.item_count_absolute_difference),
      changeRate: nullableNumber(row.item_count_change_rate),
      status: row.item_count_status,
    },
  };
  return {
    id: number(row.id),
    shop: row.shop_key,
    crawlRunId: nullableNumber(row.crawl_run_id),
    evaluatedAt: row.evaluated_at,
    status: row.quality_status,
    snapshot: { status: row.snapshot_status, metrics: snapshotMetrics },
    latestRun: { status: row.run_status, metrics: runMetrics },
    metrics: { ...snapshotMetrics, ...runMetrics },
    details: {
      manufacturerMissingCount: number(row.manufacturer_missing_count),
      manufacturerUnresolvedCount: number(row.manufacturer_unresolved_count),
      otherCategoryCount: number(row.other_category_count),
      identityMatchedCount: identityMatched,
      identityResolutionMissingCount: identityResolutionMissing,
      identityVetoCount: number(row.identity_veto_count),
      identityCandidateCount: number(row.identity_candidate_count),
      modelExtractedCount: number(row.model_extracted_count),
      evidenceArchiveFailureCount: number(row.evidence_archive_failure_count),
    },
  };
}

const TREND_METRIC_KEYS: readonly QualityTrendMetricKey[] = [
  "manufacturerUnknown",
  "categoryUnclassified",
  "identityUnresolved",
  "inventoryUnknown",
  "modelMissing",
  "parserFailure",
  "evidenceCoverage",
];

function metricTrend(current: QualityMetric, previous: QualityMetric | null): QualityMetricTrend {
  const previousRate = previous ? previous.rate : null;
  const absoluteDelta =
    current.rate == null || previousRate == null ? null : current.rate - previousRate;
  const percentageDelta =
    absoluteDelta == null || !previousRate ? null : absoluteDelta / previousRate;
  return {
    previousRate,
    previousStatus: previous ? previous.status : null,
    absoluteDelta,
    percentageDelta,
  };
}

function buildQualityTrend(
  current: StoredQualityEvaluation,
  previous: StoredQualityEvaluation | null,
): QualityMetricTrends {
  const trend = {} as Record<QualityTrendMetricKey, QualityMetricTrend>;
  for (const key of TREND_METRIC_KEYS) {
    trend[key] = metricTrend(current.metrics[key], previous ? previous.metrics[key] : null);
  }
  return trend;
}

/**
 * Latest snapshot per shop, plus a snapshot-over-snapshot trend against the run immediately before
 * it. One windowed query keeps this a single bounded read across every shop rather than the N+1 a
 * per-shop "and also fetch the previous row" lookup would otherwise require.
 */
export async function latestDataQualityByShop(
  db: QueryableDatabase,
): Promise<Array<StoredQualityEvaluation & { trend: QualityMetricTrends }>> {
  const result = await db
    .prepare(`
      WITH ranked AS (
        SELECT q.*, ROW_NUMBER() OVER (
          PARTITION BY q.shop_key ORDER BY q.evaluated_at DESC, q.id DESC
        ) AS rn
        FROM data_quality_runs q
      )
      SELECT * FROM ranked WHERE rn <= 2 ORDER BY shop_key, rn
    `)
    .all<DataQualityRunRow>();
  const byShop = new Map<string, DataQualityRunRow[]>();
  for (const row of result.results || []) {
    const rows = byShop.get(row.shop_key) || [];
    rows.push(row);
    byShop.set(row.shop_key, rows);
  }
  return [...byShop.values()].map(([currentRow, previousRow]) => {
    const current = dataQualityRow(currentRow);
    const previous = previousRow ? dataQualityRow(previousRow) : null;
    return { ...current, trend: buildQualityTrend(current, previous) };
  });
}

export async function listDataQualityHistory(
  db: QueryableDatabase,
  shopKey: string,
  limit = 50,
): Promise<StoredQualityEvaluation[]> {
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await db
    .prepare(`
      SELECT * FROM data_quality_runs
      WHERE shop_key = ?
      ORDER BY evaluated_at DESC, id DESC
      LIMIT ?
    `)
    .bind(shopKey, boundedLimit)
    .all<DataQualityRunRow>();
  return (result.results || []).map((row) => dataQualityRow(row));
}

export async function dataQualityStatus(db: QueryableDatabase): Promise<{
  status: QualityStatus;
  shops: Array<StoredQualityEvaluation & { trend: QualityMetricTrends }>;
  checkedAt: string;
}> {
  const shops = await latestDataQualityByShop(db);
  const known = shops.filter((shop) => shop.status !== "unknown");
  const status = known.length
    ? known.reduce<QualityStatus>(
        (worst, shop) => (STATUS_RANK[shop.status] > STATUS_RANK[worst] ? shop.status : worst),
        "healthy",
      )
    : "unknown";
  return { status, shops, checkedAt: new Date().toISOString() };
}

interface IdentityMethodDistributionRow {
  shop_key: string;
  match_method: string | null;
  listing_count: number;
}

export interface IdentityMethodDistributionEntry {
  shopKey: string;
  matchMethod: string;
  listingCount: number;
}

/**
 * How active listings are distributed across `product_identity_resolutions.match_method`, per shop.
 * A listing with no resolution row is grouped as `missing_resolution` rather than disappearing, the
 * same convention the snapshot metrics use for identity coverage gaps.
 */
export async function identityResolutionMethodDistribution(
  db: QueryableDatabase,
): Promise<IdentityMethodDistributionEntry[]> {
  const result = await db
    .prepare(`
      SELECT p.shop_key,
             COALESCE(r.match_method, 'missing_resolution') AS match_method,
             COUNT(*) AS listing_count
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.shop_key, COALESCE(r.match_method, 'missing_resolution')
      ORDER BY p.shop_key, listing_count DESC, match_method
    `)
    .all<IdentityMethodDistributionRow>();
  return (result.results || []).map((row) => ({
    shopKey: row.shop_key,
    matchMethod: row.match_method || "missing_resolution",
    listingCount: number(row.listing_count),
  }));
}

export { MODEL_OPTIONAL_CATEGORIES };
