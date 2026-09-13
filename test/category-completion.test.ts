import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  CATEGORIES,
  categoryClosureIds,
  categoryFilterIds,
  getCategory,
} from "../src/catalog/categories.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { inferFacetFacts } from "../src/catalog/product-facets.js";
import { inferFeatureFacts, resolveFeatureState } from "../src/catalog/product-features.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { HIFIDO_CATEGORY_MAPPING, parseHifidoListing } from "../src/crawler/shops/hifido.js";
import {
  validateProductQuery,
  canonicalProductQueryUrl,
  parseProductQuery,
} from "../src/api/product-query.js";
import { parseUrlFilters, featureFromFilterId } from "../frontend/filters.js";

const facets = (text: string) =>
  inferFacetFacts(text).map((fact) => `${fact.facetId}:${fact.value}`);

test("category completion retains 12 roots and 64 durable leaves, reparenting tape by metadata", () => {
  assert.equal(
    CATEGORIES.filter((category) => category.parentId === null && category.filterable).length,
    12,
  );
  assert.equal(CATEGORIES.filter((category) => category.classifiable).length, 64);
  assert.equal(getCategory("ANA.TAPE")?.parentId, "SRC");
  assert.deepEqual(categoryClosureIds("ANA.TAPE"), ["ANA.TAPE", "SRC"]);
  assert.ok(categoryFilterIds("SRC").includes("ANA.TAPE"));
  assert.ok(!categoryFilterIds("ANA").includes("ANA.TAPE"));
  assert.ok(
    CATEGORIES.filter((category) => category.filterable).every((category) =>
      /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(category.name),
    ),
  );
});

test("disc and tape formats do not add product categories or imply recording", () => {
  for (const [title, category, media] of [
    ["SONY MDデッキ MDS-JA50ES", "SRC.DISC", "md"],
    ["Pioneer LDプレーヤー CLD-99", "SRC.DISC", "ld"],
    ["CD recorder R1", "SRC.DISC", "cd"],
    ["Blu-ray player U1", "SRC.DISC", "blu_ray"],
    ["SONY DATデッキ DTC-2000ES", "ANA.TAPE", "dat"],
    ["DCC deck D1", "ANA.TAPE", "dcc"],
    ["カセットデッキ K1", "ANA.TAPE", "cassette"],
    ["Open-reel tape deck R1", "ANA.TAPE", "open_reel"],
  ]) {
    assert.deepEqual(inferExplicitCategoryIds(title), [category], title);
    assert.ok(facets(title).includes(`supported_media:${media}`), title);
  }
  assert.equal(resolveFeatureState(inferFeatureFacts("MDデッキ M1"), "recording"), "unknown");
});

test("bare speaker parts and finished add-on tweeters remain distinct", () => {
  for (const [title, part] of [
    ["フルレンジユニット F1", "driver"],
    ["スピーカーユニット S1", "driver"],
    ["ドライバーユニット D1", "driver"],
    ["speaker driver unit D2", "driver"],
    ["ツイーター T1", "tweeter"],
    ["ホーン H1", "horn"],
    ["エンクロージャー E1", "enclosure"],
    ["replacement tweeter T1", "tweeter"],
  ]) {
    assert.deepEqual(inferExplicitCategoryIds(title), ["ACC.PART"], title);
    assert.ok(facets(title).includes(`part_type:${part}`), title);
    assert.ok(facets(title).includes("target_equipment:speaker"), title);
  }
  for (const title of [
    "後付けスーパーツイーター ST1",
    "ホーン型スピーカー S1",
    "speaker with tweeter S1",
    "ツイーターユニット搭載 スピーカー S1",
    "ドライバーユニット内蔵 スピーカー S2",
    "スピーカー S3 フルレンジユニットを採用",
    "speaker with a speaker driver unit S4",
  ]) {
    assert.deepEqual(inferExplicitCategoryIds(title), ["SPK.LOUDSPEAKER"], title);
    assert.ok(!facets(title).some((facet) => facet.startsWith("part_type:")), title);
  }
  assert.deepEqual(inferExplicitCategoryIds("スピーカーユニット搭載 プリメインアンプ A1"), [
    "AMP.INTEGRATED",
  ]);
  // A generic amplifier still has insufficient evidence for a specific amplifier type.
  assert.deepEqual(inferExplicitCategoryIds("スピーカーユニット搭載アンプ"), []);
});

