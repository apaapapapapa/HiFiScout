import { collectListingCategoryEvidence } from "../../catalog/category-evidence.js";
import type { CategoryEvidenceInput, NormalizedCatalogProduct } from "../../catalog/types.js";
import { availabilityFromSignals } from "../availability.js";
import { productDetailScope } from "../detail-product-scope.js";
import { cleanText } from "../normalize.js";
import { parseProductPage } from "../parser.js";
import { listingBlocks } from "../listing-fields.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

const LIST_URL = "https://ippinkan.jp/shopbrand/U100000/";
const PAGE_PATH_PATTERN = /^\/shopbrand\/U100000\/page\d+\/order\/?$/iu;

export const IPPINKAN_CATEGORY_POLICY = Object.freeze({
  enrichment: Object.freeze({ maxRequestsPerCrawl: 10, cacheHours: 168 }),
});

/** Only the seller's labeled category row is authoritative, not its accessory list or menus. */
export function extractIppinkanDetailCategoryEvidence(
  html: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title">> = {},
): CategoryEvidenceInput[] {
  const scope = productDetailScope(html, product, 2);
  if (!scope) return [];
  const fields = scope.matchAll(
    /<(th|td|dt)\b[^>]*>([\s\S]*?)<\/\1>\s*<(?:td|dd)\b[^>]*>([\s\S]*?)<\/(?:td|dd)>/gi,
  );
  for (const field of fields) {
    if (!/^カテゴリ(?:ー)?\s*[:：]?$/u.test(cleanText(field[2]))) continue;
    const rawCategory = cleanText(field[3]);
    return collectListingCategoryEvidence({ rawCategory })
      .evidence.filter((item) => item.source === "seller_category")
      .map((item) => ({ ...item, source: "detail_metadata", value: rawCategory }));
  }
  return [];
}

function applyIppinkanStockPolicy(product: SellerProduct): SellerProduct {
  if (product.stockStatus !== "unknown") return product;
  // Ippinkan's listing contract is explicit: absence of a sold-out marker means available.
  return { ...product, stockStatus: availabilityFromSignals({ inStock: true }) };
}

function discoverListingPages(html: string): string[] {
  const targets = new Set<string>();
  for (const match of String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/giu)) {
    try {
      const url = new URL(match[2], LIST_URL);
      if (url.origin !== "https://ippinkan.jp" || !PAGE_PATH_PATTERN.test(url.pathname)) continue;
      targets.add(`${url.origin}${url.pathname}`);
    } catch {
      continue;
    }
  }
  return [...targets];
}

export const ippinkanAdapter = {
  key: "ippinkan",
  name: "逸品館",
  baseUrl: "https://ippinkan.jp",
  discovery: {
    // Follow only pagination links the storefront actually exposes. Pre-generating every configured
    // page used to probe beyond the last page and could turn an otherwise complete crawl into a 404.
    // The bounded navigation still cannot prove that the configured page cap is the full inventory,
    // so absence must never deactivate a product.
    coverage: "unknown",
    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets() {
      yield LIST_URL;
    },
    discoverTargets(html: string) {
      return discoverListingPages(html);
    },
  },
  parse(html, pageUrl = LIST_URL) {
    const cards = listingBlocks(html, "div", "innerBox");
    return (cards.length ? cards : [html])
      .flatMap((card) =>
        parseProductPage(card, {
          shopKey: this.key,
          baseUrl: pageUrl,
          productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
        }),
      )
      .map(applyIppinkanStockPolicy);
  },
} satisfies ShopAdapter<string>;
