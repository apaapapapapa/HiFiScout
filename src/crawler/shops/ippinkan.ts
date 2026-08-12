import { parseProductPage } from "../parser.js";

function applyIppinkanStockPolicy(product) {
  if (product.stockStatus !== "unknown") return product;
  return { ...product, stockStatus: "in_stock" };
}

export const ippinkanAdapter = {
  key: "ippinkan",
  name: "逸品館",
  baseUrl: "https://ippinkan.jp",
  *pageUrls(maxPages) {
    yield "https://ippinkan.jp/shopbrand/U100000/";
    for (let page = 2; page <= maxPages; page += 1) {
      yield `https://ippinkan.jp/shopbrand/U100000/page${page}/order/`;
    }
  },
  parse(html, pageUrl) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
    }).map(applyIppinkanStockPolicy);
  },
};
