import { parseProductPage } from "../parser.js";
import type { ShopParsedProduct } from "../../catalog/types.js";
import type { ShopAdapter } from "../types.js";

function applyIppinkanStockPolicy(product: ShopParsedProduct): ShopParsedProduct {
  if (product.stockStatus !== "unknown") return product;
  return { ...product, stockStatus: "in_stock" };
}

export const ippinkanAdapter = {
  key: "ippinkan",
  name: "逸品館",
  baseUrl: "https://ippinkan.jp",
  *pageUrls(maxPages = 1) {
    yield "https://ippinkan.jp/shopbrand/U100000/";
    for (let page = 2; page <= maxPages; page += 1) {
      yield `https://ippinkan.jp/shopbrand/U100000/page${page}/order/`;
    }
  },
  parse(html, pageUrl = "https://ippinkan.jp/shopbrand/U100000/") {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
    }).map(applyIppinkanStockPolicy);
  },
} satisfies ShopAdapter<string>;
