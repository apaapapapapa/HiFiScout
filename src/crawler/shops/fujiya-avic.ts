import { categoryEvidenceFromText } from "../../catalog/category-evidence.js";
import { cleanText } from "../normalize.js";
import { parseProductPage } from "../parser.js";
import type { CategoryEvidenceInput, NormalizedCatalogProduct } from "../../catalog/types.js";
import type { CrawlPageObject, ShopAdapter } from "../types.js";

const PAGE_SIZE = 50;
const NEW_ARRIVALS_PATH = "ea-usednw_ssd";
const OUTLET_PATH = "c31_dP";
const OUTLET_STOCK_SALE_PATH = "ea-outlet";
const FEED_NEW_ARRIVALS = "new-arrivals" as const;
const FEED_OUTLET = "outlet" as const;
const FEED_OUTLET_STOCK_SALE = "outlet-stock-sale" as const;

interface FujiyaPage extends CrawlPageObject {
  page?: number;
  feed: string;
}

function newArrivalsPageUrl(page = 1): string {
  if (page === 1)
    return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function outletPageUrl(page = 1): string {
  if (page === 1) return `https://www.fujiya-avic.co.jp/shop/c/c31/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/c/${OUTLET_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function outletStockSalePageUrl(page = 1): string {
  if (page === 1)
    return `https://www.fujiya-avic.co.jp/shop/e/${OUTLET_STOCK_SALE_PATH}/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/e/${OUTLET_STOCK_SALE_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function pageFor(feed: string, page = 1): FujiyaPage {
  let url: string;
  if (feed === FEED_OUTLET) url = outletPageUrl(page);
  else if (feed === FEED_OUTLET_STOCK_SALE) url = outletStockSalePageUrl(page);
  else url = newArrivalsPageUrl(page);
  return { url, page, feed };
}

function attribute(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] || "";
}

function metaDescriptions(html: string): string[] {
  const descriptions: string[] = [];
  for (const match of String(html || "").matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = (attribute(attrs, "name") || attribute(attrs, "property")).toLowerCase();
    if (!["description", "og:description", "twitter:description"].includes(name)) continue;
    const content = cleanText(attribute(attrs, "content"));
    if (content) descriptions.push(content);
  }
  return [...new Set(descriptions)];
}

function firstExplicitDetailEvidence(text: string, source: string): CategoryEvidenceInput[] {
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

function productLeadText(
  html: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title">> = {},
): string {
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

export function extractFujiyaDetailCategoryEvidence(
  html: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title">> = {},
): CategoryEvidenceInput[] {
  for (const description of metaDescriptions(html)) {
    const evidence = firstExplicitDetailEvidence(description, "detail_metadata");
    if (evidence.length) return evidence;
  }

  return firstExplicitDetailEvidence(productLeadText(html, product), "detail_product_text");
}

export function parseFujiyaResultCount(html: string): number | null {
  const text = cleanText(html);
  const match = text.match(/(?:検索結果|該当件数)\s*([0-9,，]+)\s*件|([0-9,，]+)\s*件あります/);
  const raw = match?.[1] || match?.[2];
  return raw ? Number.parseInt(raw.replace(/[，,]/g, ""), 10) : null;
}

export const fujiyaAvicAdapter = {
  key: "fujiya-avic",
  name: "フジヤエービック",
  baseUrl: "https://www.fujiya-avic.co.jp",
  categoryPolicy: Object.freeze({
    sellerCategory: Object.freeze({
      default: "authoritative",
      categories: Object.freeze({
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
  discovery: {
    // New arrivals and outlet feeds are intentionally bounded subsets of total inventory.
    coverage: "partial",
    continueOnEmpty: true,
    *initialTargets() {
      yield pageFor(FEED_NEW_ARRIVALS);
      yield pageFor(FEED_OUTLET);
      yield pageFor(FEED_OUTLET_STOCK_SALE);
    },
    discoverTargets(html, page) {
      if ((page.page ?? 1) !== 1) return [];
      const count = parseFujiyaResultCount(html);
      if (count == null) return null;
      const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      return Array.from({ length: totalPages - 1 }, (_, index) => pageFor(page.feed, index + 2));
    },
  },
  parse(html, page = pageFor(FEED_NEW_ARRIVALS)) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i,
      priceContext: "forward",
      ...(page.feed === FEED_OUTLET ? { fixedConditionText: "アウトレット" } : {}),
    });
  },
} satisfies ShopAdapter<FujiyaPage>;
