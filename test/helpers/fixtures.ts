import type { CatalogNormalizationInput } from "../../src/catalog/types.js";
import type { FetchHtmlPageOptions } from "../../src/crawler/types.js";
import type { ReadableDatabase, ShopSyncStateRow } from "../../src/db/types.js";
import { asQueryableDatabase } from "./d1.js";

/**
 * Fills the fields every shop adapter is contractually required to emit, so tests can keep
 * stating only what they exercise while `normalizeCatalogProduct` keeps its strict input type.
 * Optional keys are deliberately not defaulted: adapters omit several of them and tests assert
 * the exact key set of a parsed product, so absent must stay absent.
 */
export function parsedProduct(
  overrides: Partial<CatalogNormalizationInput> & Pick<CatalogNormalizationInput, "title">,
): CatalogNormalizationInput {
  return {
    sourceId: "",
    manufacturer: "",
    model: "",
    conditionText: "",
    priceYen: null,
    stockStatus: "unknown",
    sourceUrl: "",
    ...overrides,
  };
}

/** A crawl-state row with every column present, as `listShopStates()` returns it. */
export function shopSyncStateRow(
  overrides: Partial<ShopSyncStateRow> & Pick<ShopSyncStateRow, "shop_key">,
): ShopSyncStateRow {
  return {
    last_attempt_at: null,
    last_success_at: null,
    last_error_at: null,
    consecutive_failures: 0,
    backoff_until: null,
    last_error: null,
    last_item_count: 0,
    queued_at: null,
    ...overrides,
  };
}

/**
 * A read-only D1 stand-in whose knowledge catalog is empty, so catalog lookups find no match.
 * Every query answers with zero rows rather than being absent, which is what an empty
 * deployment actually looks like to the enricher.
 */
export function emptyCatalogDb(): ReadableDatabase {
  return asQueryableDatabase({
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  });
}

/** The detail-fetch options the crawler passes in production, for tests that never fetch. */
export function detailFetchOptions(
  overrides: Partial<FetchHtmlPageOptions> = {},
): FetchHtmlPageOptions {
  return {
    baseUrl: "https://example.test",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 0,
    ...overrides,
  };
}
