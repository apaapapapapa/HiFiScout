import { knowledgeCatalogKey } from "../catalog/knowledge-catalog.js";
import type { ScoredKnowledgeCatalogCandidate } from "../catalog/types.js";
import type {
  KnowledgeCatalogReviewRunRow,
  KnowledgeCatalogVerificationOutcomes,
  ProductClassificationStats,
  QueryableDatabase,
} from "./types.js";

interface CandidateStats {
  candidates: number;
  pendingCandidates: number;
  matchedCandidates: number;
  ignoredCandidates: number;
}

interface CatalogStats {
  catalogProducts: number;
  dueProducts: number;
}

interface ReviewRunSuccessResult extends CandidateStats, CatalogStats {
  finishedAt: string;
  reclassifiedProducts: number;
  verificationAttempts: number;
  verifiedPromotions: number;
  verifiedRechecks: number;
  verificationFailures: number;
  beforeClassification: ProductClassificationStats;
  afterClassification: ProductClassificationStats;
  verificationOutcomes: KnowledgeCatalogVerificationOutcomes;
  message: string;
}

interface CandidateStatusRow {
  review_status: string;
  count: number;
}

interface ActiveClassificationRow {
  active_products: number | null;
  unclassified_products: number | null;
  other_products: number | null;
}

interface OperationalStatusRow extends Partial<KnowledgeCatalogReviewRunRow> {
  count?: number;
  verification_status?: string;
  candidates?: number;
  active_listings?: number | null;
  unclassified_listings?: number | null;
  active_products?: number | null;
  unclassified_products?: number | null;
  other_products?: number | null;
}

export async function activeProductClassificationStats(
  db: QueryableDatabase,
): Promise<ProductClassificationStats> {
  const row = await db
    .prepare(`
    SELECT COUNT(*) AS active_products,
           SUM(CASE WHEN classification_status = 'unclassified' THEN 1 ELSE 0 END) AS unclassified_products,
           SUM(CASE WHEN primary_category_id = 'other' THEN 1 ELSE 0 END) AS other_products
    FROM products
    WHERE is_active = 1
  `)
    .first<ActiveClassificationRow>();
  return {
    activeProducts: Number(row?.active_products || 0),
    unclassifiedProducts: Number(row?.unclassified_products || 0),
    otherProducts: Number(row?.other_products || 0),
  };
}

export async function knowledgeCatalogCandidateStats(
  db: QueryableDatabase,
): Promise<CandidateStats> {
  const counts = await db
    .prepare(`
    SELECT review_status, COUNT(*) AS count
    FROM knowledge_catalog_candidates
    WHERE active_listing_count > 0
    GROUP BY review_status
  `)
    .all<CandidateStatusRow>();
  const byStatus = Object.fromEntries(
    (counts.results || []).map((row) => [row.review_status, Number(row.count || 0)]),
  );
  return {
    candidates: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    pendingCandidates: byStatus.pending || 0,
    matchedCandidates: byStatus.matched || 0,
    ignoredCandidates: byStatus.ignored || 0,
  };
}

