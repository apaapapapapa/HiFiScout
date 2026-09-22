import { describe, expect, it } from "vite-plus/test";
import {
  yahooAuctionAccess,
  yahooAuctionCategory,
  yahooAuctionFetchPolicy,
  yahooAuctionIdentity,
  type YahooAuctionReview,
} from "../src/auctions/yahoo/policy.js";

const reviewed: YahooAuctionReview = {
  collection: "verified",
  redistribution: "verified",
  robots: "verified",
  accountBudget: "verified",
  sourceContract: "verified",
};

describe("Yahoo auction pilot admission", () => {
  it("defaults off even with approvals and cannot approve evidence through flags", () => {
    expect(yahooAuctionAccess({}, reviewed)).toMatchObject({
      collect: false,
      search: false,
      display: false,
      deniedBlockers: [],
    });
    expect(
      yahooAuctionAccess({
        YAHOO_AUCTIONS_COLLECT_ENABLED: "true",
        YAHOO_AUCTIONS_SEARCH_ENABLED: "true",
        YAHOO_AUCTIONS_DISPLAY_ENABLED: "true",
      }),
    ).toMatchObject({ collect: false, search: false, display: false });
    expect(yahooAuctionAccess().blockers).toEqual(["robots", "accountBudget", "sourceContract"]);
    expect(yahooAuctionAccess().deniedBlockers).toEqual(["robots"]);
  });

  it("keeps collection and both serving switches independent", () => {
    expect(yahooAuctionAccess({ YAHOO_AUCTIONS_SEARCH_ENABLED: "true" }, reviewed)).toMatchObject({
      collect: false,
      search: true,
      display: false,
    });
    expect(yahooAuctionAccess({ YAHOO_AUCTIONS_COLLECT_ENABLED: "1" }, reviewed).collect).toBe(
      false,
    );
    expect(
      yahooAuctionAccess(
        { YAHOO_AUCTIONS_COLLECT_ENABLED: "true" },
        { ...reviewed, robots: "denied" },
      ).collect,
    ).toBe(false);
    expect(
      yahooAuctionAccess(
        { YAHOO_AUCTIONS_COLLECT_ENABLED: "true" },
        { ...reviewed, accountBudget: "unverified" },
      ).collect,
    ).toBe(false);
  });

  it("does not widen discovery by roots, related links or arbitrary descendants", () => {
    expect(yahooAuctionCategory("2084037425")?.categoryHint).toBe("");
    expect(yahooAuctionCategory("2084024118")?.categoryHint).toBe("SRC.DISC");
    expect(yahooAuctionCategory("23764")).toBeNull();
    expect(yahooAuctionCategory("20840374251")).toBeNull();
  });

  it("canonicalizes a detail link without treating tracking as identity", () => {
    expect(
      yahooAuctionIdentity("https://auctions.yahoo.co.jp/jp/auction/a1234567890?tracking=x"),
    ).toEqual({
      auctionId: "a1234567890",
      sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    });
    for (const url of [
      "http://auctions.yahoo.co.jp/jp/auction/a1234567890",
      "https://auctions.yahoo.co.jp.evil.example/jp/auction/a1234567890",
      "https://u:p@auctions.yahoo.co.jp/jp/auction/a1234567890",
      "https://auctions.yahoo.co.jp:8443/jp/auction/a1234567890",
      "https://auctions.yahoo.co.jp/jp/auction/a1234567890#description",
      "https://auctions.yahoo.co.jp/login",
      "https://auctions.yahoo.co.jp/jp/auction/a1234567890/extra",
    ])
      expect(yahooAuctionIdentity(url)).toBeNull();
  });

  it("never converts transport failures into a confirmed auction end", () => {
    expect(yahooAuctionFetchPolicy(403)).toBe("halt");
    expect(yahooAuctionFetchPolicy(200, true)).toBe("halt");
    expect(yahooAuctionFetchPolicy(429)).toBe("backoff");
    expect(yahooAuctionFetchPolicy(404)).toBe("unavailable_unconfirmed");
    expect(yahooAuctionFetchPolicy(null)).toBe("retry");
    expect(yahooAuctionFetchPolicy(200)).toBe("parse");
  });
});
