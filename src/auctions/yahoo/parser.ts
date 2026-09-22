import { listingAttribute, listingBlocks } from "../../crawler/listing-fields.js";
import { cleanText } from "../../crawler/normalize.js";
import { stripRawTextElements } from "../../html/raw-text.js";
import { auctionInstant, auctionObservationStamp, emptyAuctionLiveFacts } from "../observations.js";
import type {
  AuctionObservation,
  AuctionParseResult,
  AuctionObservedFact,
  YahooAuctionSource,
} from "../types.js";
import {
  YAHOO_AUCTION_PILOT_LIMITS,
  YAHOO_AUCTION_SOURCE,
  yahooAuctionCategory,
  yahooAuctionIdentity,
} from "./policy.js";
import {
  yahooAuctionBidCount,
  yahooAuctionPrice,
  yahooAuctionSaleSubject,
  yahooAuctionSaleUnit,
  yahooAuctionShipping,
} from "./values.js";
import { stripYahooHiddenSubtrees } from "./visible-markup.js";

const LABELS = new Set([
  "現在",
  "即決",
  "入札",
  "入札件数",
  "終了日時",
  "開始日時",
  "状態",
  "終了結果",
  "送料",
  "メーカー",
  "型番",
  "商品の状態",
  "販売単位",
  "販売対象",
]);

function unsupported(reason: string): AuctionParseResult {
  return { status: "unsupported", coverage: "unknown", observations: [], issues: [reason] };
}

/** One labelled value per card. Duplicate labels are ambiguous rather than last-value-wins. */
function labelledFields(card: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  // Never backtrack across another definition or list boundary after a hidden dt/dd was removed.
  // Inline spans/time remain valid; an orphan label must not consume a later, valid pair.
  const pairs = card.matchAll(
    /<dt\b[^>]*>((?:(?!<\/?d[tdl]\b)[\s\S])*)<\/dt\s*>\s*<dd\b[^>]*>((?:(?!<\/?d[tdl]\b)[\s\S])*)<\/dd\s*>/giu,
  );
  for (const pair of pairs) {
    const label = cleanText(pair[1])
      .normalize("NFKC")
      .replace(/[:：]\s*$/u, "")
      .trim();
    if (!LABELS.has(label)) continue;
    if (fields.has(label) || pair[2].length > 4_096) return null;
    fields.set(label, pair[2]);
  }
  if (fields.has("入札") && fields.has("入札件数")) return null;
  return fields;
}

function fieldInstant(html: string): string | null {
  const times = [...html.matchAll(/<time\b([^>]*)>/giu)];
  if (times.length > 1) return null;
  return auctionInstant(times.length ? listingAttribute(times[0][1], "datetime") : cleanText(html));
}

/**
 * Offline candidate grammar, NOT a verified live Yahoo layout. Only explicit Product cards and
 * their title link / dt-dd facts are accepted. Keep the sourceContract launch gate unverified
 * until an authorized, current raw source fixture proves this adapter or replaces it.
 */
