import { classifyCategoryEvidence } from "./category-classifier.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import { knowledgeSourceDefinitions as baseKnowledgeSourceDefinitions } from "./knowledge-source-verifier.js";
import { normalizeManufacturer } from "./manufacturers.js";
import type { CrawlerEnv } from "../crawler/types.js";
import type {
  CategoryClassification,
  CategoryEvidenceInput,
  CategoryEvidenceStrength,
  ClassifiableCategoryId,
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceDefinition,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
  KnowledgeSourceVerifierOptions,
} from "./types.js";
import { applySearchTemplate, boundedNumber } from "./knowledge-verification/config.js";
import {
  brandName,
  breadcrumbText,
  clean,
  extractSitemapLocations,
  flattenJsonLd,
  isProductNode,
  jsonLdValues,
  metaContent,
  parseTagAttributes,
  sameOriginUrl,
  sitemapUrlsFromRobots,
  stripTags,
  visibleText,
} from "./knowledge-verification/html.js";
import { fetchText, sha256Hex } from "./knowledge-verification/http.js";
import {
  candidateModelVariants,
  containsFlexibleCatalogModelIdentity,
  flexibleIdentityPattern,
  matchesCandidateText,
  normalizeIdentityText,
} from "./knowledge-verification/model-matching.js";

export { candidateModelVariants, containsFlexibleCatalogModelIdentity };

export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 2;

const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CATALOG_PAGES = 8;
const DEFAULT_MAX_SITEMAPS = 10;
const DEFAULT_MAX_DISCOVERED_URLS = 8_000;
const DEFAULT_MAX_PRODUCT_PAGES = 6;

const OFFICIAL_CATALOG_AUGMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  luxman: ["https://www.luxman.co.jp/product/"],
  accuphase: ["https://www.accuphase.com/product.html", "https://www.accuphase.com/history"],
  tad: ["https://tad-labs.com/jp/support/catalogue/"],
  esoteric: ["https://www.esoteric.jp/jp/support/discon"],
  denon: [
    "https://www.denon.com/ja-jp/category/archive-amplifiers/",
    "https://www.denon.com/ja-jp/category/archive-cd-players/",
    "https://www.denon.com/ja-jp/category/turntables/",
    "https://www.denon.com/ja-jp/category/archive-turntable-cartridges/",
  ],
  marantz: [
    "https://www.marantz.com/ja-jp/category/archive-amplifiers/",
    "https://www.marantz.com/ja-jp/category/archive-cd-players/",
    "https://www.marantz.com/ja-jp/category/archive-network-audio-players/",
  ],
  technics: ["https://jp.technics.com/products/?sort=tt"],
});

interface LinkEntry {
  url: string;
  text: string;
}

interface SourceCacheState {
  catalogEntries: LinkEntry[];
  sitemapLinks: string[] | null;
}

interface VerifyOfficialProductPageHtmlV2Options {
  candidate?: KnowledgeSourceCandidate;
  html?: string;
  sourceUrl?: string;
  sourceType?: string;
  httpStatus?: number;
}

