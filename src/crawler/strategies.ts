import type { CrawlPage, CrawlerEnv, PageUrlsContext, ShopAdapter } from "./types.js";

/** The strategies only read a slice of the adapter, so tests may pass partial objects. */
type PageQueueAdapter<TPage extends CrawlPage> = Pick<ShopAdapter<TPage>, "pageUrls">;
type PageDiscoveryAdapter<TPage extends CrawlPage> = Pick<
  ShopAdapter<TPage>,
  "dynamicPagination" | "discoverPageUrls"
>;
type CoverageAdapter = Pick<
  ShopAdapter,
  "partialCoverage" | "dynamicPagination" | "guardItemCount" | "continueOnEmpty"
>;

export interface CoverageSignals {
  reachedEnd: boolean;
  coverageIncomplete: boolean;
  queueEmpty: boolean;
}

export interface CoverageDecision {
  /**
   * Stays `boolean | undefined`: the `&&`/`||` chain short-circuits on the optional
   * `dynamicPagination` flag, so an adapter that declares neither flag yields `undefined`
   * today and the value is forwarded (and JSON-serialized) as-is.
   */
  deactivateMissing: boolean | undefined;
  guardItemCount: boolean;
}

export function pageUrl(page: CrawlPage): string {
  return typeof page === "string" ? page : page.url;
}

export function initialPageQueue<TPage extends CrawlPage>(
  adapter: PageQueueAdapter<TPage>,
  maxPages?: number,
  env?: CrawlerEnv,
  context?: PageUrlsContext,
): TPage[] {
  return [...adapter.pageUrls(maxPages, env, context)];
}

export function discoverPages<TPage extends CrawlPage>(
  adapter: PageDiscoveryAdapter<TPage>,
  html: string,
  page: TPage,
): TPage[] | null {
  if (!adapter.dynamicPagination || !adapter.discoverPageUrls) return [];
  return adapter.discoverPageUrls(html, page);
}

export function shouldContinueAfterEmpty(adapter: CoverageAdapter): boolean {
  return adapter.continueOnEmpty === true;
}

export function coverageDecision(
  adapter: CoverageAdapter,
  { reachedEnd, coverageIncomplete, queueEmpty }: CoverageSignals,
): CoverageDecision {
  const deactivateMissing =
    !adapter.partialCoverage &&
    (reachedEnd || (adapter.dynamicPagination && !coverageIncomplete && queueEmpty));
  return {
    deactivateMissing,
    guardItemCount: deactivateMissing || adapter.guardItemCount === true,
  };
}
