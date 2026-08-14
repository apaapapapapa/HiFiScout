import { availabilityFromSignals } from "../availability.js";
import { parseProductPage } from "../parser.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

function applyIppinkanStockPolicy(product: SellerProduct): SellerProduct {
  if (product.stockStatus !== "unknown") return product;
  // Ippinkan's listing contract is explicit: absence of a sold-out marker means available.
  return { ...product, stockStatus: availabilityFromSignals({ inStock: true }) };
}

export const ippinkanAdapter = {
  key: "ippinkan",
  name: "逸品館",
  baseUrl: "https://ippinkan.jp",
  discovery: {
    // Numbered pages are capped operationally; the listing does not prove that the configured cap
    // represents the shop's entire inventory, so absence must never deactivate a product.
    coverage: "unknown",
    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets({ maxPages }) {
      yield "https://ippinkan.jp/shopbrand/U100000/";
      for (let page = 2; page <= maxPages; page += 1) {
        yield `https://ippinkan.jp/shopbrand/U100000/page${page}/order/`;
      }
    },
  },
  parse(html, pageUrl = "https://ippinkan.jp/shopbrand/U100000/") {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
    }).map(applyIppinkanStockPolicy);
  },
} satisfies ShopAdapter<string>;