test("headphone structure, cartridge method and phono support are separate dimensions", () => {
  assert.ok(facets("半開放型ヘッドホン H1").includes("acoustic_design:semi_open"));
  assert.ok(!facets("半開放型ヘッドホン H1").includes("acoustic_design:open_back"));
  assert.ok(facets("密閉型ヘッドホン H1").includes("acoustic_design:closed_back"));
  assert.ok(facets("完全ワイヤレスイヤホン E1").includes("form_factor:true_wireless"));
  assert.ok(facets("MC型カートリッジ C1").includes("cartridge_type:mc"));
  assert.ok(
    !facets("MM/MC対応フォノアンプ A1").some((facet) => facet.startsWith("cartridge_type:")),
  );
  assert.ok(facets("MM/MC対応フォノアンプ A1").includes("phono_support:mm"));
  assert.ok(facets("MM/MC対応フォノアンプ A1").includes("phono_support:mc"));
  assert.ok(!facets("CDトランスポート C1").includes("technology:transformer"));
});

test("cable endpoints are independent and length is inferred only for cables", () => {
  const endpoints = (title: string) =>
    facets(title).filter((facet) => facet.startsWith("connector_"));
  assert.deepEqual(endpoints("RCA - XLR analog cable 1.5m"), [
    "connector_a:rca",
    "connector_b:xlr",
  ]);
  assert.deepEqual(endpoints("USB Type-A to Type-C cable 50cm"), [
    "connector_a:usb_a",
    "connector_b:usb_c",
  ]);
  assert.deepEqual(endpoints("4.4mm - MMCX イヤホンケーブル 1.2m"), [
    "connector_a:4_4mm",
    "connector_b:mmcx",
  ]);
  assert.deepEqual(endpoints("RCA analog cable 1m"), ["connector_a:rca"]);
  assert.deepEqual(endpoints("RCA XLR 3.5mm analog cable 1m"), []);
  assert.ok(facets("RCA cable 1.5m").includes("cable_length:1_to_2m"));
  assert.ok(facets("USB Type-A to Type-C cable 50cm").includes("cable_length:under_1m"));
  assert.ok(!facets("スピーカー S1 幅50cm").some((facet) => facet.startsWith("cable_length:")));
  assert.ok(!facets("RCA cable 1m / 2m").some((facet) => facet.startsWith("cable_length:")));
});

test("capabilities distinguish positive, explicit negative, missing and contradictory evidence", () => {
  for (const [title, feature, expected] of [
    ["DAC非搭載 CDトランスポート", "dac", "absent"],
    ["Network Transport without DAC", "dac", "absent"],
    ["DAC搭載プリメインアンプ", "dac", "present"],
    ["CDトランスポート C1", "dac", "unknown"],
    ["MDレコーダー M1", "recording", "present"],
    ["MDプレーヤー 再生専用", "recording", "absent"],
    ["録音非対応 MDプレーヤー", "recording", "absent"],
    ["CD recorder playback-only", "recording", "unknown"],
    ["DAC非搭載 / DAC搭載", "dac", "unknown"],
    ["DAC用リモコン R1", "dac", "unknown"],
  ] as const)
    assert.equal(resolveFeatureState(inferFeatureFacts(title), feature), expected, title);
});

test("new structured Hifido genres classify model-only listings and retain seller evidence", () => {
  for (const genre of [
    "MDデッキ",
    "DATデッキ",
    "LDプレーヤー",
    "フルレンジユニット",
    "ホーン",
    "チャンネルデバイダー",
  ] as const) {
    const html = `<div class="list-item"><h3><a href="/26-50215-14039-00.html">M100</a></h3><div id="maker-26-50215-14039-00"><div>メーカー:SONY</div></div><div id="price-26-50215-14039-00"><div>売価:10,000円</div></div><div id="genre-26-50215-14039-00"><div>${genre}</div></div></div>`;
    const [parsed] = parseHifidoListing(html);
    assert.equal(parsed.rawCategory, genre);
    const product = normalizeCatalogProduct(parsed, { categoryMapping: HIFIDO_CATEGORY_MAPPING });
    assert.equal(product.primaryCategoryId, HIFIDO_CATEGORY_MAPPING[genre]);
  }
});

test("feature states round-trip through public URLs, chips and API validation", () => {
  const url = new URL(
    "https://example.test/api/product-search?feature=dac:absent&feature=recording:unknown&facet=supported_media:md",
  );
  assert.equal(validateProductQuery(url), null);
  const canonical = canonicalProductQueryUrl(url, parseProductQuery(url));
  assert.deepEqual(parseProductQuery(canonical).features, ["dac:absent", "recording:unknown"]);
  assert.deepEqual(parseUrlFilters(url.search).features, ["dac:absent", "recording:unknown"]);
  assert.equal(featureFromFilterId("feature:dac:absent"), "dac:absent");
  assert.equal(
    validateProductQuery(new URL("https://example.test/?feature=dac&feature=dac:absent")),
    "feature_conflicting_states",
  );
  assert.equal(
    validateProductQuery(new URL("https://example.test/?feature=dac:maybe")),
    "feature_invalid",
  );
});
