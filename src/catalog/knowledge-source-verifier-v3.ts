import { catalogModelLookupVariants } from "./knowledge-catalog.js";
import {
  candidateModelVariants,
  containsFlexibleCatalogModelIdentity,
  createKnowledgeSourceVerifierV2,
  enhancedKnowledgeSourceDefinitions,
  verifyOfficialProductPageHtmlV2,
} from "./knowledge-source-verifier-v2.js";
import type { CrawlerEnv } from "../crawler/types.js";
import type {
  FailedKnowledgeSource,
  FetchTextResult,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
  KnowledgeSourceVerifierOptions,
} from "./types.js";
import { boundedNumber } from "./knowledge-verification/config.js";
import { clean, escapeHtml, stripTags } from "./knowledge-verification/html.js";
import { HTML_ACCEPT, fetchText } from "./knowledge-verification/http.js";

export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 3;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

interface OfficialIndex {
  url: string;
  sourceType?: string;
  categoryId?: string;
}

interface BlockEntry {
  tag: string;
  text: string;
}

const OFFICIAL_INDEXES: Readonly<Record<string, readonly OfficialIndex[]>> = Object.freeze({
  accuphase: [
    { url: "https://www.accuphase.com/history", sourceType: "manufacturer_archive" },
    { url: "https://www.accuphase.com/cat/index.html", sourceType: "manufacturer_official" },
  ],
  denon: [
    // AVS-3 is listed beside AV receivers but is an HDMI switcher, so these pages intentionally
    // carry no category hint. Model-local official text decides the category instead.
    { url: "https://www.denon.com/ja-jp/category/av-receivers/" },
    {
      url: "https://www.denon.com/ja-jp/category/archive-av-receivers/",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/turntables/", categoryId: "turntable" },
    {
      url: "https://www.denon.com/category/archive-turntables/",
      categoryId: "turntable",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/turntable-cartridges/", categoryId: "cartridge" },
    {
      url: "https://www.denon.com/ja-jp/category/network-audio-players/",
      categoryId: "network_player",
    },
    {
      url: "https://www.denon.com/category/archive-network-audio-players/",
      categoryId: "network_player",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/sound-bars/", categoryId: "soundbar" },
    {
      url: "https://www.denon.com/category/archive-sound-bars/",
      categoryId: "soundbar",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/cd-players/", categoryId: "cd_sacd_player" },
    {
      url: "https://www.denon.com/ja-jp/category/archive-cd-players/",
      categoryId: "cd_sacd_player",
      sourceType: "manufacturer_archive",
    },
    {
      url: "https://www.denon.com/ja-jp/category/archive-amplifiers/",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/perl/", categoryId: "earphone" },
    { url: "https://www.denon.com/ja-jp/category/all-audio-components/" },
  ],
  esoteric: [
    { url: "https://www.esoteric.jp/jp/support/discon", sourceType: "manufacturer_archive" },
    { url: "https://www.esoteric.jp/jp/support/download/", sourceType: "manufacturer_official" },
  ],
  luxman: [{ url: "https://www.luxman.co.jp/product/" }],
  yamaha: [
    {
      url: "https://jp.yamaha.com/products/contents/audio_visual/hifi_components/hifi-history/index.html",
      sourceType: "manufacturer_archive",
    },
  ],
});

function lookupAliases(candidate: KnowledgeSourceCandidate = {}): string[] {
  const variants = new Set(candidateModelVariants(candidate));
  for (const model of [candidate.observedModel, candidate.model, candidate.normalizedModel]) {
    for (const alias of catalogModelLookupVariants({
      manufacturerId: candidate.manufacturerId,
      model,
    })) {
      variants.add(alias);
    }
  }
  return [...variants]
    .filter(Boolean)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function aliasCandidate(
  candidate: KnowledgeSourceCandidate,
  alias: string,
): KnowledgeSourceCandidate {
  return {
    ...candidate,
    observedModel: alias,
    model: alias,
    normalizedModel: alias,
  };
}

function textMatchesAlias(text: unknown, alias: string): boolean {
  return containsFlexibleCatalogModelIdentity(text, alias);
}

function blockEntries(html: string = ""): BlockEntry[] {
  const entries: BlockEntry[] = [];
  const pattern = /<(h[1-6]|tr|li|p|dt|dd|article|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const text = stripTags(match[2]);
    if (text) entries.push({ tag: match[1].toLowerCase(), text });
    if (entries.length >= 2_000) break;
  }
  return entries;
}

function contextForAlias(html: string, alias: string, categoryId = ""): string {
  const entries = blockEntries(html);
  for (let index = 0; index < entries.length; index += 1) {
    if (!textMatchesAlias(entries[index].text, alias)) continue;
    let heading = "";
    for (let cursor = index - 1; cursor >= Math.max(0, index - 20); cursor -= 1) {
      if (/^h[1-6]$/.test(entries[cursor].tag)) {
        heading = entries[cursor].text;
        break;
      }
    }
    const next = entries[index + 1]?.text || "";
    const explicitCategory = categoryId ? `Category ${categoryId}` : "";
    return clean(
      [explicitCategory, heading, entries[index].text, next].filter(Boolean).join(" "),
    ).slice(0, 1400);
  }
  const pageText = stripTags(html);
  if (textMatchesAlias(pageText, alias)) {
    return clean(
      [categoryId ? `Category ${categoryId}` : "", pageText].filter(Boolean).join(" "),
    ).slice(0, 1400);
  }
  return "";
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  av_receiver: "AV Receiver",
  cartridge: "Cartridge",
  cd_sacd_player: "CD/SACD Player",
  earphone: "Earphones",
  network_player: "Network Audio Player",
  soundbar: "Soundbar",
  turntable: "Turntable",
});

function syntheticHtml(alias: string, context: string, categoryId = ""): string {
  const category = CATEGORY_LABELS[categoryId] || "";
  const value = clean([category, alias, context].filter(Boolean).join(" "));
  return `<html><head><title>${escapeHtml(value)}</title></head><body><h1>${escapeHtml(value)}</h1></body></html>`;
}

function directOfficialUrls(candidate: KnowledgeSourceCandidate, alias: string): string[] {
  const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
  const normalized = clean(alias).toLowerCase();
  if (!normalized) return [];
  if (manufacturerId === "accuphase") {
    return [`https://www.accuphase.com/model/${encodeURIComponent(normalized)}.html`];
  }
  if (manufacturerId === "luxman") {
    return [`https://www.luxman.co.jp/product/${encodeURIComponent(normalized)}/`];
  }
  if (manufacturerId === "esoteric") {
    const compact = normalized.replace(/^grandioso[-\s]*/i, "").replace(/[^a-z0-9]/g, "");
    const generic = normalized.replace(/[^a-z0-9]/g, "");
    return [
      ...new Set(
        [compact, generic]
          .filter(Boolean)
          .map((slug) => `https://www.esoteric.jp/jp/product/${slug}/top`),
      ),
    ];
  }
  return [];
}

function verifiedForOriginalCandidate(
  result: KnowledgeSourceVerification,
  candidate: KnowledgeSourceCandidate,
): KnowledgeSourceVerification {
  if (result?.status !== "verified") return result;
  return {
    ...result,
    canonicalModel: clean(candidate.observedModel || candidate.model || candidate.normalizedModel),
    message: `${result.message || "verified"}:lookup_alias_v3`,
  };
}

export function createKnowledgeSourceVerifierV3(
  env: CrawlerEnv = {},
  { fetchImpl = globalThis.fetch, fallbackEnabled = true }: KnowledgeSourceVerifierOptions = {},
): KnowledgeSourceVerifier {
  const definitions = enhancedKnowledgeSourceDefinitions(env);
  const pageCache = new Map<string, Promise<FetchTextResult>>();
  const timeoutMs = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    20_000,
  );
  const maxBytes = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    100_000,
    3_000_000,
  );
  const userAgent = clean(env.CRAWLER_USER_AGENT) || "HiFiScoutBot/0.1";
  const fallback = createKnowledgeSourceVerifierV2(
    {
      ...env,
      KNOWLEDGE_CATALOG_SOURCE_MAX_CATALOG_PAGES: "3",
      KNOWLEDGE_CATALOG_SOURCE_MAX_SITEMAPS: "2",
      KNOWLEDGE_CATALOG_SOURCE_MAX_PRODUCT_PAGES: "2",
      KNOWLEDGE_CATALOG_SOURCE_MAX_URLS: "3000",
    },
    { fetchImpl },
  );

  async function cachedPage(url: string): Promise<FetchTextResult> {
    if (!pageCache.has(url)) {
      // v3 only ever reads HTML indexes and product pages, so it keeps the narrower Accept.
      pageCache.set(
        url,
        fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent, accept: HTML_ACCEPT }),
      );
    }
    const page = pageCache.get(url);
    if (!page) throw new Error(`Failed to cache official page: ${url}`);
    return page;
  }

  async function verifyHtmlForAlias(
    candidate: KnowledgeSourceCandidate,
    alias: string,
    html: string,
    sourceUrl: string,
    sourceType: string,
    httpStatus: number,
    categoryId = "",
  ): Promise<KnowledgeSourceVerification | null> {
    const context = contextForAlias(html, alias, categoryId);
    if (!context) return null;
    const result = await verifyOfficialProductPageHtmlV2({
      candidate: aliasCandidate(candidate, alias),
      html: syntheticHtml(alias, context, categoryId),
      sourceUrl,
      sourceType,
      httpStatus,
    });
    return verifiedForOriginalCandidate(result, candidate);
  }

  async function verifyCandidate(
    candidate: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
    if (!definitions.has(manufacturerId)) {
      return {
        status: "unsupported",
        sourceType: "",
        sourceUrl: "",
        httpStatus: null,
        message: "no_official_source_adapter",
      };
    }
    const aliases = lookupAliases(candidate);
    let bestFailure: FailedKnowledgeSource = {
      status: "not_found",
      sourceType: "manufacturer_official",
      sourceUrl: "",
      httpStatus: null,
      message: "official_product_page_not_discovered_v3",
    };

    for (const index of OFFICIAL_INDEXES[manufacturerId] || []) {
      const page = await cachedPage(index.url);
      if (!page.ok) continue;
      for (const alias of aliases) {
        const result = await verifyHtmlForAlias(
          candidate,
          alias,
          page.text,
          page.url,
          index.sourceType || "manufacturer_official",
          page.status,
          index.categoryId || "",
        );
        if (!result) continue;
        if (result.status === "verified") return result;
        if (result.status === "ambiguous") bestFailure = result;
      }
    }

    for (const alias of aliases) {
      for (const url of directOfficialUrls(candidate, alias)) {
        const page = await cachedPage(url);
        if (!page.ok) continue;
        const result = await verifyOfficialProductPageHtmlV2({
          candidate: aliasCandidate(candidate, alias),
          html: page.text,
          sourceUrl: page.url,
          sourceType: "manufacturer_official",
          httpStatus: page.status,
        });
        const original = verifiedForOriginalCandidate(result, candidate);
        if (original.status === "verified") return original;
        if (original.status === "ambiguous") bestFailure = original;
      }
    }

    if (fallbackEnabled) {
      const result = await fallback.verifyCandidate(candidate);
      if (result.status === "verified") return result;
      if (result.status === "ambiguous" || bestFailure.status === "not_found") bestFailure = result;
    }
    return bestFailure;
  }

  async function verifyStoredSource(
    product: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    if (!product?.sourceUrl) return fallback.verifyStoredSource(product);
    const page = await cachedPage(product.sourceUrl);
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
