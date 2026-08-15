import {
  accumulateKnowledgeCatalogCandidateRows,
  finalizeKnowledgeCatalogCandidateAggregates,
  knowledgeCatalogKey,
} from "../catalog/knowledge-catalog.js";
import type {
  KnowledgeCatalogCandidateAccumulator,
  KnowledgeCatalogListingRow,
  ScoredKnowledgeCatalogCandidate,
} from "../catalog/types.js";
import { findVerifiedCatalogMatches } from "./knowledge-catalog-repository.js";
import type {
  KnowledgeCatalogReviewRunRow,
  KnowledgeCatalogVerificationOutcomes,
  ProductClassificationStats,
  QueryableDatabase,
} from "./types.js";

const PRODUCT_PAGE_SIZE = 500;

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

async function runBatches(
  db: QueryableDatabase,
  statements: D1PreparedStatement[],
  chunkSize = 50,
): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

async function collectActiveCandidateRows(
  db: QueryableDatabase,
): Promise<ScoredKnowledgeCatalogCandidate[]> {
  const grouped = new Map<string, KnowledgeCatalogCandidateAccumulator>();
  let lastId = 0;

  for (;;) {
    const observed = await db
      .prepare(`
      SELECT p.id, p.shop_key, p.canonical_manufacturer_id AS manufacturer_id,
             p.manufacturer, p.model, p.raw_model, p.title, p.source_url, p.category_ids,
             p.classification_status, p.first_seen_at, p.last_seen_at,
             r.status AS identity_status, r.match_method AS identity_match_method
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.is_active = 1 AND p.canonical_manufacturer_id <> '' AND p.model <> '' AND p.id > ?
      ORDER BY p.id
      LIMIT ?
    `)
      .bind(lastId, PRODUCT_PAGE_SIZE)
      .all<KnowledgeCatalogListingRow & { id: number }>();
    const rows = observed.results || [];
    if (!rows.length) break;
    accumulateKnowledgeCatalogCandidateRows(grouped, rows);
    lastId = Number(rows[rows.length - 1].id);
    if (rows.length < PRODUCT_PAGE_SIZE) break;
  }

  return finalizeKnowledgeCatalogCandidateAggregates(grouped);
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

export async function refreshKnowledgeCatalogCandidates(
  db: QueryableDatabase,
  reviewedAt: string,
): Promise<CandidateStats> {
  const candidates = await collectActiveCandidateRows(db);
  const matches = await findVerifiedCatalogMatches(
    db,
    candidates.map((candidate) => ({
      manufacturerId: candidate.manufacturerId,
      model: candidate.normalizedModel,
    })),
  );

  await db
    .prepare(`
    UPDATE knowledge_catalog_candidates
    SET active_listing_count = 0,
        shop_count = 0,
        unclassified_count = 0,
        other_count = 0,
        unresolved_identity_count = 0,
        priority_score = 0,
        last_reviewed_at = ?,
        updated_at = ?
  `)
    .bind(reviewedAt, reviewedAt)
    .run();

  const writes = candidates.map((candidate) => {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
  });
  await runBatches(db, writes);
  return knowledgeCatalogCandidateStats(db);
}

/** The finalizer runs long after dispatch; the run's own start is its remediation window. */
export async function knowledgeCatalogReviewRunStartedAt(
  db: QueryableDatabase,
  runId: number,
): Promise<string> {
  const row = await db
    .prepare("SELECT started_at FROM knowledge_catalog_review_runs WHERE id = ?")
    .bind(runId)
    .first<Pick<KnowledgeCatalogReviewRunRow, "started_at">>();
  return row?.started_at || "";
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
): Promise<void> {
  const outcomes = result.verificationOutcomes || {};
  await db
    .prepare(`
    UPDATE knowledge_catalog_review_runs
    SET finished_at = ?, status = 'success', catalog_products = ?, due_products = ?, candidates = ?,
        pending_candidates = ?, matched_candidates = ?, reclassified_products = ?,
        verification_attempts = ?, verified_promotions = ?, verified_rechecks = ?, verification_failures = ?,
        active_products_before = ?, active_products_after = ?, unclassified_before = ?, unclassified_after = ?,
        other_before = ?, other_after = ?, verification_verified = ?, verification_not_found = ?,
        verification_ambiguous = ?, verification_unsupported = ?, verification_error = ?, message = ?
    WHERE id = ?
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
    WHERE id = ?
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
