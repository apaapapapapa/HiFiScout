/**
 * Hifido's inventory-recheck knowledge: which URLs may be re-fetched and how its detail pages
 * express availability.
 *
 * A detail page renders the same card as the listing inside `list-item-for-detail`. An available
 * listing carries its order button; a sold one keeps its card at `/sold/<id>.html` (the seller
 * redirects the detail URL there) with `売約済み` in its price field and no order button.
 */

import { stripRawTextElements } from "../../html/raw-text.js";
import { availabilityFromSignals, availabilityFromText } from "../availability.js";
import { listingBlocks, listingFieldHtml, listingFieldText } from "../listing-fields.js";
import type {
  InventoryClassification,
  InventoryRecheckListing,
  InventoryRecheckPolicy,
} from "../types.js";

const DETAIL_PATH = /^\/(\d{2}-\d{5}-\d{5}-\d{2})\.html$/;

/** Only exact `https://www.hifido.co.jp/<id>.html[?LNG=J]` URLs are re-fetched. */
export function isHifidoDetailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.hifido.co.jp" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      DETAIL_PATH.test(url.pathname) &&
      (url.search === "" || url.search === "?LNG=J") &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function hifidoSourceId(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).pathname.match(DETAIL_PATH)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function classifyHifidoInventoryPage(
  html: string,
  listing?: Pick<InventoryRecheckListing, "sourceUrl">,
): InventoryClassification {
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const cards = listingBlocks(source, "div", "list-item-for-detail");
  if (cards.length !== 1) return "unknown";
  const card = cards[0];
  const sourceId = card.match(/\bid\s*=\s*["']type-(\d{2}-\d{5}-\d{5}-\d{2})["']/i)?.[1] ?? "";
  if (!sourceId) return "unknown";
  // A redirect may only ever land on this listing's own card; any other card proves nothing.
  if (listing && hifidoSourceId(listing.sourceUrl) !== sourceId) return "unknown";

  const price = listingFieldText(card, `price-${sourceId}`, "id");
  const header = listingFieldHtml(card, "list-item-top");
  const orderable = /<button\b[^>]*\border_button\b[^>]*>\s*注文\s*<\/button>/i.test(header);
  return availabilityFromSignals({
    soldOut: availabilityFromText(price) === "sold_out",
    inStock: orderable,
  });
}

export const hifidoInventoryRecheck: InventoryRecheckPolicy = {
  isDetailUrl: isHifidoDetailUrl,
  candidateUrlPrefix: "https://www.hifido.co.jp/",
  classifyPage: classifyHifidoInventoryPage,
};
