import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseYahooAuctionHtml } from "../src/auctions/yahoo/parser.js";
import { stripYahooHiddenSubtrees } from "../src/auctions/yahoo/visible-markup.js";
import { auctionInstant } from "../src/auctions/observations.js";

const context = {
  generation: 1,
  sequence: 1,
  observedAt: "2026-09-22T01:00:00Z",
  categoryId: "2084037425",
};
const price = "<dl><dt>現在</dt><dd>100円</dd></dl>";
const cheap = "<dl><dt>現在</dt><dd>1円</dd></dl>";
function card(fields: string, id = "a1234567890") {
  const link = `https://auctions.yahoo.co.jp/jp/auction/${id}`;
  return `<li class="Product"><a class="Product__titleLink" href="${link}">EXAMPLE</a>${fields}</li>`;
}
const parse = (html: string) => parseYahooAuctionHtml(html, context);

test("hidden ancestors cannot supply auction cards or labelled facts", () => {
  const visible = card(price);
  const hidden = card(cheap, "z1234567890");
  for (const attributes of [
    "hidden",
    'hidden="false"',
    "aria-hidden=true",
    'style="display: none"',
    'style="visibility: hidden !important"',
    'style="display:/**/none"',
    'style="display:&#110;one"',
  ]) {
    const wrapped = `<div ${attributes}><div>${hidden}</div></div>${visible}`;
    assert.deepEqual(parse(wrapped).observations, parse(visible).observations);
    const hiddenFact = `<section ${attributes}>${cheap}</section>`;
    const result = parse(card(hiddenFact + price));
    assert.equal(result.status, "parsed");
    assert.equal(result.observations[0].live.currentPrice?.value.amountYen, 100);
  }
});

test("quoted attributes and void elements do not corrupt hidden ancestry", () => {
  const visible = card(price);
  const hidden = card(cheap, "z1234567890");
  const markup = `<div data-note=">" hidden>${hidden}</div><input hidden>${visible}`;
  assert.deepEqual(parse(markup).observations, parse(visible).observations);
  const ordinary = `<div data-note="hidden" aria-hidden="false">${visible}</div>`;
  assert.deepEqual(parse(ordinary).observations, parse(visible).observations);
});

test("unclosed hidden ancestry or quoted markup is unsupported, never empty success", () => {
  assert.equal(parse(`<div hidden>${card(price)}`).status, "unsupported");
  assert.equal(parse(`<div data-note="unterminated>${card(price)}`).status, "unsupported");
  assert.equal(stripYahooHiddenSubtrees("<div hidden><div></div>"), null);
});

test("removing a hidden label does not join unrelated neighboring facts", () => {
  const fields = '<dt>現在</dt><dt hidden>即決</dt><dd>1円</dd>';
  const result = parse(card(fields + "<dl><dt>状態</dt><dd>開催中</dd></dl>"));
  assert.equal(result.observations[0].live.currentPrice, null);
  assert.equal(result.observations[0].live.buyNowPrice, null);
});

test("auction calendar validation covers every month including November and December", () => {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const [index, lastDay] of days.entries()) {
    const month = String(index + 1).padStart(2, "0");
    assert.ok(auctionInstant(`2026-${month}-${lastDay}T00:00:00Z`));
    assert.equal(auctionInstant(`2026-${month}-${lastDay + 1}T00:00:00Z`), null);
  }
});
