import { classifyCategoryEvidence } from "./category-classifier.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import { normalizeCatalogModel } from "./knowledge-catalog.js";
import { normalizeManufacturer } from "./manufacturers.js";
import type { CrawlerEnv } from "../crawler/types.js";
import type {
  CategoryEvidenceInput,
  CategoryEvidenceStrength,
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceDefinition,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
  KnowledgeSourceVerifierOptions,
} from "./types.js";
import {
  applySearchTemplate,
  boundedNumber,
  parseSourceRegistry,
} from "./knowledge-verification/config.js";
import {
  brandName,
  breadcrumbText,
  clean,
  extractSitemapLocations,
  flattenJsonLd,
  isProductNode,
  jsonLdValues,
  metaContent,
  sameOriginUrl,
  sitemapUrlsFromRobots,
  stripTags,
} from "./knowledge-verification/html.js";
import { fetchText, sha256Hex } from "./knowledge-verification/http.js";
import { containsCatalogModelIdentity } from "./knowledge-verification/model-matching.js";

/** Re-exported for existing callers and tests; the implementation is shared now. */
export { containsCatalogModelIdentity };

const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SITEMAPS = 6;
const DEFAULT_MAX_DISCOVERED_URLS = 5_000;
const DEFAULT_MAX_PRODUCT_PAGES = 4;

const DEFAULT_OFFICIAL_SOURCES = Object.freeze([
  {
    manufacturerId: "luxman",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.luxman.co.jp/",
    catalogUrls: ["https://www.luxman.co.jp/"],
  },
  {
    manufacturerId: "accuphase",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.accuphase.com/",
    catalogUrls: ["https://www.accuphase.com/?lang=ja"],
  },
  {
    manufacturerId: "tad",
    sourceType: "manufacturer_official",
    baseUrl: "https://tad-labs.com/jp/",
    catalogUrls: ["https://tad-labs.com/jp/"],
  },
  {
    manufacturerId: "esoteric",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.esoteric.jp/jp/",
    catalogUrls: ["https://www.esoteric.jp/jp/"],
  },
  {
    manufacturerId: "yamaha",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.yamaha.com/",
    catalogUrls: ["https://jp.yamaha.com/products/audio_visual/hifi_components/"],
  },
  {
    manufacturerId: "denon",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.denon.com/ja-jp/",
    catalogUrls: ["https://www.denon.com/ja-jp/"],
  },
  {
    manufacturerId: "marantz",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.marantz.com/ja-jp/",
    catalogUrls: ["https://www.marantz.com/ja-jp/"],
  },
  {
    manufacturerId: "technics",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.technics.com/",
    catalogUrls: ["https://jp.technics.com/"],
  },
]);

const ELEMENT_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  title: /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  h1: /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
});

interface SourceCacheState {
  catalogLinks: string[];
  sitemapLinks: string[] | null;
}

interface VerifyOfficialProductPageHtmlOptions {
  candidate?: KnowledgeSourceCandidate;
  html?: string;
  sourceUrl?: string;
  sourceType?: string;
  httpStatus?: number;
}

function urlModelKey(value: unknown = ""): string {
  let decoded = String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  return decoded
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function urlMatchesModel(url: string, model: unknown): boolean {
  try {
    const parsed = new URL(url);
    const haystack = urlModelKey(`${parsed.pathname} ${parsed.search}`);
    const needle = urlModelKey(model);
    if (!needle) return false;
    const index = haystack.indexOf(needle);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] || "";
    return !/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after);
  } catch {
    return false;
  }
}

function normalizedSource(source: Record<string, unknown> = {}): KnowledgeSourceDefinition | null {
  const manufacturerId = clean(source.manufacturerId).toLowerCase();
  const baseUrl = clean(source.baseUrl);
  if (!manufacturerId || !baseUrl || source.enabled === false) return null;

  let base;
  try {
    base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol)) return null;
  } catch {
    return null;
  }

  const catalogUrls: string[] = Array.isArray(source.catalogUrls)
    ? source.catalogUrls.filter(Boolean).map(String)
    : [base.toString()];
  const sitemapUrls: string[] = Array.isArray(source.sitemapUrls)
    ? source.sitemapUrls.filter(Boolean).map(String)
    : [];

  return {
    manufacturerId,
    adapter: "official_site",
    sourceType: clean(source.sourceType) || "manufacturer_official",
    baseUrl: base.toString(),
    catalogUrls,
    sitemapUrls,
    searchUrlTemplate: clean(source.searchUrlTemplate),
  };
}

