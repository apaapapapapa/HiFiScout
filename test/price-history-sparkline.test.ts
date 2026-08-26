import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HistoryContent, buildPriceHistorySparkline } from "../frontend/public-components.js";
import type { PriceHistoryEntry, ProductHistoryResponse } from "../frontend/types.js";

const listing: ProductHistoryResponse["product"] = {
  manufacturer: "TAD",
  model: "ME1TX",
  title: "TAD ME1TX",
};

function point(price_yen: number, day: number): PriceHistoryEntry {
  return {
    price_yen,
    observed_at: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function renderHistory(history: PriceHistoryEntry[]): string {
  return renderToStaticMarkup(
    createElement(HistoryContent, {
      state: { kind: "ready", data: { product: listing, history } },
    }),
  );
}

test("price history path changes price with horizontal then vertical step segments", () => {
  const chart = buildPriceHistorySparkline([point(100, 1), point(0, 2), point(200, 3)]);

  assert.ok(chart);
  assert.equal(chart.path, "M 8 44 H 160 V 80 H 312 V 8");
  assert.doesNotMatch(chart.path, /\bL\b/u);
  assert.deepEqual(chart.points, [
    { x: 8, y: 44 },
    { x: 160, y: 80 },
    { x: 312, y: 8 },
  ]);
});

test("price history x positions reflect elapsed observation time", () => {
  const chart = buildPriceHistorySparkline([point(100, 1), point(90, 2), point(80, 11)]);

  assert.ok(chart);
  assert.deepEqual(chart.points, [
    { x: 8, y: 8 },
    { x: 38.4, y: 44 },
    { x: 312, y: 80 },
  ]);
  assert.equal(chart.path, "M 8 8 H 38.4 V 44 H 312 V 80");
});

test("flat and one-point price histories normalize without invalid coordinates", () => {
  const flat = buildPriceHistorySparkline([point(100, 1), point(100, 2)]);
  const single = buildPriceHistorySparkline([point(100, 1)]);

  assert.ok(flat);
  assert.equal(flat.path, "M 8 44 H 312 V 44");
  assert.ok(single);
  assert.equal(single.path, "M 160 44");
  assert.deepEqual(single.points, [{ x: 160, y: 44 }]);
  assert.equal(buildPriceHistorySparkline([]), null);
});

test("history sparkline has an accessible name and description while retaining the ordered list", () => {
  const markup = renderHistory([point(100, 1), point(0, 2), point(200, 3)]);

  assert.match(
    markup,
    /<svg class="history-sparkline" viewBox="0 0 320 88" role="img" aria-labelledby="[^"]+ [^"]+">/u,
  );
  assert.match(markup, /<title id="[^"]+">価格推移<\/title>/u);
  assert.match(
    markup,
    /<desc id="[^"]+">3件の価格履歴。最安値￥0、最高値￥200、最新価格￥200。<\/desc>/u,
  );
  assert.match(markup, /<ol class="history">/u);
  assert.equal((markup.match(/<li>/g) || []).length, 3);
  assert.equal((markup.match(/<circle /g) || []).length, 3);
  assert.equal((markup.match(/<span>↓<\/span>/g) || []).length, 1);
});

test("empty price history keeps the existing empty state without rendering a chart", () => {
  const markup = renderHistory([]);

  assert.match(markup, /履歴はまだありません/u);
  assert.doesNotMatch(markup, /history-sparkline/u);
  assert.equal((markup.match(/<li>/g) || []).length, 1);
});
