/**
 * AudioUnion's inventory-recheck knowledge: which URLs may be re-fetched and how its detail
 * pages express availability.
 */

import { stripRawTextElements } from "../../html/raw-text.js";
import { listingFieldHtml, listingFieldText, listingBlocks } from "../listing-fields.js";
import { inferOfferFacts } from "../../catalog/offer-facts.js";
import type { OfferFact, OfferFactId } from "../../catalog/types.js";
import { availabilityFromSignals } from "../availability.js";
import type { InventoryClassification, InventoryRecheckPolicy } from "../types.js";

const DETAIL_PATH = /^\/ct\/detail\/used\/\d+\/?$/;

function visibleText(html: unknown): string {
  return stripRawTextElements(html, ["script", "style", "noscript"])
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
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const scope =
    listingFieldHtml(source, "item_info", "id") || listingBlocks(source, "main")[0] || "";
  const status = listingFieldText(scope, "item_info_product_status", "id");
  const text = status || visibleText(scope);
  if (!text) return "unknown";
  const hasPurchaseEvidence = /在庫あり|カートに入れる|購入する/i.test(text);
  const hasSoldEvidence =
    /販売済み?|販売終了|売約済み?|売り切れ|売切|在庫なし|完売|品切れ|ご成約|sold\s*out/i.test(text);

  return availabilityFromSignals({
    soldOut: hasSoldEvidence,
    inStock: hasPurchaseEvidence,
  });
}

/** Listing-specific fields only; model specifications and generic store policies are not offers. */
export function extractAudioUnionOfferFacts(html: string, observedAt: string): OfferFact[] | null {
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const section = listingFieldHtml(source, "used_item_info", "id");
  if (!section) return null;
  const field = (id: string) =>
    listingFieldText(listingFieldHtml(section, id, "id"), "itp_data")
      .normalize("NFKC")
      .slice(0, 4000);
  const facts: OfferFact[] = [];
  const add = (
    factId: OfferFactId,
    state: "present" | "absent",
    sourceField: OfferFact["sourceField"],
    warrantyMonths?: number,
  ) => {
    facts.push({
      factId,
      state,
      source: "seller_detail",
      sourceField,
      ruleId: `audiounion.detail.v1.${factId}`,
      confidence: 1,
      observedAt,
      ...(warrantyMonths ? { warrantyMonths } : {}),
    });
  };
  const accessories = field("accessory_line");
  const tokens = accessories.split(/[、,。;；\n]/u).map((value) => value.trim());
  const explicitFacts = inferOfferFacts("", accessories, observedAt);
  for (const [id, term] of [
    ["remote_control", "リモコン"],
    ["manual", "(?:取扱説明書|取扱い説明書|説明書|取説)"],
    ["original_box", "(?:元箱|オリジナル箱)"],
  ] as const) {
    const explicit = explicitFacts.find((f) => f.factId === id);
    const bare = tokens.some((token) =>
      new RegExp(`^${term}(?:\\s*\\([A-Z0-9][A-Z0-9._/-]{1,30}\\))?$`, "iu").test(token),
    );
    if (explicit?.state === "absent" && bare) continue;
    if (explicit) add(id, explicit.state as "present" | "absent", "detail_accessories");
    else if (bare) add(id, "present", "detail_accessories");
  }
  const condition = field("condition_line");
  // Normalize this seller's polite negative wording only within its explicit condition field.
  for (const fact of inferOfferFacts(
    "",
    condition.replace(/ございません/g, "ありません"),
    observedAt,
  )) {
    if (
      [
        "appearance_clean",
        "appearance_wear",
        "operation_confirmed",
        "operation_unchecked",
        "operation_fault",
      ].includes(fact.factId)
    )
      add(fact.factId, fact.state as "present" | "absent", "detail_condition");
  }
  const warranty = field("warranty_line");
  const period = warranty.match(/^(\d{1,3})\s*(?:ヶ月|か月|ヵ月|ケ月|カ月|月|年)$/u);
  if (period) {
    const months = Number(period[1]) * (warranty.endsWith("年") ? 12 : 1);
    if (months > 0 && months <= 120) add("shop_warranty", "present", "detail_warranty", months);
  } else if (/^(?:保証)?(?:なし|無し|無保証|対象外)$/u.test(warranty))
    add("shop_warranty", "absent", "detail_warranty");
  return facts;
}

export const audioUnionInventoryRecheck: InventoryRecheckPolicy = {
  isDetailUrl: isAudioUnionUsedDetailUrl,
  classifyPage: classifyAudioUnionInventoryPage,
  extractOfferFacts: extractAudioUnionOfferFacts,
};
