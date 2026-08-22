import {
  classifyCategoryEvidence,
  summarizeCategoryEvidence,
} from "../catalog/category-classifier.js";
import { collectListingCategoryEvidence } from "../catalog/category-evidence.js";
import { createManufacturerResolver } from "../catalog/manufacturer-resolver.js";
import { createModelResolver } from "../catalog/model-resolver.js";
import { inferFeatureFacts } from "../catalog/product-features.js";
import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { CategoryEvidenceInput, FeatureFact } from "../catalog/types.js";
import { errorMessage, isRecord } from "../types.js";
import { saveDataQualityRun } from "./data-quality-repository.js";
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
  remediation_projection_token: string;
}

interface StoredFeatureFactRow {
  feature_id: string;
  state: string;
  source: string;
  confidence: number;
}

interface PreparedRemediationJob {
  job: DataQualityRemediationJob;
  row: RemediationListingRow;
  projectionToken: string;
}

export interface RemediationProjectionWork {
  listingProductId: number;
  sourceId: string;
  projectionToken: string;
}

export type ListingProjectionRefresher = typeof refreshListingProjections;

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

function featureKey(
  fact: Pick<FeatureFact, "featureId" | "state" | "source" | "confidence">,
): string {
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
             remediation_projection_required, remediation_projection_token
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

/**
 * Recompute derived fields and return the projection token that this worker owns. If the product
 * row is already current, ownership stays with the token observed when the row was loaded.
 */
async function replayDerivedListing(
  db: QueryableDatabase,
  row: RemediationListingRow,
  aliases: Awaited<ReturnType<typeof listManufacturerAliasEvidence>>,
  evaluatedAt: string,
): Promise<string> {
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
  // Derive the persisted list exactly like the crawl path does. `unresolved()` returns an empty
  // `categoryIds` as an in-memory contract — `category-enricher.ts` and `page-verification.ts`
  // read it as "not classified" — but a persisted row always carries one leaf, because
  // `catalogFields()` recomputes `[primaryCategoryId]` in `product-write-repository.ts` and
  // `unclassified-persistence.test.ts` pins that. Storing the classifier's empty array here gave
  // unclassified rows two DB shapes depending on which writer touched them last.
  const categoryIdsJson = JSON.stringify(
    classification.categoryIds.length
      ? classification.categoryIds
      : [classification.primaryCategoryId],
  );
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

  await syncTitleFeatureFacts(db, row, evaluatedAt);
  return Number(result?.meta?.changes || 0) > 0 ? token : row.remediation_projection_token;
}

/**
 * Clear only the dirty marker this worker observed/created. A newer crawl or replay may replace the
 * token while projections are refreshing; in that case its dirty marker must survive for the next
 * refresh instead of being erased by an older worker.
 */
export async function clearProjectionPendingForToken(
  db: QueryableDatabase,
  listingProductId: number,
  projectionToken: string,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE products
      SET remediation_projection_required = 0,
          remediation_projection_token = ''
      WHERE id = ?
        AND remediation_projection_required = 1
        AND remediation_projection_token = ?
    `)
    .bind(listingProductId, projectionToken)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function prepareJob(
  db: QueryableDatabase,
  job: DataQualityRemediationJob,
  aliases: Awaited<ReturnType<typeof listManufacturerAliasEvidence>>,
  evaluatedAt: string,
): Promise<PreparedRemediationJob | null> {
  if (!job.listingProductId) return null;
  const row = await loadListing(db, job.listingProductId);
  if (!row) return null;

  let projectionToken = row.remediation_projection_token;
  if (requiresDerivedReplay(job.workType)) {
    projectionToken = await replayDerivedListing(db, row, aliases, evaluatedAt);
  }
  return { job, row, projectionToken };
}

/**
 * Refresh one shop's downstream read models in a single bounded call instead of once per queue job.
 * The repository functions already chunk source ids internally, so batching preserves their D1
 * safety limits while avoiding repeated catalog/search reads over the remote binding.
 */
export async function refreshRemediationShopProjections(
  db: QueryableDatabase,
  shopKey: string,
  work: readonly RemediationProjectionWork[],
  evaluatedAt: string,
  refreshProjections: ListingProjectionRefresher = refreshListingProjections,
): Promise<void> {
  if (!work.length) return;
  await refreshProjections(
    db,
    work.map((item) => ({ shop_key: shopKey, source_id: item.sourceId })),
    evaluatedAt,
  );
  for (const item of work) {
    await clearProjectionPendingForToken(db, item.listingProductId, item.projectionToken);
  }
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
  const successfulJobsByShop = new Map<string, PreparedRemediationJob[]>();
  let resolved = 0;
  let failed = 0;
  let retried = 0;

  for (const job of jobs) {
    try {
      const prepared = await prepareJob(db, job, aliases, evaluatedAt);
      if (!prepared) {
        await resolveDataQualityRemediationJob(db, job.id, evaluatedAt);
        resolved += 1;
        continue;
      }
      const shopKey = prepared.row.shop_key;
      affectedShops.add(shopKey);
      const shopJobs = successfulJobsByShop.get(shopKey) || [];
      shopJobs.push(prepared);
      successfulJobsByShop.set(shopKey, shopJobs);
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

  for (const [shopKey, preparedJobs] of successfulJobsByShop) {
    const shopJobs = preparedJobs.map((prepared) => prepared.job);
    try {
      await refreshRemediationShopProjections(
        db,
        shopKey,
        preparedJobs.map((prepared) => ({
          listingProductId: prepared.row.id,
          sourceId: prepared.row.source_id,
          projectionToken: prepared.projectionToken,
        })),
        evaluatedAt,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "data_quality_remediation_projection_batch_failed",
          shopKey,
          jobCount: shopJobs.length,
          message: errorMessage(error),
        }),
      );
      for (const job of shopJobs) {
        const status = await retryOrFailDataQualityRemediationJob(db, job.id, error, {
          updatedAt: evaluatedAt,
        });
        if (status === "failed") failed += 1;
        else retried += 1;
      }
      continue;
    }

    // Snapshot persistence is part of durable job completion. Keep successfully replayed jobs in
    // `processing` until their shop's post-remediation snapshot is safely stored; otherwise a
    // transient D1 failure could mark the only retryable work resolved and lose the DQ refresh.
    try {
      const saved = await saveDataQualityRun(db, { shopKey, crawlRunId: null, evaluatedAt });
      console.log(
        JSON.stringify({
          event: "data_quality_remediation_snapshot",
          shopKey,
          status: saved.snapshot.status,
          metrics: saved.snapshot.metrics,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "data_quality_remediation_snapshot_failed",
          shopKey,
          jobCount: shopJobs.length,
          message: errorMessage(error),
        }),
      );
      for (const job of shopJobs) {
        const status = await retryOrFailDataQualityRemediationJob(db, job.id, error, {
          updatedAt: evaluatedAt,
        });
        if (status === "failed") failed += 1;
        else retried += 1;
      }
      continue;
    }

    for (const job of shopJobs) {
      try {
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
            event: "data_quality_remediation_job_finalize_failed",
            jobId: job.id,
            shopKey,
            status,
            message: errorMessage(error),
          }),
        );
      }
    }
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
