import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import { resolveProductCatalogFields } from "../db/model-repository.js";
import { loadStagedCrawlProducts } from "../db/crawl-fetch-page-repository.js";
import {
  accountReads,
  dbUsageMetrics,
  sumDbUsageMetrics,
  type DbUsageMetrics,
} from "../db/read-accounting.js";
import type { QueryableDatabase } from "../db/types.js";
import { enrichProductCategories } from "./category-enricher.js";
import type { DetailEnrichmentTarget } from "./detail-enrichment-plan.js";
import type { CrawlerEnv, ShopPlugin } from "./types.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

export interface DetailPlanningDbMetrics {
  stagedRowsRead: number;
  catalogRowsRead: number;
  existingListingRowsRead: number;
  fenceRowsRead: number;
  rowsRead: number;
  rowsWritten: number;
  statementCount: number;
  returnedRows: number;
  durationMs: number;
  dbDurationMs: number;
  manufacturerAliasRowsRead: number;
  knowledgeCatalogRowsRead: number;
  manualAuthorityRowsRead: number;
}

export interface StagedCategoryDetailPlan {
  targets: string[];
  extractionTargets: DetailEnrichmentTarget[];
  stagedCount: number;
  unresolvedCount: number;
  dbUsage: DetailPlanningDbMetrics;
}

function planningDbMetrics(
  staged: DbUsageMetrics,
  manufacturerAliases: DbUsageMetrics,
  category: Awaited<ReturnType<typeof enrichProductCategories>>["dbUsage"],
  durationMs: number,
): DetailPlanningDbMetrics {
  const total = sumDbUsageMetrics(staged, manufacturerAliases, category);
  return {
    stagedRowsRead: staged.rowsRead,
    catalogRowsRead:
      manufacturerAliases.rowsRead +
      category.knowledgeCatalogRowsRead +
      category.manualAuthorityRowsRead,
    existingListingRowsRead: category.existingListingRowsRead,
    // Planning does not cross the detail idempotency fence. The paced Alarm phase reports that
    // separately, but the stable zero keeps the run/plan metric vocabulary comparable.
    fenceRowsRead: 0,
    rowsRead: total.rowsRead,
    rowsWritten: total.rowsWritten,
    statementCount: total.statementCount,
    returnedRows: total.returnedRows,
    durationMs,
    dbDurationMs: total.durationMs,
    manufacturerAliasRowsRead: manufacturerAliases.rowsRead,
    knowledgeCatalogRowsRead: category.knowledgeCatalogRowsRead,
    manualAuthorityRowsRead: category.manualAuthorityRowsRead,
  };
}

function emptyCategoryDbUsage() {
  return {
    knowledgeCatalogRowsRead: 0,
    manualAuthorityRowsRead: 0,
    existingListingRowsRead: 0,
    ...sumDbUsageMetrics(),
  };
}

/**
 * Replays the category-enrichment decision logic without performing seller HTTP and returns the
 * detail URLs it would have requested. This preserves catalog evidence, cache age, identity
 * deduplication and the shop's per-crawl detail budget exactly; only the transport side effect is
 * replaced by a recorder so the Durable Object can pace each URL with PREPARE -> Alarm -> FETCH.
 */
export async function planStagedCategoryDetailFetchesWithDbUsage(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  runId: string,
  now = new Date(),
): Promise<StagedCategoryDetailPlan> {
  const startedAt = performance.now();
  const stagedAccounting = accountReads(env.DB);
  const noPlan = (stagedCount: number, unresolvedCount: number): StagedCategoryDetailPlan => ({
    targets: [],
    extractionTargets: [],
    stagedCount,
    unresolvedCount,
    dbUsage: planningDbMetrics(
      dbUsageMetrics(stagedAccounting),
      sumDbUsageMetrics(),
      emptyCategoryDbUsage(),
      performance.now() - startedAt,
    ),
  });
  if (!plugin.capabilities.detailCategoryEvidence) return noPlan(0, 0);

  const staged = await loadStagedCrawlProducts(stagedAccounting.db, runId);
  if (!staged.length) return noPlan(0, 0);
  const manufacturerAliasAccounting = accountReads(env.DB);
  const products = await resolveProductCatalogFields(manufacturerAliasAccounting.db, staged, {
    shopKey: plugin.key,
  });
  const settings = getCrawlerSettings(env);
  const requestDelayMs = getShopRequestDelayMs(env, plugin.definition, settings.requestDelayMs);
  const extractionTargets = new Map<string, DetailEnrichmentTarget>();

  const enrichment = await enrichProductCategories({
    db: env.DB,
    adapter: plugin,
    products,
    transport: {
      fetchHtmlPage: async () => {
        throw new Error("detail planning cannot fetch seller HTML");
      },
    },
    loadDetailEvidence: async (product) => {
      extractionTargets.set(product.sourceUrl, {
        url: product.sourceUrl,
        product: { sourceId: product.sourceId, model: product.model, title: product.title },
      });
      return [];
    },
    fetchOptions: {
      baseUrl: plugin.baseUrl,
      userAgent: settings.userAgent,
      requestDelayMs,
      fetchFn: globalThis.fetch,
      robotsCache: new Map(),
    },
    now,
  });

  return {
    targets: [...extractionTargets.keys()],
    extractionTargets: [...extractionTargets.values()],
    stagedCount: staged.length,
    unresolvedCount: enrichment.unresolvedCount,
    dbUsage: planningDbMetrics(
      dbUsageMetrics(stagedAccounting),
      dbUsageMetrics(manufacturerAliasAccounting),
      enrichment.dbUsage,
      performance.now() - startedAt,
    ),
  };
}

export async function planStagedCategoryDetailFetches(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  runId: string,
  now = new Date(),
): Promise<string[]> {
  return (await planStagedCategoryDetailInputs(env, plugin, runId, now)).map(
    (target) => target.url,
  );
}

export async function planStagedCategoryDetailInputs(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  runId: string,
  now = new Date(),
): Promise<DetailEnrichmentTarget[]> {
  const plan = await planStagedCategoryDetailFetchesWithDbUsage(env, plugin, runId, now);
  console.log(
    JSON.stringify({
      event: "detail_planning_db_usage",
      runId,
      shopKey: plugin.key,
      stagedCount: plan.stagedCount,
      unresolvedCount: plan.unresolvedCount,
      detailTargetCount: plan.targets.length,
      ...plan.dbUsage,
      planningDurationMs: plan.dbUsage.durationMs,
    }),
  );
  return plan.extractionTargets;
}
