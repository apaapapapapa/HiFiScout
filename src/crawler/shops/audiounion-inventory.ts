/**
 * AudioUnion's inventory-recheck knowledge: which URLs may be re-fetched and how its detail
 * pages express availability.
 */

import { stripRawTextElements } from "../../html/raw-text.js";
import {
  listingAttribute,
  listingFieldHtml,
  listingFieldText,
  listingBlocks,
} from "../listing-fields.js";
import { audioUnionGoodsCode } from "./audiounion-urls.js";
import { inferOfferFacts } from "../../catalog/offer-facts.js";
import type { OfferFact, OfferFactId } from "../../catalog/types.js";
import { availabilityFromSignals } from "../availability.js";
import type {
  InventoryClassification,
  InventoryRecheckPolicy,
  InventoryRecheckListing,
} from "../types.js";

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

/** Exact seller detail routes only; new storefront goods must also prove used identity in HTML. */
export function isAudioUnionUsedDetailUrl(value: string): boolean {
  if (audioUnionGoodsCode(value)) return true;
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

function storefrontDetail(source: string): { scope: string; code: string } | null {
  const panes = listingBlocks(source, "div", "pane-goods-right-side");
  if (panes.length !== 1) return null;
  const scope = panes[0];
  const field = (id: string) => {
    const inputs = [...scope.matchAll(/<input\b([^>]*)>/gi)].filter(
      (match) => listingAttribute(match[1], "id") === id,
    );
    return inputs.length === 1 ? listingAttribute(inputs[0][1], "value") : "";
  };
  const code = field("hidden_goods");
  return field("hidden_class1") === "S" &&
    /^[0-9A-Za-z-]{1,40}$/.test(code) &&
    listingFieldText(scope, "spec_goods", "id") === code
    ? { scope, code }
    : null;
}

export function classifyAudioUnionInventoryPage(
  html: string,
  listing?: Pick<InventoryRecheckListing, "sourceUrl">,
): InventoryClassification {
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  if (
    source.includes("pane-goods-right-side") ||
    (listing && audioUnionGoodsCode(listing.sourceUrl))
  ) {
    const detail = storefrontDetail(source);
    if (!detail || !listing || audioUnionGoodsCode(listing.sourceUrl) !== detail.code)
      return "unknown";
    const stock = listingFieldText(detail.scope, "spec_stock_msg", "id");
    const buttons = [...detail.scope.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
    const cart = buttons.some(
      (button) =>
        listingAttribute(button[1], "data-goods") === detail.code &&
        !/\bdisabled(?:\s|=|$)/i.test(button[1]) &&
        /カートに追加する|買い物かごに入れる/.test(visibleText(button[2])),
    );
    return availabilityFromSignals({
      soldOut:
        stock === "0" ||
        /在庫(?:がありません|なし|切れ)|売約済み?|売り切れ|売切|完売|品切れ|販売終了|sold\s*out/i.test(
          stock,
        ),
      inStock: (/^\d+$/.test(stock) && Number(stock) > 0) || /在庫あり/.test(stock) || cart,
    });
  }
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
  const modern = storefrontDetail(source);
  if (!section && !modern) return null;
  const modernFields: Record<string, string> = {};
  if (modern) {
    for (const row of listingBlocks(listingFieldHtml(modern.scope, "goods-detail-status"), "dl")) {
      const label = visibleText(listingBlocks(row, "dt")[0] || "");
      const value = visibleText(listingBlocks(row, "dd")[0] || "");
      if (label === "付属品") modernFields.accessory_line = value;
      if (label === "状態") modernFields.condition_line = value;
    }
    modernFields.warranty_line = visibleText(
      listingBlocks(listingFieldHtml(modern.scope, "is-guarantee"), "dd")[0] || "",
    );
  }
  const field = (id: string) =>
    (modern
      ? modernFields[id] || ""
      : listingFieldText(listingFieldHtml(section, id, "id"), "itp_data")
    )
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
      ruleId: `audiounion.detail.${modern ? "v2" : "v1"}.${factId}`,
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
  // Old numeric IDs have no verified mapping to new goods codes. A removed legacy route is not
  // evidence that the physical listing sold; recheck only newly observed storefront listings.
  candidateUrlPrefix: "https://www.audiounion.jp/shop/g/g",
  classifyPage: classifyAudioUnionInventoryPage,
  extractOfferFacts: extractAudioUnionOfferFacts,
};
