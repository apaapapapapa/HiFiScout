import { categoryEvidenceFromText } from "../../catalog/category-evidence.js";
import { cleanText } from "../normalize.js";
import { parseProductPage } from "../parser.js";

const PAGE_SIZE = 50;
const NEW_ARRIVALS_PATH = "ea-usednw_ssd";
const OUTLET_PATH = "c31_dP";
const FEED_NEW_ARRIVALS = "new-arrivals";
const FEED_OUTLET = "outlet";

function newArrivalsPageUrl(page = 1) {
  if (page === 1)
    return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function outletPageUrl(page = 1) {
  if (page === 1) return `https://www.fujiya-avic.co.jp/shop/c/c31/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/c/${OUTLET_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function pageFor(feed, page = 1) {
  return {
    url: feed === FEED_OUTLET ? outletPageUrl(page) : newArrivalsPageUrl(page),
    page,
    feed,
  };
}

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] || "";
}

function metaDescriptions(html) {
  const descriptions = [];
  for (const match of String(html || "").matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = (attribute(attrs, "name") || attribute(attrs, "property")).toLowerCase();
    if (!["description", "og:description", "twitter:description"].includes(name)) continue;
    const content = cleanText(attribute(attrs, "content"));
    if (content) descriptions.push(content);
  }
  return [...new Set(descriptions)];
}

function firstExplicitDetailEvidence(text, source) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const sentences = normalized
    .split(/[。！？!?]+/)
    .map(cleanText)
    .filter(Boolean);
  for (const sentence of sentences) {
    const evidence = categoryEvidenceFromText(sentence, {
      source,
      strength: "strong",
      context: "detail",
    });
    if (evidence.length) return evidence;
  }
  return [];
}

function productLeadText(html, product = {}) {
  const visible = cleanText(
    String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " "),
  );
  const needle = cleanText(product.model || product.title || "");
  if (!needle) return visible.slice(0, 1200);
  const index = visible.toLowerCase().indexOf(needle.toLowerCase());
  return visible.slice(index >= 0 ? index : 0, (index >= 0 ? index : 0) + 1200);
}

export function extractFujiyaDetailCategoryEvidence(html, product = {}) {
  // Prefer product-specific metadata. Never scan the entire detail page: related-product
  // copy can mention a different component (for example an amplifier page mentioning
  // a matching SACD player) and would otherwise create false category evidence.
  for (const description of metaDescriptions(html)) {
    const evidence = firstExplicitDetailEvidence(description, "detail_metadata");
    if (evidence.length) return evidence;
  }

  return firstExplicitDetailEvidence(productLeadText(html, product), "detail_product_text");
}

export function parseFujiyaResultCount(html) {
  const text = cleanText(html);
  const match = text.match(/(?:検索結果|該当件数)\s*([0-9,，]+)\s*件|([0-9,，]+)\s*件あります/);
  const raw = match?.[1] || match?.[2];
  return raw ? Number.parseInt(raw.replace(/[，,]/g, ""), 10) : null;
}

export const fujiyaAvicAdapter = {
  key: "fujiya-avic",
  name: "フジヤエービック",
  baseUrl: "https://www.fujiya-avic.co.jp",
  // Fujiya is intentionally collected from two bounded feeds: newest used arrivals and
  // the dedicated outlet category. This excludes the broader outlet-and-stock-sale feed.
  // Neither feed is the shop's complete inventory, so missing products must never be
  // treated as sold merely because they disappear here.
  partialCoverage: true,
  categoryPolicy: Object.freeze({
    sellerCategory: Object.freeze({
      default: "authoritative",
      categories: Object.freeze({
        // These merchandising buckets are known to contain heterogeneous products.
        dap: "corroborative",
        headphone_amp: "corroborative",
      }),
    }),
    parserHint: "corroborative",
    enrichment: Object.freeze({
      maxRequestsPerCrawl: 20,
      cacheHours: 168,
    }),
  }),
  extractDetailCategoryEvidence: extractFujiyaDetailCategoryEvidence,
  dynamicPagination: true,
  continueOnEmpty: true,
  *pageUrls() {
    yield pageFor(FEED_NEW_ARRIVALS);
    yield pageFor(FEED_OUTLET);
  },
  discoverPageUrls(html, page) {
    if (page.page !== 1) return [];
    const count = parseFujiyaResultCount(html);
    if (count == null) return null;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    return Array.from({ length: totalPages - 1 }, (_, index) => pageFor(page.feed, index + 2));
  },
  parse(html, page) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i,
      priceContext: "forward",
      ...(page.feed === FEED_OUTLET ? { fixedConditionText: "アウトレット" } : {}),
    });
  },
};