export function knowledgeCatalogCandidateWrites(
  db: QueryableDatabase,
  candidates: readonly ScoredKnowledgeCatalogCandidate[],
  matches: ReadonlyMap<string, { id: number }>,
  reviewedAt: string,
  guard: { sql: string; binds: unknown[] } = { sql: "1", binds: [] },
): D1PreparedStatement[] {
  return candidates.map((candidate) => {
    const match = matches.get(
      knowledgeCatalogKey(candidate.manufacturerId, candidate.normalizedModel),
    );
    return db
      .prepare(`
      INSERT INTO knowledge_catalog_candidates (
        manufacturer_id, normalized_model, observed_manufacturer, observed_model, sample_title,
        candidate_category_ids, raw_model_variants, evidence_source_urls, identity_rejection_reason,
        active_listing_count, shop_count, unclassified_count, other_count,
        unresolved_identity_count, priority_score,
        review_status, catalog_product_id, first_seen_at, last_seen_at, last_reviewed_at, created_at, updated_at
      )
      SELECT desired.* FROM (SELECT
        ? AS manufacturer_id,
        ? AS normalized_model,
        ? AS observed_manufacturer,
        ? AS observed_model,
        ? AS sample_title,
        ? AS candidate_category_ids,
        ? AS raw_model_variants,
        ? AS evidence_source_urls,
        ? AS identity_rejection_reason,
        ? AS active_listing_count,
        ? AS shop_count,
        ? AS unclassified_count,
        ? AS other_count,
        ? AS unresolved_identity_count,
        ? AS priority_score,
        ? AS review_status,
        ? AS catalog_product_id,
        ? AS first_seen_at,
        ? AS last_seen_at,
        ? AS last_reviewed_at,
        ? AS created_at,
        ? AS updated_at
      ) AS desired
      LEFT JOIN knowledge_catalog_candidates existing
        ON existing.manufacturer_id = desired.manufacturer_id AND existing.normalized_model = desired.normalized_model
      WHERE (${guard.sql}) AND (existing.id IS NULL OR
        existing.observed_manufacturer IS NOT desired.observed_manufacturer
        OR existing.observed_model IS NOT desired.observed_model
        OR existing.sample_title IS NOT desired.sample_title
        OR existing.candidate_category_ids IS NOT desired.candidate_category_ids
        OR existing.raw_model_variants IS NOT desired.raw_model_variants
        OR existing.evidence_source_urls IS NOT desired.evidence_source_urls
        OR existing.identity_rejection_reason IS NOT desired.identity_rejection_reason
        OR existing.active_listing_count IS NOT desired.active_listing_count
        OR existing.shop_count IS NOT desired.shop_count
        OR existing.unclassified_count IS NOT desired.unclassified_count
        OR existing.other_count IS NOT desired.other_count
        OR existing.unresolved_identity_count IS NOT desired.unresolved_identity_count
        OR existing.priority_score IS NOT desired.priority_score
        OR existing.review_status IS NOT CASE WHEN desired.catalog_product_id IS NOT NULL THEN 'matched' WHEN existing.review_status = 'ignored' THEN 'ignored' ELSE 'pending' END
        OR existing.catalog_product_id IS NOT desired.catalog_product_id
        OR existing.first_seen_at IS NOT COALESCE(existing.first_seen_at, desired.first_seen_at)
        OR existing.last_seen_at IS NOT desired.last_seen_at)
      ON CONFLICT(manufacturer_id, normalized_model) DO UPDATE SET
        observed_manufacturer = excluded.observed_manufacturer,
        observed_model = excluded.observed_model,
        sample_title = excluded.sample_title,
        candidate_category_ids = excluded.candidate_category_ids,
        raw_model_variants = excluded.raw_model_variants,
        evidence_source_urls = excluded.evidence_source_urls,
        identity_rejection_reason = excluded.identity_rejection_reason,
        active_listing_count = excluded.active_listing_count,
        shop_count = excluded.shop_count,
        unclassified_count = excluded.unclassified_count,
        other_count = excluded.other_count,
        unresolved_identity_count = excluded.unresolved_identity_count,
        priority_score = excluded.priority_score,
        review_status = CASE
          WHEN excluded.catalog_product_id IS NOT NULL THEN 'matched'
          WHEN knowledge_catalog_candidates.review_status = 'ignored' THEN 'ignored'
          ELSE 'pending'
        END,
        catalog_product_id = excluded.catalog_product_id,
        first_seen_at = COALESCE(knowledge_catalog_candidates.first_seen_at, excluded.first_seen_at),
        last_seen_at = excluded.last_seen_at,
        last_reviewed_at = excluded.last_reviewed_at,
        updated_at = excluded.updated_at
    `)
      .bind(
        candidate.manufacturerId,
        candidate.normalizedModel,
        candidate.observedManufacturer,
        candidate.observedModel,
        candidate.sampleTitle,
        JSON.stringify(candidate.categoryIds),
        JSON.stringify(candidate.rawModelVariants),
        JSON.stringify(candidate.sourceUrls),
        candidate.identityRejectionReason,
        candidate.listingCount,
        candidate.shopCount,
        candidate.unclassifiedCount,
        candidate.otherCount,
        candidate.unresolvedIdentityCount,
        candidate.priorityScore,
        match ? "matched" : "pending",
        match?.id || null,
        candidate.firstSeenAt || null,
        candidate.lastSeenAt || null,
        reviewedAt,
        reviewedAt,
        reviewedAt,
        ...guard.binds,
      );
  });
}

export async function markKnowledgeCatalogProductsDue(
  db: QueryableDatabase,
  reviewedAt: string,
  reviewIntervalDays = 30,
): Promise<number> {
  const days = Math.max(1, Number(reviewIntervalDays) || 30);
  const threshold = new Date(
    new Date(reviewedAt).getTime() - days * 24 * 60 * 60_000,
  ).toISOString();
  const result = await db
    .prepare(`
    UPDATE knowledge_catalog_products
    SET review_status = 'due', updated_at = ?
    WHERE verification_status = 'verified'
      AND review_status <> 'due'
      AND (last_verified_at IS NULL OR last_verified_at <= ?)
  `)
    .bind(reviewedAt, threshold)
    .run();
  return Number(result?.meta?.changes || 0);
}

