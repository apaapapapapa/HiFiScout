import test from "node:test";
import assert from "node:assert/strict";

import { syncShopPresentations } from "../frontend/product-presentation.js";
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

  const [presentation] = syncShopPresentations([shop], Date.parse("2026-08-23T00:00:00.000Z"));

  assert.equal(presentation?.relative, "未取得");
  assert.equal(presentation?.exact, "未取得");
  assert.doesNotMatch(presentation?.relative ?? "", /日前/u);
});