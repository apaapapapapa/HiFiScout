import { classifyCategoryEvidence, summarizeCategoryEvidence } from "../catalog/category-classifier.js";
import { collectListingCategoryEvidence } from "../catalog/category-evidence.js";
import { createManufacturerResolver } from "../catalog/manufacturer-resolver.js";
import { createModelResolver } from "../catalog/model-resolver.js";
import { inferFeatureFacts } from "../catalog/product-features.js";
import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { CategoryEvidenceInput, FeatureFact } from "../catalog/types.js";
import { evaluateQuality } from "../data-quality/quality-evaluator.js";
import { errorMessage, isRecord } from "../types.js";
import { readDataQualitySnapshot } from "./data-quality-repository.js";
import {
  claimDataQualityRemediationBatch,
  dataQualityRemediationQueueMetrics,
  resolveDataQualityRemediationJob,
  retryOrFailDataQualityRemediationJob,
  seedDataQualityRemediationQueue,
  type DataQualityRemediationJob,
  type DataQualityRemediationWorkType,
} from "./data-quality-remediation-queue-repository.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { listManufacturerAliasEvidence } from "./manufacturer-repository.js";
import type { QueryableDatabase } from "./types.js";

interface RemediationListingRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer: string;
  raw_manufacturer: string;
  normalized_raw_manufacturer: string;
  manufacturer_id: string;
  canonical_manufacturer_id: string;
  manufacturer_resolution_status: string;
  manufacturer_resolution_method: string;
  manufacturer_resolution_confidence: string;
  manufacturer_resolver_version: number;
  model: string;
  raw_model: string;
  normalized_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  model_resolver_version: number;
  title: string;
  category: string;
  raw_category: string;
  primary_category_id: string;
  category_ids: string;
  classification_status: string;
  search_aliases: string;
  metadata_json: string;
  remediation_projection_required: number;
}

interface StoredFeatureFactRow {
  feature_id: string;
  state: string;
  source: string;
  confidence: number;
}

export interface RunDataQualityRemediationSweepOptions {
  seedLimit?: number;
  claimLimit?: number;
  leaseSeconds?: number;
  now?: Date;
}

export interface RunDataQualityRemediationSweepResult {
  seeded: number;
  claimed: number;
  resolved: number;
  failed: number;
  retried: number;
  affectedShops: string[];
  queue: Awaited<ReturnType<typeof dataQualityRemediationQueueMetrics>>;
}

function metadataObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function classificationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return isRecord(metadata.categoryClassification) ? metadata.categoryClassification : {};
}

function storedCategoryEvidence(
  row: RemediationListingRow,
  metadata: Record<string, unknown>,
): CategoryEvidenceInput[] {
  const stored = classificationMetadata(metadata).evidence;
  if (Array.isArray(stored)) {
    const evidence = stored.filter(
      (entry): entry is CategoryEvidenceInput =>
        isRecord(entry) &&
        Array.isArray(entry.categoryIds) &&
        typeof entry.source === "string" &&
        typeof entry.strength === "string",
    );
    if (evidence.length) return evidence;
  }
  return collectListingCategoryEvidence({
    title: row.title,
    rawCategory: row.raw_category,
    hintedCategory: row.category,
  }).evidence;
}

function featureKey(fact: Pick<FeatureFact, "featureId" | "state" | "source" | "confidence">): string {
  return `${fact.featureId}:${fact.state}:${fact.source}:${Number(fact.confidence)}`;
}

