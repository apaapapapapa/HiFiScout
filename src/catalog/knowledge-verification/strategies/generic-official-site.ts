/**
 * Finds a product page on any registered official site, without per-manufacturer knowledge.
 *
 * This is the strategy that lets a manufacturer be supported by adding a registry entry instead of
 * code. It tries three routes in increasing cost: links already gathered from the configured
 * catalog pages, then the site's own search when one is configured, then the sitemap.
 *
 * Discovery is bounded everywhere — pages crawled, sitemaps read, URLs kept, product pages opened —
 * because this runs against third-party sites from a Worker and one hostile or enormous site must
 * not consume a whole verification batch.
 */

import { applySearchTemplate } from "../config.js";
import {
  clean,
  extractSitemapLocations,
  parseTagAttributes,
  sameOriginUrl,
  sitemapUrlsFromRobots,
  stripTags,
} from "../html.js";
import { fetchText } from "../http.js";
import { matchesCandidateText } from "../model-matching.js";
import { verifyOfficialProductPage } from "../page-verification.js";
import type { VerificationStrategy } from "../pipeline.js";
import type {
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceDefinition,
  KnowledgeSourceVerification,
} from "../../types.js";

interface LinkEntry {
  url: string;
  text: string;
}

interface SourceCacheState {
  catalogEntries: LinkEntry[];
  /** `null` until the sitemap has been read once for this source. */
  sitemapLinks: string[] | null;
}

/** Bytes read from `robots.txt`, which only has to yield `Sitemap:` lines. */
const ROBOTS_MAX_BYTES = 250_000;

export interface DiscoveryBudget {
  /** Catalog/index pages crawled per source. */
  maxCatalogPages: number;
  /** Sitemap documents read per source. */
  maxSitemaps: number;
  /** URLs retained from discovery. */
  maxDiscoveredUrls: number;
  /** Product pages actually fetched and verified per source. */
  maxProductPages: number;
}

export interface GenericOfficialSiteStrategyOptions {
  definitions: Map<string, KnowledgeSourceDefinition[]>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  budget: DiscoveryBudget;
}

/** Keeps `alt`/`title`/`aria-label` text, which is often where an image-only listing states a model. */
function htmlTextWithLabels(value: unknown = ""): string {
  return stripTags(
    String(value).replace(/<(?:img|input)\b([^>]*)>/gi, (_, attrs) => {
      const labels = [
        ...String(attrs).matchAll(/\b(?:alt|title|aria-label)\s*=\s*["']([^"']+)["']/gi),
      ].map((match) => match[1]);
      return labels.length ? ` ${labels.join(" ")} ` : " ";
    }),
  );
}

function extractHtmlLinkEntries(html: string, baseUrl: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  for (const match of String(html).matchAll(
    /<a\b([^>]*?)href\s*=\s*(?:"([^"]+)"|'([^']+)')([^>]*)>([\s\S]*?)<\/a>/gi,
  )) {
    const url = sameOriginUrl(match[2] || match[3], baseUrl);
    if (!url) continue;
    const attributes = parseTagAttributes(`${match[1]} ${match[4]}`);
    const text = clean(
      [htmlTextWithLabels(match[5]), attributes.get("title"), attributes.get("aria-label")]
        .filter(Boolean)
        .join(" "),
    );
    entries.push({ url, text });
  }
  return [...dedupeByLongestText(entries).values()];
}

/** The same URL can be linked from an image and from text; keep whichever carries more model text. */
function dedupeByLongestText(entries: readonly LinkEntry[]): Map<string, LinkEntry> {
  const deduped = new Map<string, LinkEntry>();
  for (const entry of entries) {
    const existing = deduped.get(entry.url);
    if (!existing || entry.text.length > existing.text.length) deduped.set(entry.url, entry);
  }
  return deduped;
}