export async function knowledgeCatalogStats(db: QueryableDatabase): Promise<CatalogStats> {
  const results = await db.batch<{ count: number }>([
    db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE verification_status = 'verified'",
    ),
    db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE verification_status = 'verified' AND review_status = 'due'",
    ),
  ]);
  return {
    catalogProducts: Number(results?.[0]?.results?.[0]?.count || 0),
    dueProducts: Number(results?.[1]?.results?.[0]?.count || 0),
  };
}

export async function startKnowledgeCatalogReviewRun(
  db: QueryableDatabase,
  startedAt: string,
): Promise<number> {
  const run = await db
    .prepare("INSERT INTO knowledge_catalog_review_runs(started_at, status) VALUES (?, 'running')")
    .bind(startedAt)
    .run();
  return run.meta.last_row_id;
}

export async function latestKnowledgeCatalogReviewRunState(
  db: QueryableDatabase,
): Promise<Pick<KnowledgeCatalogReviewRunRow, "id" | "status" | "message" | "started_at"> | null> {
  // `started_at` is what dates a run that never got as far as creating its jobs; without it such a
  // run has no timestamp of its own to age against.
  return db
    .prepare(
      "SELECT id, status, message, started_at FROM knowledge_catalog_review_runs ORDER BY id DESC LIMIT 1",
    )
    .first<Pick<KnowledgeCatalogReviewRunRow, "id" | "status" | "message" | "started_at">>();
}

export async function startKnowledgeCatalogRecoveryReviewRun(
  db: QueryableDatabase,
  failedRunId: number,
  startedAt: string,
): Promise<number | null> {
  const run = await db
    .prepare(`
      INSERT INTO knowledge_catalog_review_runs(started_at, status, message)
      SELECT ?, 'running', ?
      WHERE EXISTS (
        SELECT 1 FROM knowledge_catalog_review_runs
        WHERE id = ? AND status = 'failed'
      )
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_catalog_review_runs WHERE id > ?
        )
    `)
    .bind(startedAt, `recovery_of_run:${failedRunId}`, failedRunId, failedRunId)
    .run();
  return Number(run?.meta?.changes || 0) > 0 ? Number(run?.meta?.last_row_id || 0) : null;
}

export async function claimInitialKnowledgeCatalogReviewRun(
  db: QueryableDatabase,
  startedAt: string,
): Promise<number | null> {
  const run = await db
    .prepare(`
    INSERT INTO knowledge_catalog_review_runs(started_at, status)
    SELECT ?, 'running'
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_catalog_review_runs LIMIT 1)
  `)
    .bind(startedAt)
    .run();
  return Number(run?.meta?.changes || 0) > 0 ? Number(run?.meta?.last_row_id || 0) : null;
}

export async function claimKnowledgeCatalogCatchupReviewRun(
  db: QueryableDatabase,
  startedAt: string,
): Promise<number | null> {
  const run = await db
    .prepare(`
    INSERT INTO knowledge_catalog_review_runs(started_at, status)
    SELECT ?, 'running'
    WHERE (SELECT COUNT(*) FROM knowledge_catalog_review_runs) = 1
      AND EXISTS (
        SELECT 1
        FROM knowledge_catalog_review_runs
        WHERE status = 'success' AND verification_unsupported > 0
      )
  `)
    .bind(startedAt)
    .run();
  return Number(run?.meta?.changes || 0) > 0 ? Number(run?.meta?.last_row_id || 0) : null;
}

export async function finishKnowledgeCatalogReviewRunSuccess(
  db: QueryableDatabase,
  runId: number,
  result: ReviewRunSuccessResult,
): Promise<boolean> {
  const outcomes = result.verificationOutcomes || {};
  const update = await db
    .prepare(`
    UPDATE knowledge_catalog_review_runs
    SET finished_at = ?, status = 'success', catalog_products = ?, due_products = ?, candidates = ?,
        pending_candidates = ?, matched_candidates = ?, reclassified_products = ?,
        verification_attempts = ?, verified_promotions = ?, verified_rechecks = ?, verification_failures = ?,
        active_products_before = ?, active_products_after = ?, unclassified_before = ?, unclassified_after = ?,
        other_before = ?, other_after = ?, verification_verified = ?, verification_not_found = ?,
        verification_ambiguous = ?, verification_unsupported = ?, verification_error = ?, message = ?
    WHERE id = ? AND status = 'running'
  `)
    .bind(
      result.finishedAt,
      result.catalogProducts,
      result.dueProducts,
      result.candidates,
      result.pendingCandidates,
      result.matchedCandidates,
      result.reclassifiedProducts,
      result.verificationAttempts,
      result.verifiedPromotions,
      result.verifiedRechecks,
      result.verificationFailures,
      result.beforeClassification?.activeProducts || 0,
      result.afterClassification?.activeProducts || 0,
      result.beforeClassification?.unclassifiedProducts || 0,
      result.afterClassification?.unclassifiedProducts || 0,
      result.beforeClassification?.otherProducts || 0,
      result.afterClassification?.otherProducts || 0,
      outcomes.verified || 0,
      outcomes.notFound || 0,
      outcomes.ambiguous || 0,
      outcomes.unsupported || 0,
      outcomes.error || 0,
      String(result.message || "").slice(0, 1000),
      runId,
    )
    .run();
  return Number(update?.meta?.changes || 0) > 0;
}

