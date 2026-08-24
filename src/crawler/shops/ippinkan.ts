import { availabilityFromSignals } from "../availability.js";
import { parseProductPage } from "../parser.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

const LIST_URL = "https://ippinkan.jp/shopbrand/U100000/";
const PAGE_PATH_PATTERN = /^\/shopbrand\/U100000\/page\d+\/order\/?$/iu;

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
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
    }).map(applyIppinkanStockPolicy);
  },
} satisfies ShopAdapter<string>;
