import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeIdentityModel } from "../src/catalog/product-identity.js";
import { parseAfroAudioListing } from "../src/crawler/shops/afroaudio.js";

test("Afro Audio strips CD transport presentation from Grandioso P1X model", () => {
  const html = `
    <a href="/products/detail/60002">
      〖Aランク〗ESOTERIC Grandioso P1X CDトランスポート エソテリック
      @60002 60002 ￥1,000,000 税込 在庫あり
    </a>`;

  const [item] = parseAfroAudioListing(html, { rawCategory: "プレーヤー" });

  assert.ok(item);
  assert.equal(item.title, "ESOTERIC Grandioso P1X CDトランスポート エソテリック");
  assert.equal(item.manufacturer, "ESOTERIC");
  assert.equal(item.model, "Grandioso P1X");
  assert.equal(normalizeIdentityModel(item.model), normalizeIdentityModel("Grandioso-P1X"));
});
