import { describe, expect, it } from "vite-plus/test";
import { parseYahooAuctionLiveHtml } from "../src/auctions/yahoo/live-parser.js";
import { yahooAuctionCategory, yahooAuctionIdentity } from "../src/auctions/yahoo/policy.js";
import { encodeAuctionCursor, parseAuctionQuery } from "../src/api/auction-query.js";

// Minimal structures from the authorized 2026-09-22 responses; identifiers, titles and values
// are fictional. No seller profiles, images, descriptions or bid histories are retained.
const context = {
  generation: 7,
  sequence: 11,
  observedAt: "2026-09-22T09:00:00.000Z",
  categoryId: "2084037425",
  kind: "discover",
};
const path = ["0", "23632", "23764", "23792", "2084037425", "2084037427"];
const doc = (body: string) => `<html><body>${body}</body></html>`;
const card = (id = "a1234567890", category = path, extra = "") => `
<li class="Product">
  <div class="Product__bonus" data-auction-id="${id}"
    data-auction-categoryidpath="${category.join(",")}" data-auction-endtime="1790083000"
    data-auction-buynowprice="0"></div>
  <a class="Product__titleLink js-browseHistory-add" data-auction-id="${id}"
    href="https://auctions.yahoo.co.jp/jp/auction/${id}">EXAMPLE A-100</a>
  <div class="Product__priceInfo"><span class="Product__price">
    <span class="Product__label">現在</span><span class="Product__priceValue u-textRed">61,000円</span>
  </span>${extra}<p class="Product__postage">送料未定</p></div>
  <dl class="Product__otherInfo"><div class="Product__bidWrap">
    <dt class="Product__label"><img alt="入札"></dt><dd class="Product__bid">0</dd>
  </div><div class="Product__timeWrap"><dt class="Product__label"><img alt="残り"></dt>
    <dd class="Product__time">5時間</dd></div></dl>
</li>`;
const parse = (html: string, extra: Record<string, unknown> = {}) =>
  parseYahooAuctionLiveHtml(html, { ...context, ...extra });
