import test from "node:test";
import assert from "node:assert/strict";

import { syncShopRows } from "../frontend/product-view.js";
import type { MetaShop } from "../src/api/contracts.js";

test("a shop with no successful sync renders unavailable instead of an epoch age", () => {
  const shop = {
    key: "audio-space-core",
    name: "オーディオスペースコア",
    enabled: true,
    health: {
      status: "warning",
      lastSuccessAt: null,
    },
    sync: {
      last_success_at: null,
    },
  } as unknown as MetaShop;

  const markup = syncShopRows([shop], Date.parse("2026-08-23T00:00:00.000Z"));

  assert.match(markup, /未取得/u);
  assert.doesNotMatch(markup, /日前/u);
});