export function parseYahooAuctionHtml(input: unknown, context: unknown): AuctionParseResult {
  const stamp = auctionObservationStamp(context);
  if (!stamp || typeof context !== "object" || context === null || Array.isArray(context))
    return unsupported("invalid_context");
  const categoryId = (context as Record<string, unknown>).categoryId;
  const category = typeof categoryId === "string" ? yahooAuctionCategory(categoryId) : null;
  if (!category) return unsupported("category_not_admitted");
  if (typeof input !== "string") return unsupported("invalid_input");
  if (
    input.length > YAHOO_AUCTION_PILOT_LIMITS.maxResponseBytes ||
    new TextEncoder().encode(input).length > YAHOO_AUCTION_PILOT_LIMITS.maxResponseBytes
  )
    return unsupported("response_limit");
  const html = stripYahooHiddenSubtrees(
    stripRawTextElements(input, ["script", "style", "noscript"]),
  );
  if (html === null) return unsupported("ambiguous_hidden_markup");
  // Inert templates are not visible seller cards; an unrecognized template-containing layout
  // requires a fixture review, not a guessed extraction from its contents.
  if (/<template\b/iu.test(html)) return unsupported("inert_template_layout");
  const cards = listingBlocks(html, "li", "Product");
  if (!cards.length) return unsupported("unrecognized_layout");
  if (cards.length > YAHOO_AUCTION_PILOT_LIMITS.maxItemsPerPage) return unsupported("item_limit");
  const observations: AuctionObservation[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, card] of cards.entries()) {
    const issue = (reason: string) => {
      issues.push(`card:${index}:${reason}`);
    };
    const links = [...card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)].filter((link) =>
      listingAttribute(link[1], "class").split(/\s+/u).includes("Product__titleLink"),
    );
    const identity =
      links.length === 1 ? yahooAuctionIdentity(listingAttribute(links[0][1], "href")) : null;
    const title = links.length === 1 ? cleanText(links[0][2]) : "";
    const fields = labelledFields(card);
    if (!identity || !title || title.length > 1_000 || !fields || !fields.size) {
      issue("invalid_identity_or_fields");
      continue;
    }
    if (seen.has(identity.auctionId)) return unsupported("duplicate_identity");
    seen.add(identity.auctionId);
    const text = (label: string) => cleanText(fields.get(label) ?? "");
    const observed = <T>(value: T): AuctionObservedFact<T> => ({
      value,
      observedAt: stamp.observedAt,
    });
    const live = emptyAuctionLiveFacts();
    if (fields.has("現在")) {
      const value = yahooAuctionPrice(text("現在"));
      if (value) live.currentPrice = observed(value);
      else issue("current_price_unknown");
    }
    if (fields.has("即決")) {
      const raw = text("即決").normalize("NFKC");
      const value = yahooAuctionPrice(raw);
      if (value || raw === "なし" || raw === "設定なし") live.buyNowPrice = observed(value);
      else issue("buy_now_price_unknown");
    }
    const bidLabel = fields.has("入札件数") ? "入札件数" : "入札";
    if (fields.has(bidLabel)) {
      const value = yahooAuctionBidCount(text(bidLabel));
      if (value !== null) live.bidCount = observed(value);
      else issue("bid_count_unknown");
    }
    for (const [label, key] of [
      ["開始日時", "startedAt"],
      ["終了日時", "scheduledEndAt"],
    ] as const) {
      if (!fields.has(label)) continue;
      const value = fieldInstant(fields.get(label) ?? "");
      if (value && (key !== "startedAt" || value <= stamp.observedAt)) live[key] = observed(value);
      else issue(`${key}_unknown`);
    }
    if (live.startedAt && live.scheduledEndAt && live.scheduledEndAt.value < live.startedAt.value) {
      live.startedAt = null;
      live.scheduledEndAt = null;
      issue("inconsistent_dates");
    }
    if (fields.has("状態")) {
      const value = text("状態");
      if (value === "開催中") live.sourceState = observed("open");
      else if (value === "終了") live.sourceState = observed("ended");
      else if (value === "不明") live.sourceState = observed("unknown");
      else issue("source_state_unknown");
    }
    // A bid count, even on an ended listing, is not proof of a winner or completed transaction.
    if (live.sourceState?.value === "ended" && fields.has("終了結果")) {
      const value = text("終了結果");
      if (value === "落札者あり") live.outcome = observed("winner_reported");
      else if (value === "落札者なし") live.outcome = observed("no_winner_reported");
      else if (value === "不明") live.outcome = observed("unknown");
      else issue("outcome_unknown");
    }
    if (fields.has("送料")) live.shipping = observed(yahooAuctionShipping(text("送料")));
    const conditionText = text("商品の状態");
    observations.push({
      source: YAHOO_AUCTION_SOURCE,
      ...identity,
      stamp,
      item: {
        title,
        rawManufacturer: text("メーカー") || null,
        rawModel: text("型番") || null,
        sourceCategoryId: category.id,
        sourceCategoryPath: [...category.path],
        rawCategory: category.label,
        categoryHint: category.categoryHint,
        conditionText: conditionText || null,
        saleUnit: yahooAuctionSaleUnit(text("販売単位")),
        saleSubject: yahooAuctionSaleSubject(text("販売対象")),
      },
      live,
    });
  }
  if (!observations.length)
    return { ...unsupported("no_usable_cards"), issues: [...issues, "no_usable_cards"] };
  return {
    status: issues.length ? "partial" : "parsed",
    coverage: "partial",
    observations,
    issues,
  };
}

export const yahooAuctionHtmlSource: YahooAuctionSource = {
  key: YAHOO_AUCTION_SOURCE,
  parse: parseYahooAuctionHtml,
};