const detail = (
  changes: Record<string, unknown> = {},
  secondChanges: Record<string, unknown> = {},
) => {
  const item = {
    auctionId: "a1234567890",
    auctionItemUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    title: "EXAMPLE A-100",
    price: 61_000,
    bids: 0,
    quantity: 1,
    startTime: "2026-09-20T21:17:06+09:00",
    endTime: "2026-09-22T22:16:40+09:00",
    status: "open",
    conditionName: "目立った傷や汚れなし",
    category: { path: path.map((id) => ({ id, name: "example" })) },
    descriptionHtml: "excluded description",
    seller: { excluded: true },
    highestBidders: ["excluded"],
    ...changes,
  };
  const state = (value: unknown) => ({ item: { detail: { item: value } } });
  const json = {
    query: { aid: "a1234567890" },
    props: {
      pageProps: { initialState: state(item) },
      initialState: state({ ...item, ...secondChanges }),
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json)}</script>`;
};
const parseDetail = (html = doc(detail()), extra: Record<string, unknown> = {}) =>
  parse(html, {
    kind: "confirm",
    sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    ...extra,
  });

describe("authorized Yahoo public-layout candidate", () => {
  it("reads current listing fields without inventing state, tax, instant-buy absence or sale units", () => {
    const result = parse(doc(card()));
    expect(result.status).toBe("parsed");
    expect(result.coverage).toBe("partial");
    const value = result.observations[0];
    expect(value.stamp).toEqual({ generation: 7, sequence: 11, observedAt: context.observedAt });
    expect(value.live.currentPrice?.value).toEqual({ amountYen: 61_000, tax: "unknown" });
    expect(value.live.bidCount?.value).toBe(0);
    expect(value.live.scheduledEndAt?.value).toBe("2026-09-22T13:16:40.000Z");
    expect(value.live.buyNowPrice).toBeNull();
    expect(value.live.sourceState).toBeNull();
    expect(value.live.startedAt).toBeNull();
    expect(value.live.outcome).toBeNull();
    expect(value.live.shipping?.value).toBe("unknown");
    expect(value.item.saleUnit).toBe("unknown");
    expect(value.item.sourceCategoryId).toBe("2084037427");
    expect(value.item.sourceCategoryPath).toEqual(path);
    expect(value.item.rawCategory).toBe("");
    expect(yahooAuctionCategory("2084037427")).toBeNull();
  });

  it("isolates adjacent numeric IDs and explicit separate instant-buy prices", () => {
    const buy =
      '<span class="Product__price"><span class="Product__label">即決</span><span class="Product__priceValue">80,000円（税込）</span></span>';
    const result = parse(
      doc(card("a1234567890", path, buy) + card("1234567890").replace("61,000円", "5,000円")),
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].live.buyNowPrice?.value).toEqual({
      amountYen: 80_000,
      tax: "inclusive",
    });
    expect(result.observations[1].auctionId).toBe("1234567890");
    expect(result.observations[1].live.currentPrice?.value.amountYen).toBe(5_000);
    expect(result.observations[1].live.buyNowPrice).toBeNull();
    expect(parse(doc(card("a1234567890", path, buy + buy))).observations).toHaveLength(0);
    const twoLabels = card().replace(
      "現在</span>",
      '現在</span><span class="Product__label">即決</span>',
    );
    expect(parse(doc(twoLabels)).observations).toHaveLength(0);
  });

  it("accepts the observed CD bucket without replacing its category with amplifier context", () => {
    const cd = ["0", "23632", "23764", "23772", "2084024118"];
    expect(
      parse(doc(card("a1234567890", cd)), { categoryId: "2084024118" }).observations[0].item
        .categoryHint,
    ).toBe("SRC.DISC");
    expect(parse(doc(card("a1234567890", cd))).status).toBe("unsupported");
    expect(parse(doc(card("a1234567890", [...path, path[5]]))).status).toBe("unsupported");
  });

  it("reads all 50 cards, rejects a larger or duplicate-ID page and never claims full inventory", () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      card(`a${String(i).padStart(10, "0")}`),
    ).join("");
    expect(parse(doc(cards)).observations).toHaveLength(50);
    expect(parse(doc(cards)).coverage).toBe("partial");
    expect(parse(doc(cards + card())).issues).toEqual(["live_page_limit"]);
    expect(parse(doc(card() + card())).issues).toEqual(["duplicate_identity"]);
    expect(parse(doc("")).coverage).toBe("unknown");
  });

  it("rejects mismatched metadata and cannot recover identities or prices from hidden cards", () => {
    expect(
      parse(doc(card().replace('data-auction-id="a1234567890"', 'data-auction-id="b1234567890"')))
        .status,
    ).toBe("unsupported");
    const hidden = `<div hidden>${card("b1234567890")}</div>`;
    expect(parse(doc(hidden + card())).observations.map((x) => x.auctionId)).toEqual([
      "a1234567890",
    ]);
    expect(parse(doc(`<template>${card()}</template>`)).status).toBe("unsupported");
    const missingBid = card().replace('<dd class="Product__bid">0</dd>', "");
    expect(parse(doc(missingBid)).observations[0].live.bidCount).toBeNull();
    expect(
      parse(
        doc(
          card().replace(
            'class="Product__priceValue u-textRed"',
            'hidden class="Product__priceValue u-textRed"',
          ),
        ),
      ).observations,
    ).toHaveLength(0);
  });

  it("does not infer an exact time from a relative countdown or accept ambiguous numbers", () => {
    for (const epoch of ["", "0", "1e9", "1790083000.5", "-1790083000"]) {
      const result = parse(
        doc(card().replace('data-auction-endtime="1790083000"', `data-auction-endtime="${epoch}"`)),
      );
      expect(result.observations[0].live.scheduledEndAt).toBeNull();
    }
    const result = parse(doc(card().replace("61,000円", "61,000円 税込67,100円")));
    expect(result.observations[0].live.currentPrice).toBeNull();
    expect(result.status).toBe("partial");
  });

  it("requires an explicit source kind, complete bounded document and scheduler stamp", () => {
    expect(parse(card()).issues).toEqual(["incomplete_document"]);
    expect(parse(doc(card()), { kind: undefined }).issues).toEqual(["source_kind_required"]);
    expect(parse(doc(card()), { sequence: -1 }).issues).toEqual(["invalid_context"]);
    expect(parse(doc(card()), { categoryId: "23764" }).issues).toEqual(["category_not_admitted"]);
    expect(parse(doc("あ".repeat(400_000))).issues).toEqual(["response_limit"]);
  });

  it("selects only the requested detail item and excludes embedded seller and bidder data", () => {
    const result = parseDetail();
    expect(result.status).toBe("parsed");
    const value = result.observations[0];
    expect(value.live.sourceState?.value).toBe("open");
    expect(value.live.startedAt?.value).toBe("2026-09-20T12:17:06.000Z");
    expect(value.live.scheduledEndAt?.value).toBe("2026-09-22T13:16:40.000Z");
    expect(value.live.bidCount?.value).toBe(0);
    expect(value.live.currentPrice?.value.tax).toBe("unknown");
    expect(value.item.conditionText).toBe("目立った傷や汚れなし");
    expect(value.item.saleUnit).toBe("unknown");
    expect(value.live.buyNowPrice).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/seller|highestBidders|descriptionHtml|excluded/);
    expect(
      parseDetail(undefined, { sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/b1234567890" })
        .status,
    ).toBe("unsupported");
    expect(parseDetail(undefined, { sourceUrl: undefined }).issues).toEqual([
      "detail_url_required",
    ]);
  });

  it("rejects conflicting roots, multiple state scripts, comments and hidden/inert state", () => {
    expect(parseDetail(doc(detail({}, { price: 1 }))).issues).toEqual(["conflicting_detail_state"]);
    expect(parseDetail(doc(detail() + detail())).issues).toEqual(["ambiguous_detail_state"]);
    expect(parseDetail(doc(`<!--${detail()}-->`)).status).toBe("unsupported");
    expect(parseDetail(doc(`<div hidden>${detail()}</div>`)).issues).toEqual([
      "hidden_detail_state",
    ]);
    expect(parseDetail(doc(`<template>${detail()}</template>`)).status).toBe("unsupported");
    expect(
      parseDetail(
        doc(detail().replace('"query":{"aid":"a1234567890"}', '"query":{"aid":"b1234567890"}')),
      ).status,
    ).toBe("unsupported");
  });

  it("leaves unsupported terminal statuses, invalid dates and missing numeric facts unobserved", () => {
    const result = parseDetail(
      doc(detail({ status: "closed", endTime: "2026-09-22 22:16", price: "61,000", bids: null })),
    );
    expect(result.status).toBe("partial");
    expect(result.observations[0].live.sourceState).toBeNull();
    expect(result.observations[0].live.outcome).toBeNull();
    expect(result.observations[0].live.scheduledEndAt).toBeNull();
    expect(result.observations[0].live.currentPrice).toBeNull();
    expect(result.observations[0].live.bidCount).toBeNull();
  });

  it("rejects deeply nested unexpected fields without recursively serializing source data", () => {
    const nested = "[".repeat(12000) + "0" + "]".repeat(12000);
    const html = doc(detail().replaceAll('"price":61000', `"price":${nested}`));
    expect(() => parseDetail(html)).not.toThrow();
    expect(parseDetail(html).status).toBe("unsupported");
  });

  it("keeps numeric source IDs usable in continuation cursors while rejecting arbitrary paths", () => {
    const now = Date.parse(context.observedAt);
    const { key } = parseAuctionQuery(new URL("https://fixture.test/"), now);
    for (const id of ["a1234567890", "1234567890"]) {
      expect(yahooAuctionIdentity(`https://auctions.yahoo.co.jp/jp/auction/${id}`)?.auctionId).toBe(
        id,
      );
      const cursor = encodeAuctionCursor({
        v: 1,
        query: key,
        expires: now + 60_000,
        id,
        value: null,
      });
      expect(
        parseAuctionQuery(new URL(`https://fixture.test/?cursor=${cursor}`), now).cursor?.id,
      ).toBe(id);
    }
    for (const id of ["123", "0123456789", "12345678901", "1234567890/extra", "1234567890%2F"]) {
      expect(yahooAuctionIdentity(`https://auctions.yahoo.co.jp/jp/auction/${id}`)).toBeNull();
    }
  });
});
