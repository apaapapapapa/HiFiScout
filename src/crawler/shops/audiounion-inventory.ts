/**
 * AudioUnion's inventory-recheck knowledge: which URLs may be re-fetched and how its detail
 * pages express availability.
 */

import { availabilityFromSignals } from "../availability.js";
import type { InventoryClassification, InventoryRecheckPolicy } from "../types.js";

const DETAIL_PATH = /^\/ct\/detail\/used\/\d+\/?$/;

function visibleText(html: unknown): string {
  return String(html || "")
    .replace(/<script(?:[\s/][^>]*)?>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, " ")
    .replace(/<style(?:[\s/][^>]*)?>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, " ")
    .replace(/<noscript(?:[\s/][^>]*)?>[\s\S]*?<\/noscript(?:[\s/][^>]*)?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Only exact `https://www.audiounion.jp/ct/detail/used/<id>` URLs are re-fetched. */
export function isAudioUnionUsedDetailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.audiounion.jp" &&
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

export function classifyAudioUnionInventoryPage(html: string): InventoryClassification {
  const text = visibleText(html);
  if (!text) return "unknown";

  const priceContext = text.match(/販売価格.{0,120}/i)?.[0] || "";
  const hasPricedOffer = /(?:[¥￥]\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円)/.test(priceContext);
  const hasPurchaseEvidence = /在庫あり|カートに入れる|購入する/i.test(text);
  const hasSoldEvidence =
    /販売終了|売約済み?|売り切れ|売切|在庫なし|完売|品切れ|ご成約|sold\s*out/i.test(text);

  return availabilityFromSignals({
    soldOut: hasSoldEvidence,
    inStock: hasPricedOffer || hasPurchaseEvidence,
  });
}

export const audioUnionInventoryRecheck: InventoryRecheckPolicy = {
  isDetailUrl: isAudioUnionUsedDetailUrl,
  classifyPage: classifyAudioUnionInventoryPage,
};
