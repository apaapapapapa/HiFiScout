import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";
import { MarketAnalysis } from "../frontend/market-analysis-ui.js";
import { calculateMarketAnalysis } from "../src/catalog/market-analysis.js";

test("market UI explains sparse groups, observation periods and non-transaction end signals", () => {
  const analysis = calculateMarketAnalysis([], new Map(), [], new Date("2026-09-07T00:00:00Z"));
  const html = renderToStaticMarkup(<MarketAnalysis analysis={analysis} />);
  assert.match(html, /成約価格ではありません/);
  assert.match(html, /3出品・2店舗未満/);
  assert.match(html, /データ不足/);
  assert.match(html, /2026-09/);
  assert.match(html, /合算できません/);
  assert.doesNotMatch(html, /<svg/);
  assert.equal(renderToStaticMarkup(<MarketAnalysis analysis={undefined} />), "");
  const limited = renderToStaticMarkup(<MarketAnalysis analysis={{ ...analysis, status: "limited", months: [] }} />);
  assert.match(limited, /現在利用できません/);
  assert.doesNotMatch(limited, /<table/);
});

test("chart gaps remain gaps and monthly source counts accompany the median", () => {
  const samples = ["2026-07-01T00:00:00Z", "2026-09-01T00:00:00Z"].flatMap((at, month) => [1, 2, 3].map((id) => ({
    id: month * 3 + id, listing_product_id: id, shop_key: id === 1 ? "a" : "b", price_yen: 10000 + id * 100 + month * 1000,
    sample_kind: "asking", signal_kind: "asking", observed_at: at,
  })));
  const analysis = calculateMarketAnalysis([], new Map(), samples, new Date("2026-09-07T00:00:00Z"));
  const html = renderToStaticMarkup(<MarketAnalysis analysis={analysis} />);
  assert.match(html, /<svg/);
  const path = html.match(/<path d="([^"]*)"/)?.[1] ?? "";
  assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.ok(!path.includes("L"), "a missing August does not invent a continuous trend");
  assert.match(html, /3件 \/ 2店舗/);
});
