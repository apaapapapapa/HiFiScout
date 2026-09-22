import { listingAttribute, listingBlocks, listingFieldText } from "../../crawler/listing-fields.js";
import { cleanText } from "../../crawler/normalize.js";
import { rawTextElements, stripRawTextElements } from "../../html/raw-text.js";
import { auctionInstant, auctionObservationStamp, emptyAuctionLiveFacts } from "../observations.js";
import type { AuctionObservation, AuctionParseResult, YahooAuctionSource } from "../types.js";
import {
  YAHOO_AUCTION_PILOT_LIMITS,
  YAHOO_AUCTION_SOURCE,
  yahooAuctionCategory,
  yahooAuctionIdentity,
} from "./policy.js";
import { yahooAuctionBidCount, yahooAuctionPrice, yahooAuctionShipping } from "./values.js";
import { stripYahooHiddenSubtrees } from "./visible-markup.js";

const unsupported = (reason: string): AuctionParseResult => ({
  status: "unsupported",
  coverage: "unknown",
  observations: [],
  issues: [reason],
});
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown, max = 1000): string | null =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;

function categoryPath(
  value: unknown,
  bucket: NonNullable<ReturnType<typeof yahooAuctionCategory>>,
) {
  if (!Array.isArray(value) || value.length < 5 || value.length > 10) return null;
  if (value.some((id) => typeof id !== "string" || !/^\d{1,12}$/u.test(id))) return null;
  const ids = value as string[];
  const prefix = ["0", "23632", ...bucket.path];
  if (new Set(ids).size !== ids.length || prefix.some((id, index) => ids[index] !== id))
    return null;
  return ids;
}

function baseObservation(
  title: string,
  identity: NonNullable<ReturnType<typeof yahooAuctionIdentity>>,
  path: string[],
  bucket: NonNullable<ReturnType<typeof yahooAuctionCategory>>,
  stamp: NonNullable<ReturnType<typeof auctionObservationStamp>>,
): AuctionObservation {
  return {
    source: YAHOO_AUCTION_SOURCE,
    ...identity,
    stamp,
    observedItemFields: ["title", "sourceCategoryId", "sourceCategoryPath", "categoryHint"],
    item: {
      title,
      sourceCategoryId: path[path.length - 1],
      sourceCategoryPath: path,
      // The discovery bucket is not the listing's leaf category label.
      rawCategory: "",
      categoryHint: bucket.categoryHint,
      rawManufacturer: null,
      rawModel: null,
      conditionText: null,
      saleUnit: "unknown",
      saleSubject: "unknown",
    },
    live: emptyAuctionLiveFacts(),
  };
}

