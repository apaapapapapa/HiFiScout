import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import {
  applyAuctionObservation,
  auctionInstant,
  auctionObservationStamp,
  auctionPresentation,
} from "../src/auctions/observations.js";
import { parseYahooAuctionHtml } from "../src/auctions/yahoo/parser.js";
import { yahooAuctionBidCount, yahooAuctionPrice } from "../src/auctions/yahoo/values.js";
import type { AuctionObservation, AuctionSnapshot } from "../src/auctions/types.js";

const fixture = readFileSync(
  new URL("./fixtures/yahoo-auctions.synthetic.html", import.meta.url),
  "utf8",
);
const context = {
  generation: 1,
  sequence: 1,
  observedAt: "2026-09-22T01:00:00Z",
  categoryId: "2084037425",
};
const parse = (html = fixture, extra: Partial<typeof context> = {}) =>
  parseYahooAuctionHtml(html, { ...context, ...extra });
function item(extra: Partial<typeof context> = {}): AuctionObservation {
  const value = parse(fixture, extra).observations[0];
  assert.ok(value);
  return value;
}
function applied(previous: AuctionSnapshot | null, next: AuctionObservation): AuctionSnapshot {
  const result = applyAuctionObservation(previous, next);
  assert.equal(result.status, "applied");
  assert.ok(result.snapshot);
  return result.snapshot;
}
function card(fields: string, title = "EXAMPLE A-100", id = "a1234567890") {
  return `<li class="Product"><a class="Product__titleLink" href="https://auctions.yahoo.co.jp/jp/auction/${id}">${title}</a>${fields}</li>`;
}
const field = (label: string, value: string) => `<dl><dt>${label}</dt><dd>${value}</dd></dl>`;

test("auction parser isolates adjacent cards, currencies and explicit absence", () => {
  const result = parse();
  assert.equal(result.status, "parsed");
  assert.equal(result.coverage, "partial");
  assert.equal(result.observations.length, 2);
  const [first, second] = result.observations;
  assert.deepEqual(first.live.currentPrice?.value, { amountYen: 88_000, tax: "inclusive" });
  assert.deepEqual(first.live.buyNowPrice?.value, { amountYen: 120_000, tax: "inclusive" });
  assert.equal(first.live.bidCount?.value, 0);
  assert.equal(first.live.shipping, null);
  assert.equal(first.item.rawModel, "A-100 MK II");
  assert.equal(first.item.categoryHint, "");
  assert.equal(second.live.currentPrice?.value.amountYen, 12_345);
  assert.equal(second.live.currentPrice?.value.tax, "exclusive");
  assert.equal(second.live.buyNowPrice?.value, null);
  assert.ok(second.live.buyNowPrice);
  assert.equal(second.live.bidCount, null);
  assert.equal(second.live.outcome, null);
  assert.equal(second.live.shipping?.value, "collect");
  assert.equal(second.item.rawManufacturer, null);
});

test("auction numeric readers reject ambiguity and preserve zero versus missing", () => {
  for (const value of [
    "",
    "不明",
    "-1円",
    "1.5円",
    "1,00円",
    "1e3",
    "01円",
    "100円 税込110円",
    "1,000円（1件）",
    "9007199254740993円",
    "100円(税込",
    "100円税別)",
  ]) {
    assert.equal(yahooAuctionPrice(value), null, value);
  }
  assert.deepEqual(yahooAuctionPrice("￥１，０００円（非課税）"), {
    amountYen: 1000,
    tax: "exempt",
  });
  assert.deepEqual(yahooAuctionPrice("1円"), { amountYen: 1, tax: "unknown" });
  assert.equal(yahooAuctionBidCount("０件"), 0);
  for (const value of ["", "不明", "-1", "1.2", "1,00", "1e3", "1000001"])
    assert.equal(yahooAuctionBidCount(value), null);
});

test("auction parser does not turn unsupported HTML or invalid contexts into empty success", () => {
  for (const html of [
    "",
    "<p>商品がありません</p>",
    "<p>ログインしてください</p>",
    "<div>1円</div>",
  ])
    assert.equal(parse(html).status, "unsupported");
  for (const value of [
    null,
    [],
    {},
    { ...context, generation: -1 },
    { ...context, sequence: 1.1 },
    { ...context, observedAt: "09/22 10:00" },
  ])
    assert.equal(parseYahooAuctionHtml(fixture, value).status, "unsupported");
  assert.equal(parse(fixture, { categoryId: "23764" }).status, "unsupported");
  assert.equal(parseYahooAuctionHtml(null, context).status, "unsupported");
  assert.equal(parse("あ".repeat(400_000)).status, "unsupported");
  assert.equal(parse(card(field("現在", "1円")).repeat(101)).status, "unsupported");
});