/** Whether a link looks like another index worth crawling rather than a product page. */
function isLikelyCatalogIndexEntry(entry: LinkEntry): boolean {
  const label = clean(entry.text).toLowerCase();
  let pathname = "";
  try {
    pathname = new URL(entry.url).pathname.toLowerCase();
  } catch {}
  return (
    /(?:製品(?:一覧|情報|紹介)?|生産終了|アーカイブ|product\s*(?:archive|museum|list)?|all\s+product|discontinued|catalog)/i.test(
      label,
    ) ||
    /\/(?:products?|history|support\/discon|support\/catalogue|category\/archive[^/]*)\/?$/i.test(
      pathname,
    )
  );
}

function urlMatchesCandidate(url: string, candidate: KnowledgeSourceCandidate): boolean {
  try {
    const parsed = new URL(url);
    let decoded = `${parsed.pathname} ${parsed.search}`;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
    return matchesCandidateText(decoded, candidate);
  } catch {
    return false;
  }
}

function entryMatchesCandidate(entry: LinkEntry, candidate: KnowledgeSourceCandidate): boolean {
  return urlMatchesCandidate(entry.url, candidate) || matchesCandidateText(entry.text, candidate);
}

/** Ranks candidate links so the limited product-page budget is spent on the likeliest matches. */
function discoveryScore(entry: LinkEntry, candidate: KnowledgeSourceCandidate): number {
  let score = 0;
  if (matchesCandidateText(entry.text, candidate)) score += 100;
  if (urlMatchesCandidate(entry.url, candidate)) score += 80;
  if (/\/product\//i.test(entry.url)) score += 20;
  if (/archive|discon/i.test(entry.url)) score += 5;
  return score;
}

export function createGenericOfficialSiteStrategy({
  definitions,
  fetchImpl,
  timeoutMs,
  maxBytes,
  userAgent,
  budget,
}: GenericOfficialSiteStrategyOptions): VerificationStrategy {
  // Shared across candidates: one verifier run reviews many models from the same manufacturer, and
  // re-crawling the catalog for each would multiply requests to the same site.
  const sourceCache = new Map<string, SourceCacheState>();

  async function cacheForSource(source: KnowledgeSourceDefinition): Promise<SourceCacheState> {
    const key = `${source.manufacturerId}:${source.baseUrl}`;
    const cached = sourceCache.get(key);
    if (cached) return cached;

    const state: SourceCacheState = { catalogEntries: [], sitemapLinks: null };
    const queue = [
      ...new Set(
        (source.catalogUrls || []).map((url) => sameOriginUrl(url, source.baseUrl)).filter(Boolean),
      ),
    ];
    const visited = new Set<string>();
    const entries: LinkEntry[] = [];
    while (
      queue.length &&
      visited.size < budget.maxCatalogPages &&
      entries.length < budget.maxDiscoveredUrls
    ) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);
      const page = await fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent });
      if (!page.ok) continue;
      for (const entry of extractHtmlLinkEntries(page.text, page.url)) {
        if (entries.length < budget.maxDiscoveredUrls) entries.push(entry);
        if (
          queue.length + visited.size < budget.maxCatalogPages &&
          isLikelyCatalogIndexEntry(entry) &&
          !visited.has(entry.url)
        ) {
          queue.push(entry.url);
        }
      }
    }
    state.catalogEntries = [...dedupeByLongestText(entries).values()];
    sourceCache.set(key, state);
    return state;
  }

  async function loadSitemapLinks(
    source: KnowledgeSourceDefinition,
    state: SourceCacheState,
  ): Promise<string[]> {
    if (state.sitemapLinks) return state.sitemapLinks;
    const queue = (source.sitemapUrls || [])
      .map((url) => sameOriginUrl(url, source.baseUrl))
      .filter(Boolean);
    const robotsUrl = new URL("/robots.txt", source.baseUrl).toString();
    const robots = await fetchText(fetchImpl, robotsUrl, {
      timeoutMs,
      maxBytes: ROBOTS_MAX_BYTES,
      userAgent,
    });
    if (robots.ok) queue.push(...sitemapUrlsFromRobots(robots.text, source.baseUrl));
    queue.push(new URL("/sitemap.xml", source.baseUrl).toString());

    const visited = new Set<string>();
    const pageUrls: string[] = [];
    while (
      queue.length &&
      visited.size < budget.maxSitemaps &&
      pageUrls.length < budget.maxDiscoveredUrls
    ) {
      const sitemapUrl = queue.shift();
      // Compressed sitemaps would need inflating inside the Worker; the plain ones are enough.
      if (!sitemapUrl || visited.has(sitemapUrl) || /\.gz(?:$|\?)/i.test(sitemapUrl)) continue;
      visited.add(sitemapUrl);
      const response = await fetchText(fetchImpl, sitemapUrl, { timeoutMs, maxBytes, userAgent });
      if (!response.ok) continue;
      for (const url of extractSitemapLocations(response.text, source.baseUrl)) {
        if (/\.xml(?:$|\?)/i.test(url) && visited.size + queue.length < budget.maxSitemaps * 2) {
          queue.push(url);
        } else if (pageUrls.length < budget.maxDiscoveredUrls) {
          pageUrls.push(url);
        }
      }
    }
    state.sitemapLinks = [...new Set(pageUrls)];
    return state.sitemapLinks;
  }

  async function discoverProductUrls(
    source: KnowledgeSourceDefinition,
    candidate: KnowledgeSourceCandidate,
  ): Promise<string[]> {
    const state = await cacheForSource(source);
    let matches = state.catalogEntries.filter((entry) => entryMatchesCandidate(entry, candidate));

    if (!matches.length && source.searchUrlTemplate) {
      const searchUrl = sameOriginUrl(
        applySearchTemplate(source.searchUrlTemplate, candidate),
        source.baseUrl,
      );
      if (searchUrl) {
        const result = await fetchText(fetchImpl, searchUrl, { timeoutMs, maxBytes, userAgent });
        if (result.ok) {
          matches = extractHtmlLinkEntries(result.text, result.url).filter((entry) =>
            entryMatchesCandidate(entry, candidate),
          );
        }
      }
    }

    if (!matches.length) {
      const sitemapLinks = await loadSitemapLinks(source, state);
      matches = sitemapLinks
        .filter((url) => urlMatchesCandidate(url, candidate))
        .map((url) => ({ url, text: "" }));
    }

    return [
      ...new Map(
        matches
          .sort((left, right) => discoveryScore(right, candidate) - discoveryScore(left, candidate))
          .map((entry) => [entry.url, entry.url]),
      ).values(),
    ].slice(0, budget.maxProductPages);
  }

  return {
    name: "generic_official_site",
    // Having searched the catalog, search page and sitemap, this strategy's failure is the most
    // informative account available of why a candidate could not be verified.
    reportsUnresolvedFailure: true,
    async verify(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification | null> {
      const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
      const sources = definitions.get(manufacturerId) || [];
      if (!sources.length) return null;

      // Unlike the targeted strategies, this one reports whatever it last learned: an unreachable
      // page is more useful to an operator than the generic "not discovered" placeholder, so a
      // fetch failure replaces the running failure outright.
      let bestFailure: KnowledgeSourceVerification = {
        status: "not_found",
        sourceType: sources[0].sourceType,
        sourceUrl: "",
        httpStatus: null,
        message: "official_product_page_not_discovered_v2",
      } satisfies FailedKnowledgeSource;

      for (const source of sources) {
        for (const url of await discoverProductUrls(source, candidate)) {
          const page = await fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent });
          if (!page.ok) {
            bestFailure = {
              status: page.status === 404 || page.status === 410 ? "not_found" : "error",
              sourceType: source.sourceType,
              sourceUrl: url,
              httpStatus: page.status || null,
              message: page.error || `http_${page.status}`,
            };
            continue;
          }
          const result = await verifyOfficialProductPage({
            candidate,
            html: page.text,
            sourceUrl: page.url,
            sourceType: source.sourceType,
            httpStatus: page.status,
          });
          if (result.status === "verified") return result;
          if (result.status === "ambiguous" || bestFailure.status === "not_found") {
            bestFailure = result;
          }
        }
      }
      return bestFailure;
    },
  };
}
