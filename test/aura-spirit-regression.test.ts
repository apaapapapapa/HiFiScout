import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { resolveManufacturer } from "../src/catalog/manufacturer-resolver.js";
import { audioUnionAdapter } from "../src/crawler/shops/audiounion.js";

test("AURA is a verified bootstrap manufacturer", () => {
  const result = resolveManufacturer({ rawManufacturer: "AURA" });

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "aura");
  assert.equal(result.displayName, "AURA");
  assert.equal(result.method, "bootstrap_alias");
});

test("Audio Union keeps AURA and Spirit separate when both links are text-only", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300010/">AURA</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300010/">spirit</a>
      <div>販売価格: &yen;98,000</div>
    </article>`;

  const [item] = audioUnionAdapter.parse(
    html,
    "https://www.audiounion.jp/st/new_arrival_used.html",
  );

  assert.equal(item.rawManufacturer, "AURA");
  assert.equal(item.manufacturer, "AURA");
  assert.equal(item.model, "spirit");
  assert.equal(item.title, "AURA spirit");
});