test("auction parser removes comments, scripts, style and noscript before finding cards", () => {
  const hidden = card(field("現在", "1円"), "HIDDEN Z-999", "z1234567890");
  const baseline = parse();
  for (const wrapper of [
    `<!--${hidden}-->`,
    `<script>${hidden}</script>`,
    `<style>${hidden}</style>`,
    `<noscript>${hidden}</noscript>`,
  ]) {
    assert.deepEqual(parse(wrapper + fixture).observations, baseline.observations);
  }
  assert.equal(parse(`<template>${hidden}</template>${fixture}`).status, "unsupported");
  const nested = fixture.replace(
    "８８，０００円（税込）",
    `８８，０００円（税込）<script>1円</script><!--1円-->`,
  );
  assert.equal(parse(nested).observations[0].live.currentPrice?.value.amountYen, 88_000);
});

test("auction parser rejects duplicate labels, bad URLs and duplicate identities", () => {
  assert.equal(parse(card(field("現在", "1円") + field("現在", "2円"))).status, "unsupported");
  assert.equal(parse(card(field("入札", "0件") + field("入札件数", "1件"))).status, "unsupported");
  assert.equal(
    parse(fixture.replaceAll("https://auctions.yahoo.co.jp", "https://evil.example")).status,
    "unsupported",
  );
  assert.equal(parse(fixture + fixture).status, "unsupported");
});

test("auction missing and malformed fields are unobserved, not zero or current", () => {
  const result = parse(
    card(
      field("現在", "不明") +
        field("即決", "不明") +
        field("入札", "不明") +
        field("送料", "地域による"),
    ),
  );
  assert.equal(result.status, "partial");
  const live = result.observations[0].live;
  assert.equal(live.currentPrice, null);
  assert.equal(live.buyNowPrice, null);
  assert.equal(live.bidCount, null);
  assert.equal(live.shipping?.value, "unknown");
  assert.equal(live.sourceState, null);
});

test("auction sale unit and sold subject do not imply identity or normalized per-piece prices", () => {
  const cases = [
    ["ペア", "本体", "pair", "main_unit", "EXAMPLE S-1 ペア"],
    ["片側", "本体", "single", "main_unit", "EXAMPLE S-1 片側"],
    ["セット", "複数製品セット", "set", "bundle", "EXAMPLE A-100 + D-200"],
    ["不明", "空箱のみ", "unknown", "empty_box", "EXAMPLE A-100 空箱のみ"],
    ["不明", "部品のみ", "unknown", "parts", "EXAMPLE A-100 部品のみ"],
    ["不明", "アクセサリー", "unknown", "accessory", "EXAMPLE A-100用 リモコン"],
  ];
  for (const [unit, subject, expectedUnit, expectedSubject, title] of cases) {
    const value = parse(
      card(
        field("販売単位", unit) +
          field("販売対象", subject) +
          field("現在", "100円") +
          field("商品の状態", "ジャンク"),
        title,
      ),
    ).observations[0];
    assert.equal(value.item.saleUnit, expectedUnit);
    assert.equal(value.item.saleSubject, expectedSubject);
    assert.equal(value.item.title, title);
    assert.equal(value.item.conditionText, "ジャンク");
    assert.equal(value.live.currentPrice?.value.amountYen, 100);
  }
  const unknown = parse(card(field("現在", "1円"), "A-100用 空箱のみ")).observations[0];
  assert.equal(unknown.item.saleSubject, "unknown");
  assert.equal(unknown.item.rawModel, null);
});

test("auction instants reject nonexistent dates, absent zones and relative countdowns", () => {
  assert.equal(auctionInstant("2026-09-22T21:30:00+09:00"), "2026-09-22T12:30:00.000Z");
  assert.equal(auctionInstant("2028-02-29T01:00:00Z"), "2028-02-29T01:00:00.000Z");
  for (const value of [
    "2026-02-29T00:00:00Z",
    "2026-09-31T00:00:00Z",
    "2026-09-22T24:00:00Z",
    "2026-09-22T00:00:00",
    "2026-09-22T00:00:00+14:01",
    "残り3分",
    null,
  ])
    assert.equal(auctionInstant(value), null);
  assert.equal(auctionObservationStamp({ ...context, generation: Number.NaN }), null);
  assert.equal(
    parse(card(field("終了日時", "9/22 21:30"))).observations[0].live.scheduledEndAt,
    null,
  );
});

test("passing an end time derives pending confirmation without declaring a sale", () => {
  const snapshot = applied(null, item());
  const result = auctionPresentation(snapshot, "2026-09-22T12:31:00Z", 24 * 60 * 60 * 1000);
  assert.equal(result.phase, "end_check_pending");
  assert.equal(result.sourceState, "open");
  assert.equal(result.outcome, "unknown");
  assert.equal(snapshot.live.sourceState?.value, "open");
});

