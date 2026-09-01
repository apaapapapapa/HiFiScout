import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import { resolveProductCatalogFields } from "../db/model-repository.js";
import { loadStagedCrawlProducts } from "../db/crawl-fetch-page-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { enrichProductCategories } from "./category-enricher.js";
import type { CrawlerEnv, ShopPlugin } from "./types.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

/**
 * Replays the category-enrichment decision logic without performing seller HTTP and returns the
 * detail URLs it would have requested. This preserves catalog evidence, cache age, identity
 * deduplication and the shop's per-crawl detail budget exactly; only the transport side effect is
 * replaced by a recorder so the Durable Object can pace each URL with PREPARE -> Alarm -> FETCH.
 */
export async function planStagedCategoryDetailFetches(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  runId: string,
  now = new Date(),
): Promise<string[]> {
  if (!plugin.capabilities.detailCategoryEvidence) return [];

  const staged = await loadStagedCrawlProducts(env.DB, runId);
  if (!staged.length) return [];
  const products = await resolveProductCatalogFields(env.DB, staged, { shopKey: plugin.key });
  const settings = getCrawlerSettings(env);
  const requestDelayMs = getShopRequestDelayMs(env, plugin.definition, settings.requestDelayMs);
  const targets: string[] = [];

  await enrichProductCategories({
    db: env.DB,
    adapter: plugin,
    products,
    transport: {
      fetchHtmlPage: async (url: string) => {
        targets.push(url);
        // Planning must not manufacture evidence. The extractor receives an empty document and the
        // result is discarded; only the exact target selection performed above is retained.
        return "";
      },
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

  return [...new Set(targets)];
}