async function syncTitleFeatureFacts(
  db: QueryableDatabase,
  row: RemediationListingRow,
  evaluatedAt: string,
): Promise<boolean> {
  const next = inferFeatureFacts(row.title, {
    source: "title",
    confidence: 0.8,
    verifiedAt: evaluatedAt,
  });
  const currentResult = await db
    .prepare(`
      SELECT feature_id, state, source, confidence
      FROM product_feature_facts
      WHERE product_id = ? AND source = 'title'
      ORDER BY feature_id, state
    `)
    .bind(row.id)
    .all<StoredFeatureFactRow>();
  const currentKeys = (currentResult.results || [])
    .map((fact) => `${fact.feature_id}:${fact.state}:${fact.source}:${Number(fact.confidence)}`)
    .sort();
  const nextKeys = next.map(featureKey).sort();
  if (JSON.stringify(currentKeys) === JSON.stringify(nextKeys)) return false;

  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM product_feature_facts WHERE product_id = ? AND source = 'title'")
      .bind(row.id),
  ];
  for (const fact of next) {
    statements.push(
      db
        .prepare(`
          INSERT INTO product_feature_facts(
            product_id, feature_id, state, source, confidence, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(
          row.id,
          fact.featureId,
          fact.state,
          fact.source,
          fact.confidence,
          fact.verifiedAt || evaluatedAt,
        ),
    );
  }
  await db.batch(statements);
  return true;
}

async function loadListing(
  db: QueryableDatabase,
  listingProductId: number,
): Promise<RemediationListingRow | null> {
  return db
    .prepare(`
      SELECT id, shop_key, source_id,
             manufacturer, raw_manufacturer, normalized_raw_manufacturer,
             manufacturer_id, canonical_manufacturer_id,
             manufacturer_resolution_status, manufacturer_resolution_method,
             manufacturer_resolution_confidence, manufacturer_resolver_version,
             model, raw_model, normalized_model, model_resolution_status,
             model_resolution_method, model_resolution_confidence, model_resolver_version,
             title, category, raw_category, primary_category_id, category_ids,
             classification_status, search_aliases, metadata_json,
             remediation_projection_required
      FROM products
      WHERE id = ?
    `)
    .bind(listingProductId)
    .first<RemediationListingRow>();
}

function requiresDerivedReplay(workType: DataQualityRemediationWorkType): boolean {
  return (
    workType === "resolve_manufacturer" ||
    workType === "resolve_model" ||
    workType === "classify_category" ||
    workType === "reprocess_listing"
  );
}

async function replayDerivedListing(
  db: QueryableDatabase,
  row: RemediationListingRow,
  aliases: Awaited<ReturnType<typeof listManufacturerAliasEvidence>>,
  evaluatedAt: string,
): Promise<boolean> {
  const manufacturerResolver = createManufacturerResolver(aliases);
  const modelResolver = createModelResolver(aliases);
  const manufacturer = manufacturerResolver({
    rawManufacturer: row.raw_manufacturer,
    manufacturerCandidate: row.raw_manufacturer ? row.manufacturer : "",
    title: row.title,
  });
  const model = modelResolver({
    rawModel: row.raw_model,
    title: row.title,
    manufacturerId: manufacturer.canonicalManufacturerId,
  });

  const metadata = metadataObject(row.metadata_json);
  const evidence = storedCategoryEvidence(row, metadata);
  const classification = classifyCategoryEvidence(evidence);
  const nextMetadata = {
    ...metadata,
    manufacturerNormalization: {
      version: RESOLUTION_VERSIONS.manufacturer,
      matchedAlias: manufacturer.matchedAlias,
      status: manufacturer.status,
      method: manufacturer.method,
      confidence: manufacturer.confidence,
      normalizedRawManufacturer: manufacturer.normalizedRawManufacturer,
      candidateManufacturerIds: manufacturer.candidateManufacturerIds,
    },
    modelNormalization: {
      version: RESOLUTION_VERSIONS.model,
      status: model.status,
      method: model.method,
      confidence: model.confidence,
      normalizedModel: model.normalizedModel,
      removedAnnotations: model.removedAnnotations,
      unclassifiedTokens: model.unclassifiedTokens,
    },
    categoryClassification: {
      ...classificationMetadata(metadata),
      version: RESOLUTION_VERSIONS.category,
      state: classification.classificationState,
      status: classification.classificationStatus,
      reason: classification.classificationReason,
      source: classification.classificationSource,
      categoryIds: classification.categoryIds,
      candidateCategoryIds: classification.candidateCategoryIds,
      evidence: summarizeCategoryEvidence(evidence),
    },
  };
  const metadataJson = JSON.stringify(nextMetadata);
  const categoryIdsJson = JSON.stringify(classification.categoryIds);
  const token = `dq-replay:${evaluatedAt}:${row.id}`;

  const result = await db
    .prepare(`
      UPDATE products
      SET manufacturer = ?,
          normalized_raw_manufacturer = ?,
          manufacturer_id = ?,
          canonical_manufacturer_id = ?,
          manufacturer_resolution_status = ?,
          manufacturer_resolution_method = ?,
          manufacturer_resolution_confidence = ?,
          manufacturer_resolver_version = ?,
          model = ?,
          normalized_model = ?,
          model_resolution_status = ?,
          model_resolution_method = ?,
          model_resolution_confidence = ?,
          model_resolver_version = ?,
          category = ?,
          primary_category_id = ?,
          category_ids = ?,
          classification_status = ?,
          search_aliases = ?,
          metadata_json = ?,
          remediation_projection_required = 1,
          remediation_projection_token = ?
      WHERE id = ?
        AND (
          manufacturer IS NOT ?
          OR normalized_raw_manufacturer IS NOT ?
          OR manufacturer_id IS NOT ?
          OR canonical_manufacturer_id IS NOT ?
          OR manufacturer_resolution_status IS NOT ?
          OR manufacturer_resolution_method IS NOT ?
          OR manufacturer_resolution_confidence IS NOT ?
          OR manufacturer_resolver_version IS NOT ?
          OR model IS NOT ?
          OR normalized_model IS NOT ?
          OR model_resolution_status IS NOT ?
          OR model_resolution_method IS NOT ?
          OR model_resolution_confidence IS NOT ?
          OR model_resolver_version IS NOT ?
          OR category IS NOT ?
          OR primary_category_id IS NOT ?
          OR category_ids IS NOT ?
          OR classification_status IS NOT ?
          OR search_aliases IS NOT ?
          OR metadata_json IS NOT ?
        )
    `)
    .bind(
      manufacturer.displayName,
      manufacturer.normalizedRawManufacturer,
      manufacturer.canonicalManufacturerId,
      manufacturer.canonicalManufacturerId,
      manufacturer.status,
      manufacturer.method,
      manufacturer.confidence,
      RESOLUTION_VERSIONS.manufacturer,
      model.model,
      model.normalizedModel,
      model.status,
      model.method,
      model.confidence,
      RESOLUTION_VERSIONS.model,
      classification.displayName,
      classification.primaryCategoryId,
      categoryIdsJson,
      classification.classificationStatus,
      classification.searchAliases,
      metadataJson,
      token,
      row.id,
      manufacturer.displayName,
      manufacturer.normalizedRawManufacturer,
      manufacturer.canonicalManufacturerId,
      manufacturer.canonicalManufacturerId,
      manufacturer.status,
      manufacturer.method,
      manufacturer.confidence,
      RESOLUTION_VERSIONS.manufacturer,
      model.model,
      model.normalizedModel,
      model.status,
      model.method,
      model.confidence,
      RESOLUTION_VERSIONS.model,
      classification.displayName,
      classification.primaryCategoryId,
      categoryIdsJson,
      classification.classificationStatus,
      classification.searchAliases,
      metadataJson,
    )
    .run();

  const featuresChanged = await syncTitleFeatureFacts(db, row, evaluatedAt);
  return Number(result?.meta?.changes || 0) > 0 || featuresChanged;
}

async function clearProjectionPending(
  db: QueryableDatabase,
  row: RemediationListingRow,
  evaluatedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE products
      SET remediation_projection_required = 0,
          remediation_projection_token = ''
      WHERE id = ? AND remediation_projection_required = 1
    `)
    .bind(row.id)
    .run();
  void evaluatedAt;
}

async function processJob(
  db: QueryableDatabase,
  job: DataQualityRemediationJob,
  aliases: Awaited<ReturnType<typeof listManufacturerAliasEvidence>>,
  evaluatedAt: string,
): Promise<string | null> {
  if (!job.listingProductId) return null;
  const row = await loadListing(db, job.listingProductId);
  if (!row) return null;

  if (requiresDerivedReplay(job.workType)) {
    await replayDerivedListing(db, row, aliases, evaluatedAt);
  }

  // One canonical downstream refresh path keeps FTS, Product Identity, and the Phase-4 entity/read
  // model in dependency order. It is intentionally run even when the derived listing is unchanged:
  // an identity-version-only replay still has work to stamp.
  await refreshListingProjections(db, [
    { shopKey: row.shop_key, sourceIds: [row.source_id] },
  ], evaluatedAt);
  await clearProjectionPending(db, row, evaluatedAt);
  return row.shop_key;
}

export async function runDataQualityRemediationSweep(
  db: QueryableDatabase,
  {
    seedLimit = 50,
    claimLimit = 10,
    leaseSeconds = 300,
    now = new Date(),
  }: RunDataQualityRemediationSweepOptions = {},
): Promise<RunDataQualityRemediationSweepResult> {
  const evaluatedAt = now.toISOString();
  const seeded = await seedDataQualityRemediationQueue(db, { limit: seedLimit, now: evaluatedAt });
  const jobs = await claimDataQualityRemediationBatch(db, {
    limit: claimLimit,
    claimedAt: evaluatedAt,
    leaseSeconds,
  });
  const aliases = jobs.some((job) => requiresDerivedReplay(job.workType))
    ? await listManufacturerAliasEvidence(db)
    : [];
  const affectedShops = new Set<string>();
  let resolved = 0;
  let failed = 0;
  let retried = 0;

  for (const job of jobs) {
    try {
      const shopKey = await processJob(db, job, aliases, evaluatedAt);
      if (shopKey) affectedShops.add(shopKey);
      await resolveDataQualityRemediationJob(db, job.id, evaluatedAt);
      resolved += 1;
    } catch (error) {
      const status = await retryOrFailDataQualityRemediationJob(db, job.id, error, {
        updatedAt: evaluatedAt,
      });
      if (status === "failed") failed += 1;
      else retried += 1;
      console.error(
        JSON.stringify({
          event: "data_quality_remediation_job_failed",
          jobId: job.id,
          workType: job.workType,
          listingProductId: job.listingProductId,
          status,
          message: errorMessage(error),
        }),
      );
    }
  }

  // Recompute the snapshot from current D1 state after replay without inventing a synthetic crawl
  // run. This keeps seller/run metrics untouched while making the post-remediation DQ state visible.
  for (const shopKey of affectedShops) {
    const snapshot = await readDataQualitySnapshot(db, shopKey);
    const quality = evaluateQuality({ shopKey, ...snapshot });
    console.log(
      JSON.stringify({
        event: "data_quality_remediation_snapshot",
        shopKey,
        status: quality.snapshot.status,
        metrics: quality.snapshot.metrics,
      }),
    );
  }

  const queue = await dataQualityRemediationQueueMetrics(db);
  const result: RunDataQualityRemediationSweepResult = {
    seeded: seeded.workKeys.length,
    claimed: jobs.length,
    resolved,
    failed,
    retried,
    affectedShops: [...affectedShops].sort(),
    queue,
  };
  console.log(JSON.stringify({ event: "data_quality_remediation_sweep", ...result }));
  return result;
}
