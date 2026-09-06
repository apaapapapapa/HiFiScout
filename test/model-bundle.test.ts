import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { splitModelBundle } from "../src/catalog/model-bundle.js";
import { resolveModel } from "../src/catalog/model-resolver.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { detectListingComponents } from "../src/catalog/listing-components.js";
import { resolveProductIdentity } from "../src/catalog/product-identity.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";
import { parseDynamicAudioListing } from "../src/crawler/shops/dynamic-audio.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("grouped manufacturers map to their own bundle models without leaking into model text", () => {
  const title = "THORENS+JELCO TD-321+SA-750";
  const parsed = splitManufacturerModel(title, "dynamic-audio");
  assert.deepEqual(parsed, { manufacturer: "Thorens", model: "TD-321 + SA-750" });
  for (const rawModel of [parsed.model, "JELCO TD-321+SA-750"]) {
    const result = resolveModel({ title, rawModel, manufacturerId: "thorens" });
    assert.equal(result.rawModel, rawModel);
    assert.equal(result.model, "TD-321 + SA-750");
    assert.deepEqual(
      result.bundleComponents?.map(({ manufacturerId, model }) => ({ manufacturerId, model })),
      [
        { manufacturerId: "thorens", model: "TD-321" },
        { manufacturerId: "jelco", model: "SA-750" },
      ],
    );
  }
});

test("each bundled model loses its own manufacturer prefix and retains its revision and finish", () => {
  const result = resolveModel({
    rawModel: "CE1TX-WN + TAD-ST2TX-K(ペア) ※送料無料",
    manufacturerId: "tad",
    shopKey: "shimamusen",
  });
  assert.equal(result.model, "CE1TX-WN + ST2TX-K(ペア)");
  assert.equal(result.bundleComponents?.[1].manufacturerId, "tad");
  assert.equal(result.status, "candidate");
  const mixed = resolveModel({ rawModel: "PD-171A + SME 3010R", manufacturerId: "luxman" });
  assert.equal(mixed.model, "PD-171A + 3010R");
  assert.equal(mixed.bundleComponents?.[1].manufacturerId, "sme");
});

test("bundle metadata survives normalization and cannot match a single catalog product", () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      title: "LUXMAN PD-171A + SME 3010R",
      rawModel: "PD-171A + SME 3010R",
      manufacturer: "LUXMAN",
      metadata: { sellerEvidence: "retained" },
    }),
  );
  assert.equal(product.metadata.sellerEvidence, "retained");
  assert.ok(product.metadata.modelNormalization?.bundleComponents);
  const components = detectListingComponents(product, { manufacturerId: "luxman" }).components;
  assert.deepEqual(
    components.map((component) => [component.manufacturerId, component.model]),
    [
      ["luxman", "PD-171A"],
      ["sme", "3010R"],
    ],
  );
  const identity = resolveProductIdentity(product, [
    {
      id: 1,
      manufacturerId: "luxman",
      canonicalModel: "PD-171A",
      aliases: [],
    },
  ]);
  assert.equal(identity.catalogProductId, null);
  assert.equal(identity.status, "unresolved");
});

test("plus-bearing model suffixes, unknown manufacturers and mismatched groups stay intact", () => {
  for (const value of [
    "MC-3+USB",
    "LAN iSilencer+",
    "Horus NEO+α",
    "TELOS2500+",
    "THORENS+UNKNOWN TD-321+SA-750",
    "THORENS+JELCO TD-321+SA-750+PS-1",
  ]) {
    assert.equal(splitModelBundle(value), null, value);
  }
  const result = resolveModel({
    title: "THORENS+JELCO TD-321+SA-750",
    rawModel: "TD-321 MK2",
    manufacturerId: "thorens",
  });
  assert.equal(result.model, "TD-321 MK2");
  assert.equal(result.bundleComponents, undefined);
});

test("adjacent seller entries keep their prices, manufacturers and complete bundle models", () => {
  const html = [
    ["101", "THORENS+JELCO TD-321+SA-750", "176,000"],
    ["102", "Acoustic Solid Solid 111 Metal + Ortofon RS-212D", "220,000"],
    ["103", "GOLD MUND TELOS2500+", "880,000"],
  ]
    .map(
      ([id, title, price]) =>
        `<article id="post-${id}"><h2 class="entry-title"><a href="/2026/08/25/item-${id}/">${title}</a></h2><p>中古＠アナログプレーヤー</p><p>販売価格 ￥${price}</p></article>`,
    )
    .join("");
  const items = parseDynamicAudioListing(html);
  assert.deepEqual(
    items.map((item) => [item.manufacturer, item.model, item.priceYen]),
    [
      ["Thorens", "TD-321 + SA-750", 176000],
      ["Acoustic Solid", "Solid 111 Metal + Ortofon RS-212D", 220000],
      ["GOLD MUND", "TELOS2500+", 880000],
    ],
  );
});