function listingPage(
  html: string,
  bucket: NonNullable<ReturnType<typeof yahooAuctionCategory>>,
  stamp: NonNullable<ReturnType<typeof auctionObservationStamp>>,
): AuctionParseResult {
  const cards = listingBlocks(html, "li", "Product");
  if (!cards.length) return unsupported("unrecognized_layout");
  if (cards.length > 50) return unsupported("live_page_limit");
  const observations: AuctionObservation[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, card] of cards.entries()) {
    const issue = (reason: string) => {
      issues.push(`card:${index}:${reason}`);
    };
    const links = listingBlocks(card, "a", "Product__titleLink");
    const opening = links.length === 1 ? links[0].match(/^<a\b([^>]*)>/iu) : null;
    const identity = opening ? yahooAuctionIdentity(listingAttribute(opening[1], "href")) : null;
    const title = links.length === 1 ? string(listingFieldText(card, "Product__titleLink")) : null;
    const metadata = listingBlocks(card, "div", "Product__bonus");
    const attributes = metadata.length === 1 ? metadata[0].match(/^<div\b([^>]*)>/iu)?.[1] : null;
    const path = attributes
      ? categoryPath(listingAttribute(attributes, "data-auction-categoryidpath").split(","), bucket)
      : null;
    if (
      !identity ||
      !title ||
      !attributes ||
      !path ||
      listingAttribute(attributes, "data-auction-id") !== identity.auctionId ||
      (opening && listingAttribute(opening[1], "data-auction-id") !== identity.auctionId)
    ) {
      issue("invalid_identity_or_category");
      continue;
    }
    if (seen.has(identity.auctionId)) return unsupported("duplicate_identity");
    seen.add(identity.auctionId);
    const observation = baseObservation(title, identity, path, bucket, stamp);
    const observed = <T>(value: T) => ({ value, observedAt: stamp.observedAt });
    const prices = new Map<string, string>();
    let ambiguous = false;
    for (const price of listingBlocks(card, "span", "Product__price")) {
      const label = listingFieldText(price, "Product__label");
      if (label !== "現在" && label !== "即決") continue;
      if (
        prices.has(label) ||
        listingBlocks(price, "span", "Product__label").length !== 1 ||
        listingBlocks(price, "span", "Product__priceValue").length !== 1
      )
        ambiguous = true;
      prices.set(label, listingFieldText(price, "Product__priceValue"));
    }
    if (ambiguous) {
      issue("ambiguous_prices");
      continue;
    }
    for (const [label, field] of [
      ["現在", "currentPrice"],
      ["即決", "buyNowPrice"],
    ] as const) {
      if (!prices.has(label)) continue;
      const value = yahooAuctionPrice(prices.get(label)!);
      if (value) observation.live[field] = observed(value);
      else issue(`${field}_unknown`);
    }
    // A missing instant-buy span or data-auction-buynowprice=0 does not establish absence.
    const bids = listingBlocks(card, "dd", "Product__bid");
    const count = bids.length === 1 ? yahooAuctionBidCount(cleanText(bids[0])) : null;
    if (count !== null) observation.live.bidCount = observed(count);
    else if (bids.length) issue("bid_count_unknown");
    const epoch = listingAttribute(attributes, "data-auction-endtime");
    if (/^[1-9]\d{8,9}$/u.test(epoch)) {
      const end = auctionInstant(new Date(Number(epoch) * 1000).toISOString());
      if (end) observation.live.scheduledEndAt = observed(end);
    }
    if (!observation.live.scheduledEndAt) issue("scheduled_end_unknown");
    const postage = listingBlocks(card, "p", "Product__postage");
    if (postage.length === 1)
      observation.live.shipping = observed(yahooAuctionShipping(cleanText(postage[0])));
    // A countdown/list membership is not explicit source state or evidence of a new cycle.
    observations.push(observation);
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

function detailItem(state: unknown): Record<string, unknown> | null {
  return record(record(record(record(state)?.item)?.detail)?.item);
}

function detailPage(
  input: string,
  expectedUrl: unknown,
  bucket: NonNullable<ReturnType<typeof yahooAuctionCategory>>,
  stamp: NonNullable<ReturnType<typeof auctionObservationStamp>>,
): AuctionParseResult {
  const expected = yahooAuctionIdentity(expectedUrl);
  if (!expected) return unsupported("detail_url_required");
  const elements = rawTextElements(input, ["script", "style", "noscript"]);
  const scripts = elements.filter(
    (element) =>
      element.tag === "script" && listingAttribute(element.attributes, "id") === "__NEXT_DATA__",
  );
  if (
    scripts.length !== 1 ||
    listingAttribute(scripts[0].attributes, "type") !== "application/json"
  )
    return unsupported("ambiguous_detail_state");
  // Keep a marker, not the embedded text, while checking hidden/inert ancestors.
  const marker = "<hifiscout-yahoo-state></hifiscout-yahoo-state>";
  if (input.includes(marker)) return unsupported("ambiguous_detail_state");
  let visible = "",
    cursor = 0;
  for (const element of elements) {
    visible += input.slice(cursor, element.start) + (element === scripts[0] ? marker : " ");
    cursor = element.end;
  }
  visible += input.slice(cursor);
  const checked = stripYahooHiddenSubtrees(stripRawTextElements(visible));
  if (!checked?.includes(marker)) return unsupported("hidden_detail_state");
  let json: Record<string, unknown> | null;
  try {
    json = record(JSON.parse(scripts[0].body));
  } catch {
    return unsupported("invalid_detail_json");
  }
  const props = record(json?.props);
  const item = detailItem(record(props?.pageProps)?.initialState);
  const duplicate = detailItem(props?.initialState);
  if (!item || !duplicate || record(json?.query)?.aid !== expected.auctionId)
    return unsupported("invalid_detail_state");
  const keys = [
    "auctionId",
    "auctionItemUrl",
    "title",
    "price",
    "bids",
    "startTime",
    "endTime",
    "status",
    "conditionName",
  ];
  if (
    keys.some((key) => JSON.stringify(item[key]) !== JSON.stringify(duplicate[key])) ||
    JSON.stringify(record(item.category)?.path) !== JSON.stringify(record(duplicate.category)?.path)
  )
    return unsupported("conflicting_detail_state");
  const identity = yahooAuctionIdentity(item.auctionItemUrl);
  const title = string(item.title);
  const categories = record(item.category)?.path;
  const path = categoryPath(
    Array.isArray(categories) ? categories.map((value) => record(value)?.id) : null,
    bucket,
  );
  if (
    !identity ||
    identity.auctionId !== expected.auctionId ||
    item.auctionId !== expected.auctionId ||
    !title ||
    !path
  )
    return unsupported("invalid_detail_identity_or_category");
  const observation = baseObservation(title, identity, path, bucket, stamp);
  const observed = <T>(value: T) => ({ value, observedAt: stamp.observedAt });
  const issues: string[] = [];
  if (
    typeof item.price === "number" &&
    Number.isSafeInteger(item.price) &&
    item.price >= 0 &&
    item.price <= 1_000_000_000_000
  )
    observation.live.currentPrice = observed({ amountYen: item.price, tax: "unknown" });
  else issues.push("current_price_unknown");
  if (
    typeof item.bids === "number" &&
    Number.isSafeInteger(item.bids) &&
    item.bids >= 0 &&
    item.bids <= 1_000_000
  )
    observation.live.bidCount = observed(item.bids);
  else issues.push("bid_count_unknown");
  const start = auctionInstant(item.startTime),
    end = auctionInstant(item.endTime);
  if (start && end && start <= stamp.observedAt && start <= end) {
    observation.live.startedAt = observed(start);
    observation.live.scheduledEndAt = observed(end);
  } else issues.push("dates_unknown");
  if (item.status === "open") observation.live.sourceState = observed("open");
  else issues.push("source_state_unknown");
  const condition = string(item.conditionName, 500);
  if (condition) {
    observation.item.conditionText = condition;
    observation.observedItemFields = [...observation.observedItemFields!, "conditionText"];
  }
  // quantity=1 counts lots, not physical units. Unverified tax/buy-now/terminal-state fields stay unknown.
  return {
    status: issues.length ? "partial" : "parsed",
    coverage: "partial",
    observations: [observation],
    issues,
  };
}

/**
 * Candidate for the complete public layouts observed on 2026-09-22. No I/O; not selected by the
 * production scheduler until pagination, 50-item reservations and account allocation are reviewed.
 */
export function parseYahooAuctionLiveHtml(input: unknown, context: unknown): AuctionParseResult {
  const stamp = auctionObservationStamp(context),
    parameters = record(context);
  if (!stamp || !parameters) return unsupported("invalid_context");
  const bucket =
    typeof parameters.categoryId === "string" ? yahooAuctionCategory(parameters.categoryId) : null;
  if (!bucket) return unsupported("category_not_admitted");
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
  if (!/<\/html[\t\n\f\r ]*>\s*$/iu.test(html)) return unsupported("incomplete_document");
  if (/<template\b/iu.test(html)) return unsupported("inert_template_layout");
  if (parameters.kind === "discover") return listingPage(html, bucket, stamp);
  if (parameters.kind === "confirm") return detailPage(input, parameters.sourceUrl, bucket, stamp);
  return unsupported("source_kind_required");
}

export const yahooAuctionLiveHtmlSource: YahooAuctionSource = {
  key: YAHOO_AUCTION_SOURCE,
  parse: parseYahooAuctionLiveHtml,
};
