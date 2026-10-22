/**
 * Fujiya-Avic's inventory-recheck knowledge: which URLs may be re-fetched and how its detail pages
 * express availability.
 *
 * Only the product lead (the heading that names the stored listing, up to the next heading) is
 * read, so related-product carousels and shared navigation can never decide availability. A sold
 * product page says `在庫がありません`; an available one offers its cart button.
 */

import { stripRawTextElements } from "../../html/raw-text.js";
import { availabilityFromSignals } from "../availability.js";
import { productDetailScope } from "../detail-product-scope.js";
import { cleanText } from "../normalize.js";
import type {
  InventoryClassification,
  InventoryRecheckListing,
  InventoryRecheckPolicy,
} from "../types.js";

const DETAIL_PATH = /^\/shop\/g\/g[0-9A-Za-z-]{1,40}\/$/;

/** Only exact `https://www.fujiya-avic.co.jp/shop/g/g<code>/` URLs are re-fetched. */
export function isFujiyaAvicDetailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.fujiya-avic.co.jp" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      DETAIL_PATH.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** The visible text of a fragment, with button/input labels kept as words. */
function visibleText(html: string): string {
  return cleanText(
    html.replace(
      /<input\b([^>]*)>/gi,
      (_match, attrs: string) => ` ${attrs.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2] ?? ""} `,
    ),
  );
}

export function classifyFujiyaAvicInventoryPage(
  html: string,
  listing?: Pick<InventoryRecheckListing, "title" | "model">,
): InventoryClassification {
  // Without the stored identity the product lead cannot be told apart from a related product.
  if (!listing) return "unknown";
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const lead = productDetailScope(source, { title: listing.title, model: listing.model });
  if (lead === null) return "unknown";
  const text = visibleText(lead);
  if (!text) return "unknown";
  return availabilityFromSignals({
    soldOut: /在庫がありません|在庫切れ|売り切れ|売切れ|品切れ|完売|販売終了|sold\s*out/i.test(
      text,
    ),
    inStock: /カートに入れる|カートへ入れる|在庫あり/.test(text),
  });
}

export const fujiyaAvicInventoryRecheck: InventoryRecheckPolicy = {
  isDetailUrl: isFujiyaAvicDetailUrl,
  candidateUrlPrefix: "https://www.fujiya-avic.co.jp/shop/g/",
  classifyPage: classifyFujiyaAvicInventoryPage,
};