export function knowledgeSourceDefinitions(
  env: CrawlerEnv = {},
): Map<string, KnowledgeSourceDefinition[]> {
  const byManufacturer = new Map<string, KnowledgeSourceDefinition[]>();
  for (const source of DEFAULT_OFFICIAL_SOURCES) {
    const normalized = normalizedSource({ ...source });
    if (normalized) byManufacturer.set(normalized.manufacturerId, [normalized]);
  }

  for (const raw of parseSourceRegistry(env.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON)) {
    const manufacturerId = clean(raw.manufacturerId).toLowerCase();
    if (!manufacturerId) continue;
    if (raw.enabled === false) {
      byManufacturer.delete(manufacturerId);
      continue;
    }
    const normalized = normalizedSource(raw);
    if (!normalized) continue;
    if (raw?.replace === false && byManufacturer.has(manufacturerId)) {
      byManufacturer.get(manufacturerId)?.push(normalized);
    } else {
      byManufacturer.set(manufacturerId, [normalized]);
    }
  }
  return byManufacturer;
}

function firstElementText(html: string, tag: string): string {
  const pattern = ELEMENT_PATTERNS[tag];
  if (!pattern) return "";
  const match = String(html).match(pattern);
  return match ? stripTags(match[1]) : "";
}

function directModelMatches(value: unknown, normalizedModel: string): boolean {
  return Boolean(value) && normalizeCatalogModel(value) === normalizedModel;
}

function matchingProductNode(
  products: readonly Record<string, unknown>[],
  candidate: KnowledgeSourceCandidate,
): Record<string, unknown> | null {
  const normalizedModel =
    candidate.normalizedModel || normalizeCatalogModel(candidate.observedModel || candidate.model);
  const observedModel = candidate.observedModel || candidate.model || normalizedModel;
  return (
    products.find(
      (product) =>
        [product.model, product.sku, product.mpn].some((value) =>
          directModelMatches(value, normalizedModel),
        ) || containsCatalogModelIdentity(product.name, observedModel),
    ) || null
  );
}

function categoryEvidenceForFields(
  fields: readonly unknown[],
  strength: CategoryEvidenceStrength = "verified",
): CategoryEvidenceInput[] {
  const evidence: CategoryEvidenceInput[] = [];
  for (const field of fields) {
    const value = clean(field);
    if (!value) continue;
    const categoryIds = inferExplicitCategoryIds(value, { context: "detail" });
    if (categoryIds.length) {
      evidence.push({
        categoryIds,
        source: "manufacturer_official",
        strength,
        value,
      });
    }
  }
  return evidence;
}

