import {
  accumulateKnowledgeCatalogCandidateRows,
  finalizeKnowledgeCatalogCandidateAggregates,
  knowledgeCatalogKey
} from '../catalog/knowledge-catalog.js';
import { findVerifiedCatalogMatches } from './knowledge-catalog-repository.js';

const PRODUCT_PAGE_SIZE = 500;

async function runBatches(db, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

async function collectActiveCandidateRows(db) {
  const grouped = new Map();
  let lastId = 0;

  for (;;) {
    const observed = await db.prepare(`
      SELECT id, shop_key, manufacturer_id, manufacturer, model, title, category_ids,
             classification_status, first_seen_at, last_seen_at
      FROM products
      WHERE is_active = 1 AND manufacturer_id <> '' AND model <> '' AND id > ?
      ORDER BY id
      LIMIT ?
    `).bind(lastId, PRODUCT_PAGE_SIZE).all();
    const rows = observed.results || [];
    if (!rows.length) break;
    accumulateKnowledgeCatalogCandidateRows(grouped, rows);
    lastId = Number(rows[rows.length - 1].id);
    if (rows.length < PRODUCT_PAGE_SIZE) break;
  }

  return finalizeKnowledgeCatalogCandidateAggregates(grouped);
}

export async function knowledgeCatalogCandidateStats(db) {
  const counts = await db.prepare(`
    SELECT review_status, COUNT(*) AS count
    FROM knowledge_catalog_candidates
    WHERE active_listing_count > 0
    GROUP BY review_status
  `).all();
  const byStatus = Object.fromEntries((counts.results || []).map(row => [row.review_status, Number(row.count || 0)]));
  return {
    candidates: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    pendingCandidates: byStatus.pending || 0,
    matchedCandidates: byStatus.matched || 0,
    ignoredCandidates: byStatus.ignored || 0
  };
}

export async function refreshKnowledgeCatalogCandidates(db, reviewedAt) {
  const candidates = await collectActiveCandidateRows(db);
  const matches = await findVerifiedCatalogMatches(db, candidates.map(candidate => ({
    manufacturerId: candidate.manufacturerId,
    model: candidate.normalizedModel
  })));

  await db.prepare(`
    UPDATE knowledge_catalog_candidates
    SET active_listing_count = 0,
        shop_count = 0,
        unclassified_count = 0,
        priority_score = 0,
        last_reviewed_at = ?,
        updated_at = ?
  `).bind(reviewedAt, reviewedAt).run();

  const writes = candidates.map(candidate => {
    const match = matches.get(knowledgeCatalogKey(candidate.manufacturerId, candidate.normalizedModel));
    return db.prepare(`
      INSERT INTO knowledge_catalog_candidates (
        manufacturer_id, normalized_model, observed_manufacturer, observed_model, sample_title,
        candidate_category_ids, active_listing_count, shop_count, unclassified_count, priority_score,
        review_status, catalog_product_id, first_seen_at, last_seen_at, last_reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(manufacturer_id, normalized_model) DO UPDATE SET
        observed_manufacturer = excluded.observed_manufacturer,
        observed_model = excluded.observed_model,
        sample_title = excluded.sample_title,
        candidate_category_ids = excluded.candidate_category_ids,
        active_listing_count = excluded.active_listing_count,
        shop_count = excluded.shop_count,
        unclassified_count = excluded.unclassified_count,
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
    `).bind(
      candidate.manufacturerId,
      candidate.normalizedModel,
      candidate.observedManufacturer,
      candidate.observedModel,
      candidate.sampleTitle,
      JSON.stringify(candidate.categoryIds),
      candidate.listingCount,
      candidate.shopCount,
      candidate.unclassifiedCount,
      candidate.priorityScore,
      match ? 'matched' : 'pending',
      match?.id || null,
      candidate.firstSeenAt || null,
      candidate.lastSeenAt || null,
      reviewedAt,
      reviewedAt,
      reviewedAt
    );
  });
  await runBatches(db, writes);
  return knowledgeCatalogCandidateStats(db);
}

export async function markKnowledgeCatalogProductsDue(db, reviewedAt, reviewIntervalDays = 30) {
  const days = Math.max(1, Number(reviewIntervalDays) || 30);
  const threshold = new Date(new Date(reviewedAt).getTime() - days * 24 * 60 * 60_000).toISOString();
  const result = await db.prepare(`
    UPDATE knowledge_catalog_products
    SET review_status = 'due', updated_at = ?
    WHERE verification_status = 'verified'
      AND review_status <> 'due'
      AND (last_verified_at IS NULL OR last_verified_at <= ?)
  `).bind(reviewedAt, threshold).run();
  return Number(result?.meta?.changes || 0);
}

export async function knowledgeCatalogStats(db) {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE verification_status = 'verified'"),
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE verification_status = 'verified' AND review_status = 'due'")
  ]);
  return {
    catalogProducts: Number(results?.[0]?.results?.[0]?.count || 0),
    dueProducts: Number(results?.[1]?.results?.[0]?.count || 0)
  };
}

export async function startKnowledgeCatalogReviewRun(db, startedAt) {
  const run = await db.prepare(
    "INSERT INTO knowledge_catalog_review_runs(started_at, status) VALUES (?, 'running')"
  ).bind(startedAt).run();
  return run.meta.last_row_id;
}

export async function finishKnowledgeCatalogReviewRunSuccess(db, runId, result) {
  await db.prepare(`
    UPDATE knowledge_catalog_review_runs
    SET finished_at = ?, status = 'success', catalog_products = ?, due_products = ?, candidates = ?,
        pending_candidates = ?, matched_candidates = ?, reclassified_products = ?,
        verification_attempts = ?, verified_promotions = ?, verified_rechecks = ?, verification_failures = ?, message = ?
    WHERE id = ?
  `).bind(
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
    String(result.message || '').slice(0, 1000),
    runId
  ).run();
}

export async function finishKnowledgeCatalogReviewRunFailure(db, runId, finishedAt, message) {
  await db.prepare(`
    UPDATE knowledge_catalog_review_runs
    SET finished_at = ?, status = 'failed', message = ?
    WHERE id = ?
  `).bind(finishedAt, String(message || '').slice(0, 1000), runId).run();
}
