import type { CrawlPage, CrawlerEnv, DiscoveryContext, ShopAdapter } from "./types.js";

/** The strategies only read the discovery slice, so tests may pass synthetic adapters. */
type DiscoveryAdapter<TPage extends CrawlPage> = Pick<ShopAdapter<TPage>, "baseUrl" | "discovery">;

export interface CoverageSignals {
  reachedEnd: boolean;
  coverageIncomplete: boolean;
  queueEmpty: boolean;
}

export interface CoverageDecision {
  deactivateMissing: boolean;
  guardItemCount: boolean;
}

export function pageUrl(page: CrawlPage): string {
  return typeof page === "string" ? page : page.url;
}

/**
 * Resolve and validate a target before it reaches transport. Discovery may use relative targets,
 * but it cannot leave the shop's configured https origin.
 */
export function targetUrl<TPage extends CrawlPage>(
  adapter: Pick<ShopAdapter<TPage>, "baseUrl">,
  page: TPage,
): string {
  const raw = pageUrl(page);
  let parsed: URL;
  try {
    parsed = new URL(raw, adapter.baseUrl);
  } catch {
    throw new Error(`invalid crawl target URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== adapter.baseUrl) {
    throw new Error(`crawl target outside shop origin ${adapter.baseUrl}: ${parsed.toString()}`);
  }
  return parsed.toString();
}

export function initialPageQueue<TPage extends CrawlPage>(
  adapter: DiscoveryAdapter<TPage>,
  maxPages = 1,
  env: CrawlerEnv = {},
  context: Omit<DiscoveryContext, "maxPages" | "env"> = {},
): TPage[] {
  const allowance = Math.max(0, adapter.discovery.extraPageAllowance || 0);
  const limit = Math.max(1, maxPages) + allowance;
  const discoveryContext: DiscoveryContext = { maxPages, env, ...context };
  const pages: TPage[] = [];
  const seen = new Set<string>();

  for (const page of adapter.discovery.initialTargets(discoveryContext)) {
    const url = targetUrl(adapter, page);
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(page);
    if (pages.length >= limit) break;
  }
  return pages;
}

export function discoverPages<TPage extends CrawlPage>(
  adapter: DiscoveryAdapter<TPage>,
  html: string,
  page: TPage,
): readonly TPage[] | null {
  if (!adapter.discovery.discoverTargets) return [];
  return adapter.discovery.discoverTargets(html, page);
}

export function shouldContinueAfterEmpty(adapter: DiscoveryAdapter<CrawlPage>): boolean {
  return adapter.discovery.continueOnEmpty === true;
}

export function coverageDecision(
  adapter: DiscoveryAdapter<CrawlPage>,
  { reachedEnd, coverageIncomplete, queueEmpty }: CoverageSignals,
): CoverageDecision {
  const deactivateMissing =
    adapter.discovery.coverage === "complete" && !coverageIncomplete && (reachedEnd || queueEmpty);
  return {
    deactivateMissing,
    guardItemCount: deactivateMissing || adapter.discovery.guardItemCount === true,
  };
}
