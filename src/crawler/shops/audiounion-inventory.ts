/**
 * AudioUnion's inventory-recheck knowledge: which URLs may be re-fetched and how its detail
 * pages express availability.
 *
 * Kept out of `crawler/inventory-recheck.ts` so the recheck loop stays shop-agnostic, and out of
 * `audiounion.ts` so the listing parser stays focused on parsing.
 */

import type { InventoryClassification, InventoryRecheckPolicy } from "../types.js";

const DETAIL_PATH = /^\/ct\/detail\/used\/\d+\/?$/;

function visibleText(html: unknown): string {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Only exact `https://www.audiounion.jp/ct/detail/used/<id>` URLs are re-fetched.
 *
 * The stored `source_url` is crawler input, so every other component — port, credentials, query,
 * fragment — must be empty rather than merely ignored.
 */
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
  if (!text) return "ambiguous";

  const priceContext = text.match(/販売価格.{0,120}/i)?.[0] || "";
  const hasPricedOffer = /(?:[¥￥]\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円)/.test(priceContext);
  const hasPurchaseEvidence = /在庫あり|カートに入れる|購入する/i.test(text);
  const hasSoldEvidence =
    /販売終了|売約済み?|売り切れ|売切|在庫なし|完売|品切れ|ご成約|sold\s*out/i.test(text);
  const hasActiveEvidence = hasPricedOffer || hasPurchaseEvidence;

  // Conflicting page-wide signals can come from recommendations or retained historical markup.
  // Never treat contradictory markup as proof of either state.
  if (hasActiveEvidence && hasSoldEvidence) return "ambiguous";
  if (hasActiveEvidence) return "in_stock";
  if (hasSoldEvidence) return "sold_out";
  return "ambiguous";
}

export const audioUnionInventoryRecheck: InventoryRecheckPolicy = {
  enabledEnv: "AUDIOUNION_INVENTORY_RECHECK_ENABLED",
  minListingAgeHoursEnv: "AUDIOUNION_INVENTORY_RECHECK_MIN_AGE_HOURS",
  intervalHoursEnv: "AUDIOUNION_INVENTORY_RECHECK_INTERVAL_HOURS",
  failureThresholdEnv: "AUDIOUNION_INVENTORY_RECHECK_FAILURE_THRESHOLD",
  isDetailUrl: isAudioUnionUsedDetailUrl,
  classifyPage: classifyAudioUnionInventoryPage,
};
