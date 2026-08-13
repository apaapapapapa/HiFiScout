import { catalogModelLookupVariants } from "./knowledge-catalog.js";
import {
  candidateModelVariants,
  containsFlexibleCatalogModelIdentity,
  createKnowledgeSourceVerifierV2,
  enhancedKnowledgeSourceDefinitions,
  verifyOfficialProductPageHtmlV2,
} from "./knowledge-source-verifier-v2.js";

export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 3;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

const OFFICIAL_INDEXES = Object.freeze({
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

function clean(value = "") {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function decodeHtml(value = "") {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity: string) => {
    const normalized = entity.toLowerCase();
    const namedEntities: Record<string, string> = {
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&lt;": "<",
      "&gt;": ">",
    };
    if (normalized in namedEntities) return namedEntities[normalized];

    const hexadecimal = normalized.startsWith("&#x");
    const codePoint = Number.parseInt(
      normalized.slice(hexadecimal ? 3 : 2, -1),
      hexadecimal ? 16 : 10,
    );
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function stripTags(value = "") {
  return clean(decodeHtml(String(value).replace(/<[^>]+>/g, " ")));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function lookupAliases(candidate = {}) {
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

function aliasCandidate(candidate, alias) {
  return {
    ...candidate,
    observedModel: alias,
    model: alias,
    normalizedModel: alias,
  };
}

function textMatchesAlias(text, alias) {
  return containsFlexibleCatalogModelIdentity(text, alias);
}

function blockEntries(html = "") {
  const entries = [];
  const pattern = /<(h[1-6]|tr|li|p|dt|dd|article|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const text = stripTags(match[2]);
    if (text) entries.push({ tag: match[1].toLowerCase(), text });
    if (entries.length >= 2_000) break;
  }
  return entries;
}

function contextForAlias(html, alias, categoryId = "") {
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

const CATEGORY_LABELS = Object.freeze({
  av_receiver: "AV Receiver",
  cartridge: "Cartridge",
  cd_sacd_player: "CD/SACD Player",
  earphone: "Earphones",
  network_player: "Network Audio Player",
  soundbar: "Soundbar",
  turntable: "Turntable",
});

function syntheticHtml(alias, context, categoryId = "") {
  const category = CATEGORY_LABELS[categoryId] || "";
  const value = clean([category, alias, context].filter(Boolean).join(" "));
  return `<html><head><title>${escapeHtml(value)}</title></head><body><h1>${escapeHtml(value)}</h1></body></html>`;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= maxBytes) break;
    }
    text += decoder.decode();
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => {});
  }
  return text;
}

async function fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      text: response.ok ? await readLimitedText(response, maxBytes) : "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      text: "",
      error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function directOfficialUrls(candidate, alias) {
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

function verifiedForOriginalCandidate(result, candidate) {
  if (result?.status !== "verified") return result;
  return {
    ...result,
    canonicalModel: clean(candidate.observedModel || candidate.model || candidate.normalizedModel),
    message: `${result.message || "verified"}:lookup_alias_v3`,
  };
}

export function createKnowledgeSourceVerifierV3(
  env = {},
  { fetchImpl = globalThis.fetch, fallbackEnabled = true } = {},
) {
  const definitions = enhancedKnowledgeSourceDefinitions(env);
  const pageCache = new Map();
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
      KNOWLEDGE_CATALOG_SOURCE_MAX_CATALOG_PAGES: 3,
      KNOWLEDGE_CATALOG_SOURCE_MAX_SITEMAPS: 2,
      KNOWLEDGE_CATALOG_SOURCE_MAX_PRODUCT_PAGES: 2,
      KNOWLEDGE_CATALOG_SOURCE_MAX_URLS: 3_000,
    },
    { fetchImpl },
  );

  async function cachedPage(url) {
    if (!pageCache.has(url)) {
      pageCache.set(url, fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent }));
    }
    return pageCache.get(url);
  }

  async function verifyHtmlForAlias(
    candidate,
    alias,
    html,
    sourceUrl,
    sourceType,
    httpStatus,
    categoryId = "",
  ) {
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

  async function verifyCandidate(candidate) {
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
    let bestFailure = {
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

  async function verifyStoredSource(product) {
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
