import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { inferSaleSubject } from "../src/catalog/sale-subject.js";
import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import { retainedCategoryEvidence } from "../src/catalog/retained-category-evidence.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import {
  extractFujiyaDetailCategoryEvidence,
  FUJIYA_CATEGORY_POLICY,
} from "../src/crawler/shops/fujiya-avic.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("included accessory lists do not replace the main sale object", () => {
  for (const [title, expected] of [
    ["WADIA DAC Wadia 25 ワディア D/Aコンバーター / リモコン スパイク 付属", "PRC.DAC"],
    ["Nmode X-PM7 MKII プリメインアンプ / リモコン 元箱 付属 / ワンオーナー品", "AMP.INTEGRATED"],
    ["CDプレーヤー / リモコン・元箱付き", "SRC.DISC"],
    ["スピーカー【専用スタンドJS-80プレゼント】", "SPK.LOUDSPEAKER"],
    ["ヘッドホン 専用スタンド付き", "PER.HEADPHONE"],
  ] as const)
    assert.deepEqual(inferExplicitCategoryIds(title), [expected], title);
  assert.deepEqual(inferExplicitCategoryIds("CDプレーヤー用リモコン 元箱付属"), ["ACC.PART"]);
  assert.deepEqual(inferExplicitCategoryIds("純正リモコン 元箱付属"), ["ACC.PART"]);
  assert.deepEqual(inferExplicitCategoryIds("CDプレーヤー用のリモコン 元箱付属"), ["ACC.PART"]);
  assert.equal(inferSaleSubject("JBL L82 Classic専用スタンド JS-80").categoryId, "ACC.STAND");
  assert.deepEqual(inferExplicitCategoryIds("交換用ボリュームノブ"), ["ACC.PART"]);
});

test("Nobunaga brand tokens are not knobs and reviewed SKUs distinguish three product types", () => {
  assert.deepEqual(
    inferExplicitCategoryIds("NOBUNAGA Labs ノブナガラボ UNKNOWN [NLS-UNKNOWN]"),
    [],
  );
  for (const [title, rawCategory, expected] of [
    ["NOBUNAGA Labs ノブナガラボ SUPREME 翠嶂 【NLS-SUH】", "", "CAB.PERSONAL"],
    ["NOBUNAGA Labs ノブナガラボ 雲隠 [NLC-KMG]", "イヤホン", "CAB.PERSONAL"],
    ["NOBUNAGA Labs ノブナガラボ 天籟 極 [NLS-TER-KWM]", "ヘッドホン", "CAB.PERSONAL"],
    ["NOBUNAGA Labs ノブナガラボ 碓氷 [NLA-USU]", "DAP・ヘッドホンアンプ", "CAB.ANALOG"],
    ["NOBUNAGA Labs ノブナガラボ 鶯（NLN-UGS-BK）", "", "PER.EARPHONE"],
  ] as const) {
    const p = normalizeCatalogProduct(parsedProduct({ title, rawCategory }), {
      categoryPolicy: FUJIYA_CATEGORY_POLICY,
    });
    assert.equal(p.primaryCategoryId, expected, title);
  }
  assert.equal(
    normalizeCatalogProduct(
      parsedProduct({ title: "NOBUNAGA Labs ノブナガラボ UNKNOWN [NLS-UNKNOWN]" }),
    ).primaryCategoryId,
    "unclassified",
  );
  assert.equal(
    normalizeCatalogProduct(parsedProduct({ title: "NOBUNAGA Labs 雲隠 [NLC-KMG]用ケース" }))
      .primaryCategoryId,
    "ACC.CASE",
  );
});

test("gift stands do not classify an L82 speaker as an accessory or resolve its limited edition identity", () => {
  const title = "JBL L82 Classic BG (ペア) 鏡面仕上げ限定商品【専用スタンドJS-80プレゼント】";
  const p = normalizeCatalogProduct(
    parsedProduct({
      title,
      rawManufacturer: "JBL",
      rawModel: title.replace(/^JBL /, ""),
      rawCategory: "特価商品",
    }),
  );
  assert.equal(p.primaryCategoryId, "SPK.LOUDSPEAKER");
  assert.equal(p.modelResolutionStatus, "candidate");
  assert.equal(p.rawModel, title.replace(/^JBL /, ""));
});

test("broad analog breadcrumbs are supporting evidence on fresh and retained Fujiya listings", () => {
  const title = "iFi audio アイファイオーディオ ZEN Phono 3 [IFI-ZEN-PHONO3]";
  const sourceUrl = "https://www.fujiya-avic.co.jp/shop/g/g240001211570/";
  const html = `<html><body><h1>${title}</h1><ul class="block-topic-path--list"><li><a href="/">トップ</a></li><li><a href="/analog/">アナログプレーヤー</a></li><li class="block-topic-path--item__current"><a href="${sourceUrl}">${title}</a></li></ul><div class="block-goods-detail">${title}</div></body></html>`;
  const detail = extractFujiyaDetailCategoryEvidence(html, {
    title,
    model: "ZEN Phono 3",
    sourceUrl,
  });
  assert.ok(detail.length);
  assert.equal(detail[0].strength, "supporting");
  const normalized = normalizeCatalogProduct(parsedProduct({ title }));
  assert.equal(normalized.primaryCategoryId, "AMP.PHONO");
  assert.equal(
    classifyCategoryEvidence([
      ...(normalized.categoryEvidence || []),
      {
        categoryIds: ["ANA.TURNTABLE"],
        source: "detail_breadcrumb",
        strength: "strong",
        value: "アナログプレーヤー",
      },
    ]).primaryCategoryId,
    "AMP.PHONO",
  );
  for (const ruleId of [undefined, "fujiya.product_breadcrumb.v3"]) {
    const evidence = retainedCategoryEvidence(
      { title, manufacturer: "iFi audio", rawCategory: "", hintedCategory: "ターンテーブル" },
      {
        categoryClassification: {
          version: 27,
          evidence: [
            {
              ruleId,
              categoryIds: ["ANA.TURNTABLE"],
              source: "detail_breadcrumb",
              strength: "strong",
              value: "アナログプレーヤー",
            },
          ],
        },
      },
    );
    assert.equal(classifyCategoryEvidence(evidence).primaryCategoryId, "AMP.PHONO");
    const broadOnly = retainedCategoryEvidence(
      { title: "Unknown Model", rawCategory: "", hintedCategory: "" },
      {
        categoryClassification: {
          evidence: [
            {
              ruleId,
              categoryIds: ["ANA.TURNTABLE"],
              source: "detail_breadcrumb",
              strength: "strong",
              value: "アナログプレーヤー",
            },
          ],
        },
      },
    );
    assert.equal(classifyCategoryEvidence(broadOnly).primaryCategoryId, "unclassified");
  }
  assert.deepEqual(inferExplicitCategoryIds("TEAC TN-4D ターンテーブル"), ["ANA.TURNTABLE"]);
  assert.equal(
    normalizeCatalogProduct(parsedProduct({ title: "iFi audio ZEN Phono 3用 ACアダプター" }))
      .primaryCategoryId,
    "PWR.SUPPLY",
  );
});