function firstElementText(html: string, tag: string): string {
  const match = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function matchingProductNode(
  products: readonly Record<string, unknown>[],
  candidate: KnowledgeSourceCandidate,
): Record<string, unknown> | null {
  return (
    products.find((product) =>
      [product.model, product.sku, product.mpn, product.name].some(
        (value) => value && matchesCandidateText(value, candidate),
      ),
    ) || null
  );
}

function officialCategoryIds(text: unknown = ""): ClassifiableCategoryId[] {
  const value = clean(text);
  if (!value) return [];
  const ids = new Set(inferExplicitCategoryIds(value, { context: "detail" }));
  if (
    /\b(?:disc|disk)\s+player\b|\bsa-?cd\s+player\b|スーパーオーディオ\s*cd(?:\s*\/\s*cd)?\s*(?:プレーヤー|プレイヤー)/i.test(
      value,
    )
  ) {
    ids.add("cd_sacd_player");
  }
  if (/\bphono\s+(?:equalizer\s+)?amplifier\b|フォノ(?:イコライザー)?アンプ/i.test(value))
    ids.add("phono_eq");
  return [...ids];
}

function categoryEvidence(
  value: unknown,
  strength: CategoryEvidenceStrength = "verified",
): CategoryEvidenceInput | null {
  const text = clean(value);
  const categoryIds = officialCategoryIds(text);
  return categoryIds.length
    ? { categoryIds, source: "manufacturer_official", strength, value: text }
    : null;
}

function modelContextEvidence(
  text: unknown,
  candidate: KnowledgeSourceCandidate,
  strength: CategoryEvidenceStrength = "verified",
): CategoryEvidenceInput | null {
  const normalizedValue = normalizeIdentityText(text);
  if (!normalizedValue) return null;
  for (const model of candidateModelVariants(candidate)) {
    const pattern = flexibleIdentityPattern(model);
    if (!pattern) continue;
    const match = pattern.exec(normalizedValue);
    if (!match) continue;
    const modelStart = match.index + match[1].length;
    const modelEnd = match.index + match[0].length - match[2].length;
    const left = normalizedValue.slice(Math.max(0, modelStart - 96), modelStart);
    const right = normalizedValue.slice(modelEnd, Math.min(normalizedValue.length, modelEnd + 96));
    const leftEvidence = categoryEvidence(left, strength);
    if (leftEvidence) return leftEvidence;
    const rightEvidence = categoryEvidence(right, strength);
    if (rightEvidence) return rightEvidence;
  }
  return null;
}

function modelBearingBlocks(html: string, candidate: KnowledgeSourceCandidate): string[] {
  const blocks: string[] = [];
  for (const match of String(html).matchAll(/<(h[1-4]|p|li|tr|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(match[2]);
    if (text && matchesCandidateText(text, candidate)) blocks.push(text);
    if (blocks.length >= 12) break;
  }
  return blocks;
}

export async function verifyOfficialProductPageHtmlV2({
  candidate,
  html,
  sourceUrl = "",
  sourceType = "manufacturer_official",
  httpStatus = 200,
}: VerifyOfficialProductPageHtmlV2Options = {}): Promise<KnowledgeSourceVerification> {
  if (!candidate?.manufacturerId || !candidateModelVariants(candidate).length || !html) {
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
  const product = matchingProductNode(productNodes, candidate);
  const title = firstElementText(html, "title");
  const h1 = firstElementText(html, "h1");
  const pageText = visibleText(html);
  const modelMatched = [
    product?.model,
    product?.sku,
    product?.mpn,
    product?.name,
    h1,
    title,
    pageText,
  ].some((value) => value && matchesCandidateText(value, candidate));
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

  const structured = [product?.category, product?.name]
    .map((value) => categoryEvidence(value))
    .filter((value): value is CategoryEvidenceInput => value !== null);
  let classification: CategoryClassification | null = structured.length
    ? classifyCategoryEvidence(structured)
    : null;

  if (!classification || classification.classificationStatus !== "classified") {
    const localEvidence: CategoryEvidenceInput[] = [];
    for (const value of [h1, title, ...modelBearingBlocks(html, candidate)]) {
      const evidence = modelContextEvidence(value, candidate);
      if (evidence) localEvidence.push(evidence);
    }
    if (!localEvidence.length) {
      const evidence = modelContextEvidence(pageText, candidate);
      if (evidence) localEvidence.push(evidence);
    }
    if (localEvidence.length) classification = classifyCategoryEvidence(localEvidence);
  }

  if (!classification || classification.classificationStatus !== "classified") {
    const fallbackEvidence = [
      product?.description,
      metaContent(html, "description"),
      breadcrumbText(html),
    ]
      .map((value) => categoryEvidence(value, "strong"))
      .filter((value): value is CategoryEvidenceInput => value !== null);
    if (fallbackEvidence.length) classification = classifyCategoryEvidence(fallbackEvidence);
  }

  if (
    !classification ||
    classification.classificationStatus !== "classified" ||
    !classification.categoryIds.length
  ) {
    return {
      status: "ambiguous",
      sourceUrl,
      sourceType,
      httpStatus,
      message:
        classification?.classificationState === "ambiguous"
          ? "conflicting_official_category_evidence"
          : "official_page_has_no_unambiguous_category",
    };
  }

  const directModel = [product?.model, product?.sku, product?.mpn].find(
    (value) => value && matchesCandidateText(value, candidate),
  );
  const canonicalModel = clean(
    candidate.observedModel || candidate.model || directModel || candidate.normalizedModel,
  );
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
    canonicalModel,
    canonicalName,
    categoryIds: classification.categoryIds,
    primaryCategoryId: classification.primaryCategoryId,
    contentHash: await sha256Hex(html),
    message: "verified_from_official_product_page_v2",
  };
}

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
  const deduped = new Map<string, LinkEntry>();
  for (const entry of entries) {
    const existing = deduped.get(entry.url);
    if (!existing || entry.text.length > existing.text.length) deduped.set(entry.url, entry);
  }
  return [...deduped.values()];
}

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

function discoveryScore(entry: LinkEntry, candidate: KnowledgeSourceCandidate): number {
  let score = 0;
  if (matchesCandidateText(entry.text, candidate)) score += 100;
  if (urlMatchesCandidate(entry.url, candidate)) score += 80;
  if (/\/product\//i.test(entry.url)) score += 20;
  if (/archive|discon/i.test(entry.url)) score += 5;
  return score;
}

export function enhancedKnowledgeSourceDefinitions(
  env: CrawlerEnv = {},
): Map<string, KnowledgeSourceDefinition[]> {
  const definitions = baseKnowledgeSourceDefinitions(env);
  const result = new Map<string, KnowledgeSourceDefinition[]>();
  for (const [manufacturerId, sources] of definitions) {
    result.set(
      manufacturerId,
      sources.map((source: KnowledgeSourceDefinition) => {
        const catalogUrls = [
          ...new Set([
            ...(source.catalogUrls || []),
            ...(OFFICIAL_CATALOG_AUGMENTS[manufacturerId] || []),
          ]),
        ];
        return { ...source, catalogUrls };
      }),
    );
  }
  return result;
}

export function createKnowledgeSourceVerifierV2(
  env: CrawlerEnv = {},
  { fetchImpl = globalThis.fetch }: KnowledgeSourceVerifierOptions = {},
): KnowledgeSourceVerifier {
  const definitions = enhancedKnowledgeSourceDefinitions(env);
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
  const maxCatalogPages = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_CATALOG_PAGES,
    DEFAULT_MAX_CATALOG_PAGES,
    1,
    20,
  );
  const maxSitemaps = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_SITEMAPS,
    DEFAULT_MAX_SITEMAPS,
    1,
    30,
  );
  const maxDiscoveredUrls = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_URLS,
    DEFAULT_MAX_DISCOVERED_URLS,
    100,
    30_000,
  );
  const maxProductPages = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_PRODUCT_PAGES,
    DEFAULT_MAX_PRODUCT_PAGES,
    1,
    12,
  );
  const userAgent = clean(env.CRAWLER_USER_AGENT) || "HiFiScoutBot/0.1";

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
    while (queue.length && visited.size < maxCatalogPages && entries.length < maxDiscoveredUrls) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);
      const page = await fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent });
      if (!page.ok) continue;
      const pageEntries = extractHtmlLinkEntries(page.text, page.url);
      for (const entry of pageEntries) {
        if (entries.length < maxDiscoveredUrls) entries.push(entry);
        if (
          queue.length + visited.size < maxCatalogPages &&
          isLikelyCatalogIndexEntry(entry) &&
          !visited.has(entry.url)
        ) {
          queue.push(entry.url);
        }
      }
    }
    const byUrl = new Map<string, LinkEntry>();
    for (const entry of entries) {
      const existing = byUrl.get(entry.url);
      if (!existing || entry.text.length > existing.text.length) byUrl.set(entry.url, entry);
    }
    state.catalogEntries = [...byUrl.values()];
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
        if (/\.xml(?:$|\?)/i.test(url) && visited.size + queue.length < maxSitemaps * 2)
          queue.push(url);
        else if (pageUrls.length < maxDiscoveredUrls) pageUrls.push(url);
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
        if (result.ok)
          matches = extractHtmlLinkEntries(result.text, result.url).filter((entry) =>
            entryMatchesCandidate(entry, candidate),
          );
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
    ].slice(0, maxProductPages);
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
      message: "official_product_page_not_discovered_v2",
    };

    for (const source of sources) {
      const urls = await discoverProductUrls(source, candidate);
      for (const url of urls) {
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
        const result = await verifyOfficialProductPageHtmlV2({
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
    return verifyOfficialProductPageHtmlV2({
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