export async function verifyOfficialProductPageHtml({
  candidate,
  html,
  sourceUrl = "",
  sourceType = "manufacturer_official",
  httpStatus = 200,
}: VerifyOfficialProductPageHtmlOptions = {}): Promise<KnowledgeSourceVerification> {
  const normalizedModel =
    candidate?.normalizedModel ||
    normalizeCatalogModel(candidate?.observedModel || candidate?.model || "");
  const observedModel = candidate?.observedModel || candidate?.model || normalizedModel;
  if (!candidate?.manufacturerId || !normalizedModel || !html) {
    return {
      status: "not_found",
      sourceUrl,
      sourceType,
      httpStatus,
      message: "missing_candidate_or_page_content",
    };
  }

  const productNodes = jsonLdValues(html)
    .flatMap((value) => flattenJsonLd(value))
    .filter(isProductNode);
  const product = matchingProductNode(productNodes, {
    ...candidate,
    normalizedModel,
    observedModel,
  });
  const title = firstElementText(html, "title");
  const h1 = firstElementText(html, "h1");
  const description = metaContent(html, "description");
  const breadcrumb = breadcrumbText(html);
  const directModels = product ? [product.model, product.sku, product.mpn].filter(Boolean) : [];

  const modelMatched =
    directModels.some((value) => directModelMatches(value, normalizedModel)) ||
    [product?.name, h1, title].some((value) => containsCatalogModelIdentity(value, observedModel));
  if (!modelMatched) {
    return {
      status: "not_found",
      sourceUrl,
      sourceType,
      httpStatus,
      message: "official_page_does_not_confirm_model",
    };
  }

  const explicitBrand = brandName(product?.brand);
  if (explicitBrand) {
    const resolved = normalizeManufacturer(explicitBrand);
    if (resolved.id && resolved.id !== candidate.manufacturerId) {
      return {
        status: "ambiguous",
        sourceUrl,
        sourceType,
        httpStatus,
        message: `official_product_brand_mismatch:${resolved.id}`,
      };
    }
  }

  let classification = classifyCategoryEvidence(
    categoryEvidenceForFields([product?.category, product?.name, h1, title]),
  );
  if (classification.classificationStatus !== "classified") {
    if (classification.classificationState === "ambiguous") {
      return {
        status: "ambiguous",
        sourceUrl,
        sourceType,
        httpStatus,
        message: "conflicting_official_category_evidence",
      };
    }
    classification = classifyCategoryEvidence(
      categoryEvidenceForFields([product?.description, description, breadcrumb], "strong"),
    );
  }

  if (classification.classificationStatus !== "classified" || !classification.categoryIds.length) {
    return {
      status: "ambiguous",
      sourceUrl,
      sourceType,
      httpStatus,
      message: "official_page_has_no_unambiguous_category",
    };
  }

  const canonicalModel =
    directModels.find((value) => directModelMatches(value, normalizedModel)) || observedModel;
  const canonicalName = clean(
    product?.name ||
      h1 ||
      title ||
      `${candidate.observedManufacturer || candidate.manufacturerId} ${canonicalModel}`,
  );
  return {
    status: "verified",
    sourceUrl,
    sourceType,
    httpStatus,
    canonicalModel: clean(canonicalModel),
    canonicalName,
    categoryIds: classification.categoryIds,
    primaryCategoryId: classification.primaryCategoryId,
    contentHash: await sha256Hex(html),
    message: "verified_from_official_product_page",
  };
}

function extractHtmlLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  for (const match of String(html).matchAll(
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi,
  )) {
    const url = sameOriginUrl(match[1] || match[2], baseUrl);
    if (url) links.push(url);
  }
  return [...new Set(links)];
}