test("end extension is observed, not inferred, and can restore a pending display", () => {
  const first = applied(null, item());
  const next = parse(fixture.replace("21:30:00+09:00", "21:40:00+09:00"), {
    sequence: 2,
    observedAt: "2026-09-22T12:31:00Z",
  }).observations[0];
  const second = applied(first, next);
  assert.equal(auctionPresentation(second, "2026-09-22T12:32:00Z", 60_000).phase, "open");
  assert.equal(second.live.scheduledEndAt?.value, "2026-09-22T12:40:00.000Z");
});

test("partial rechecks preserve field evidence times and do not freshen an old status", () => {
  const first = applied(null, item());
  const observation = parse(card(field("即決", "なし")), {
    sequence: 2,
    observedAt: "2026-09-22T02:00:00Z",
  }).observations[0];
  const second = applied(first, observation);
  assert.deepEqual(second.live.currentPrice, first.live.currentPrice);
  assert.deepEqual(second.live.sourceState, first.live.sourceState);
  assert.equal(second.live.buyNowPrice?.value, null);
  assert.equal(second.live.buyNowPrice?.observedAt, "2026-09-22T02:00:00.000Z");
  assert.equal(
    auctionPresentation(second, "2026-09-22T02:01:00Z", 30 * 60 * 1000).freshness,
    "stale",
  );
});

test("replayed and late observations cannot roll back price or state", () => {
  const first = applied(
    null,
    item({ generation: 2, sequence: 3, observedAt: "2026-09-22T03:00:00Z" }),
  );
  assert.equal(
    applyAuctionObservation(
      first,
      item({ generation: 2, sequence: 3, observedAt: "2026-09-22T03:00:00Z" }),
    ).status,
    "duplicate",
  );
  assert.equal(
    applyAuctionObservation(first, item({ sequence: 99, observedAt: "2026-09-22T04:00:00Z" }))
      .status,
    "stale",
  );
  assert.equal(
    applyAuctionObservation(
      first,
      item({ generation: 3, sequence: 4, observedAt: "2026-09-22T01:00:00Z" }),
    ).status,
    "stale",
  );
  assert.equal(applyAuctionObservation(first, parse().observations[1]).status, "identity_mismatch");
});

test("confirmed end survives unknown rechecks and requires evidence for a new cycle", () => {
  const ended = parse(card(field("状態", "終了") + field("現在", "100円") + field("入札", "3件")))
    .observations[0];
  const first = applied(null, ended);
  assert.equal(first.live.outcome, null);
  const unknown = parse(card(field("状態", "不明")), {
    sequence: 2,
    observedAt: "2026-09-22T02:00:00Z",
  }).observations[0];
  assert.equal(applied(first, unknown).live.sourceState?.value, "ended");
  assert.equal(
    applyAuctionObservation(first, item({ sequence: 3, observedAt: "2026-09-22T03:00:00Z" }))
      .status,
    "reopening_unconfirmed",
  );
  const restarted = parse(
    card(field("状態", "開催中") + field("開始日時", "2026-09-22T02:00:00Z")),
    { sequence: 4, observedAt: "2026-09-22T03:00:00Z" },
  ).observations[0];
  const second = applied(first, restarted);
  assert.equal(second.cycle, 2);
  assert.equal(second.live.currentPrice, null);
  assert.equal(second.live.outcome, null);
});

test("winner report is explicit and remains distinct from a completed transaction", () => {
  const result = parse(card(field("状態", "終了") + field("終了結果", "落札者あり")))
    .observations[0];
  assert.equal(result.live.outcome?.value, "winner_reported");
  assert.equal(result.live.currentPrice, null);
  assert.equal(
    parse(card(field("状態", "開催中") + field("終了結果", "落札者あり"))).observations[0].live
      .outcome,
    null,
  );
});

test("hidden cards and labelled facts cannot supply visible prices", () => {
  const visible = card(field("現在", "100円"));
  const hidden = card(field("現在", "1円"), "HIDDEN", "z1234567890").replace(
    'class="Product"',
    'class="Product" hidden',
  );
  assert.deepEqual(parse(hidden + visible).observations, parse(visible).observations);
  const hiddenPrice = field("現在", "1円").replace("<dd>", "<dd hidden>");
  const result = parse(card(hiddenPrice + field("即決", "なし")));
  assert.equal(result.observations[0].live.currentPrice, null);
  assert.equal(result.observations[0].live.buyNowPrice?.value, null);
});

test("malformed adjacent card endings never borrow another card's price", () => {
  const html =
    card(field("状態", "開催中")).replace("</li>", "") +
    card(field("現在", "900円"), "EXAMPLE B-200", "b1234567890");
  const result = parse(html);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].live.currentPrice, null);
  assert.equal(result.observations[1].live.currentPrice?.value.amountYen, 900);
});