export async function knowledgeCatalogReviewRunStatus(
  db: QueryableDatabase,
  runId: number,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT status FROM knowledge_catalog_review_runs WHERE id = ?")
    .bind(runId)
    .first<{ status?: string | null }>();
  return row?.status || null;
}

export async function finishKnowledgeCatalogReviewRunFailure(
  db: QueryableDatabase,
  runId: number,
  finishedAt: string,
  message: unknown,
): Promise<void> {
  await db
    .prepare(`
    UPDATE knowledge_catalog_review_runs
    SET finished_at = ?, status = 'failed', message = ?
    WHERE id = ? AND status = 'running'
  `)
    .bind(finishedAt, String(message || "").slice(0, 1000), runId)
    .run();
}

function number(value: unknown): number {
  return Number(value || 0);
}

function latestReviewFromRow(
  row: OperationalStatusRow | undefined,
): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: number(row.id),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    catalogProducts: number(row.catalog_products),
    dueProducts: number(row.due_products),
    candidates: number(row.candidates),
    pendingCandidates: number(row.pending_candidates),
    matchedCandidates: number(row.matched_candidates),
    reclassifiedProducts: number(row.reclassified_products),
    verificationAttempts: number(row.verification_attempts),
    verifiedPromotions: number(row.verified_promotions),
    verifiedRechecks: number(row.verified_rechecks),
    verificationFailures: number(row.verification_failures),
    verificationOutcomes: {
      verified: number(row.verification_verified),
      notFound: number(row.verification_not_found),
      ambiguous: number(row.verification_ambiguous),
      unsupported: number(row.verification_unsupported),
      error: number(row.verification_error),
    },
    classificationImpact: {
      activeProductsBefore: number(row.active_products_before),
      activeProductsAfter: number(row.active_products_after),
      unclassifiedBefore: number(row.unclassified_before),
      unclassifiedAfter: number(row.unclassified_after),
      unclassifiedReduced: Math.max(
        0,
        number(row.unclassified_before) - number(row.unclassified_after),
      ),
      otherBefore: number(row.other_before),
      otherAfter: number(row.other_after),
      otherReduced: Math.max(0, number(row.other_before) - number(row.other_after)),
    },
    message: row.message || "",
  };
}

export async function knowledgeCatalogOperationalStatus(
  db: QueryableDatabase,
): Promise<Record<string, unknown>> {
  const results = await db.batch<OperationalStatusRow>([
    db.prepare("SELECT * FROM knowledge_catalog_review_runs ORDER BY id DESC LIMIT 1"),
    db.prepare(`
      SELECT verification_status, COUNT(*) AS candidates,
             SUM(active_listing_count) AS active_listings,
             SUM(unclassified_count) AS unclassified_listings
      FROM knowledge_catalog_candidates
      WHERE active_listing_count > 0
      GROUP BY verification_status
      ORDER BY verification_status
    `),
    db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE verification_status = 'verified'",
    ),
    db.prepare(`
      SELECT COUNT(*) AS active_products,
             SUM(CASE WHEN classification_status = 'unclassified' THEN 1 ELSE 0 END) AS unclassified_products,
             SUM(CASE WHEN primary_category_id = 'other' THEN 1 ELSE 0 END) AS other_products
      FROM products
      WHERE is_active = 1
    `),
  ]);
  const current = results?.[3]?.results?.[0] || {};
  return {
    latestReview: latestReviewFromRow(results?.[0]?.results?.[0]),
    current: {
      catalogProducts: number(results?.[2]?.results?.[0]?.count),
      activeProducts: number(current.active_products),
      unclassifiedProducts: number(current.unclassified_products),
      otherProducts: number(current.other_products),
      candidateVerification: (results?.[1]?.results || []).map((row) => ({
        status: row.verification_status,
        candidates: number(row.candidates),
        activeListings: number(row.active_listings),
        unclassifiedListings: number(row.unclassified_listings),
      })),
    },
  };
}