export function createKnowledgeSourceVerifier(
  env: CrawlerEnv = {},
  { fetchImpl = globalThis.fetch }: KnowledgeSourceVerifierOptions = {},
): KnowledgeSourceVerifier {
  const definitions = knowledgeSourceDefinitions(env);
  const sourceCache = new Map<string, SourceCacheState>();
  const timeoutMs = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    30_000,
  );
  const maxBytes = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    100_000,
    5_000_000,
  );
  const maxSitemaps = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_SITEMAPS,
    DEFAULT_MAX_SITEMAPS,
    1,
    20,
  );
  const maxDiscoveredUrls = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_URLS,
    DEFAULT_MAX_DISCOVERED_URLS,
    100,
    20_000,
  );
  const maxProductPages = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_PRODUCT_PAGES,
    DEFAULT_MAX_PRODUCT_PAGES,
    1,
    10,
  );
  const userAgent = clean(env.CRAWLER_USER_AGENT) || "HiFiScoutBot/0.1";

  async function cacheForSource(source: KnowledgeSourceDefinition): Promise<SourceCacheState> {
    const key = `${source.manufacturerId}:${source.baseUrl}`;
    const cached = sourceCache.get(key);
    if (cached) return cached;

    const state: SourceCacheState = { catalogLinks: [], sitemapLinks: null };
    const links: string[] = [];
    for (const catalogUrl of source.catalogUrls.slice(0, 4)) {
      const resolved = sameOriginUrl(catalogUrl, source.baseUrl);
      if (!resolved) continue;
      const page = await fetchText(fetchImpl, resolved, { timeoutMs, maxBytes, userAgent });
      if (page.ok) links.push(...extractHtmlLinks(page.text, page.url));
    }
    state.catalogLinks = [...new Set(links)].slice(0, maxDiscoveredUrls);
    sourceCache.set(key, state);
    return state;
  }

  async function loadSitemapLinks(
    source: KnowledgeSourceDefinition,
    state: SourceCacheState,
  ): Promise<string[]> {
    if (state.sitemapLinks) return state.sitemapLinks;

    const queue = source.sitemapUrls
      .map((url) => sameOriginUrl(url, source.baseUrl))
      .filter(Boolean);
    const robotsUrl = new URL("/robots.txt", source.baseUrl).toString();
    const robots = await fetchText(fetchImpl, robotsUrl, {
      timeoutMs,
      maxBytes: 250_000,
      userAgent,
    });
    if (robots.ok) queue.push(...sitemapUrlsFromRobots(robots.text, source.baseUrl));
    queue.push(new URL("/sitemap.xml", source.baseUrl).toString());

    const visited = new Set<string>();
    const pageUrls: string[] = [];
    while (queue.length && visited.size < maxSitemaps && pageUrls.length < maxDiscoveredUrls) {
      const sitemapUrl = queue.shift();
      if (!sitemapUrl || visited.has(sitemapUrl) || /\.gz(?:$|\?)/i.test(sitemapUrl)) continue;
      visited.add(sitemapUrl);

      const response = await fetchText(fetchImpl, sitemapUrl, { timeoutMs, maxBytes, userAgent });
      if (!response.ok) continue;

      for (const url of extractSitemapLocations(response.text, source.baseUrl)) {
        if (/\.xml(?:$|\?)/i.test(url) && visited.size + queue.length < maxSitemaps * 2) {
          queue.push(url);
        } else if (pageUrls.length < maxDiscoveredUrls) {
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
    const model = candidate.observedModel || candidate.model || candidate.normalizedModel;
    let matches = state.catalogLinks.filter((url) => urlMatchesModel(url, model));

    if (!matches.length && source.searchUrlTemplate) {
      const searchUrl = sameOriginUrl(
        applySearchTemplate(source.searchUrlTemplate, candidate),
        source.baseUrl,
      );
      if (searchUrl) {
        const result = await fetchText(fetchImpl, searchUrl, { timeoutMs, maxBytes, userAgent });
        if (result.ok) {
          matches = extractHtmlLinks(result.text, result.url).filter((url) =>
            urlMatchesModel(url, model),
          );
        }
      }
    }

    if (!matches.length) {
      const sitemapLinks = await loadSitemapLinks(source, state);
      matches = sitemapLinks.filter((url) => urlMatchesModel(url, model));
    }
    return [...new Set(matches)].slice(0, maxProductPages);
  }

  async function verifyCandidate(
    candidate: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
    const sources = definitions.get(manufacturerId) || [];
    if (!sources.length) {
      return {
        status: "unsupported",
        sourceType: "",
        sourceUrl: "",
        httpStatus: null,
        message: "no_official_source_adapter",
      };
    }

    let bestFailure: FailedKnowledgeSource = {
      status: "not_found",
      sourceType: sources[0].sourceType,
      sourceUrl: "",
      httpStatus: null,
      message: "official_product_page_not_discovered",
    };

    for (const source of sources) {
      const urls = await discoverProductUrls(source, candidate);
      for (const url of urls) {
        const page = await fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent });
        if (!page.ok) {
          bestFailure = {
            status: "error",
            sourceType: source.sourceType,
            sourceUrl: url,
            httpStatus: page.status || null,
            message: page.error || `http_${page.status}`,
          };
          continue;
        }

        const result = await verifyOfficialProductPageHtml({
          candidate,
          html: page.text,
          sourceUrl: page.url,
          sourceType: source.sourceType,
          httpStatus: page.status,
        });
        if (result.status === "verified") return result;
        if (result.status === "ambiguous" || bestFailure.status === "not_found")
          bestFailure = result;
      }
    }
    return bestFailure;
  }

  async function verifyStoredSource(
    product: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    if (!product?.sourceUrl) {
      return {
        status: "unsupported",
        sourceType: product?.sourceType || "",
        sourceUrl: "",
        httpStatus: null,
        message: "verified_product_has_no_source_url",
      };
    }

    const page = await fetchText(fetchImpl, product.sourceUrl, { timeoutMs, maxBytes, userAgent });
    if (!page.ok) {
      return {
        status: page.status === 404 || page.status === 410 ? "not_found" : "error",
        sourceType: product.sourceType || "",
        sourceUrl: product.sourceUrl,
        httpStatus: page.status || null,
        message: page.error || `http_${page.status}`,
      };
    }

    return verifyOfficialProductPageHtml({
      candidate: {
        manufacturerId: product.manufacturerId,
        observedManufacturer: product.canonicalName,
        observedModel: product.canonicalModel,
        normalizedModel: product.normalizedModel,
      },
      html: page.text,
      sourceUrl: page.url,
      sourceType: product.sourceType || "manufacturer_official",
      httpStatus: page.status,
    });
  }

  return { verifyCandidate, verifyStoredSource, definitions };
}
