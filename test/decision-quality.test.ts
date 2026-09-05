import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { resolveProductIdentity } from "../src/catalog/product-identity.js";
import { modelLookupAliases } from "../src/catalog/knowledge-catalog.js";

// Semantic expectations: coverage and false positive rates are separate. Adding more resolved
// outputs cannot make this corpus pass if an accessory, bundle or revision was merged incorrectly.
const categoryCases = [
  ["プリメインアンプ用リモコン", "ACC.PART"],
  ["CDプレーヤー用リモコン", "ACC.PART"],
  ["ヘッドホンアンプ用ACアダプター", "PWR.SUPPLY"],
  ["remote control for CD-S3000", "ACC.PART"],
  ["phono preamplifier", "AMP.PHONO"],
  ["microphone preamplifier", "REC.MICPRE"],
  ["speaker stand", "ACC.STAND"],
  ["プリメインアンプ DAC搭載", "AMP.INTEGRATED"],
  ["CDプレーヤー リモコン付", "SRC.DISC"],
  ["CDプレーヤー リモコン欠品", "SRC.DISC"],
  ["CD player with remote control", "SRC.DISC"],
  ["CDプレーヤー リモコン操作対応", "SRC.DISC"],
  ["remote controlled CD player", "SRC.DISC"],
] as const;

test("sale-object category corpus preserves meaning and reports false classifications", () => {
  const results = categoryCases.map(([title, expected]) => ({
    title,
    expected,
    actual: inferExplicitCategoryIds(title)[0] ?? null,
  }));
  const classified = results.filter((result) => result.actual !== null);
  const falseClassifications = classified.filter((result) => result.actual !== result.expected);
  const metrics = {
    corpus: "sale_subject_v1",
    total: results.length,
    classified: classified.length,
    unresolved: results.length - classified.length,
    falseClassifications: falseClassifications.length,
    precision: classified.length
      ? (classified.length - falseClassifications.length) / classified.length
      : null,
  };
  console.log(JSON.stringify({ event: "decision_quality_corpus", ...metrics }));
  assert.deepEqual(falseClassifications, [], JSON.stringify(metrics));
  assert.equal(metrics.unresolved, 0, "coverage is checked separately from precision");
});

test("identity corpus distinguishes a compatible accessory from an included one", () => {
  const candidates = [
    { id: 1, manufacturerId: "yamaha", canonicalModel: "CD-S3000", categoryIds: ["SRC.DISC"] },
  ];
  for (const [title, expected] of [
    ["YAMAHA CD-S3000 専用リモコン", "unresolved"],
    ["YAMAHA CD-S3000 リモコン付", "matched"],
    ["YAMAHA CD-S3000 リモコン欠品", "matched"],
    ["YAMAHA ＣＤ－Ｓ３０００", "matched"],
  ] as const) {
    const listing = normalizeCatalogProduct({
      sourceId: "quality",
      manufacturer: "YAMAHA",
      model: "CD-S3000",
      title,
      conditionText: "中古",
      priceYen: 100000,
      stockStatus: "in_stock",
      sourceUrl: "https://example.test/quality",
    });
    assert.equal(resolveProductIdentity(listing, candidates).status, expected, title);
  }
  assert.equal(
    resolveProductIdentity(
      { manufacturerId: "yamaha", model: "CD-S3000", primaryCategoryId: "ACC.PART" },
      candidates,
    ).status,
    "unresolved",
  );
  assert.equal(
    resolveProductIdentity(
      { manufacturerId: "yamaha", model: "CD-S3000", title: "CD-S3000専用リモコン" },
      [],
    ).matchMethod,
    "vetoed",
  );
});

test("safe aliases are symmetric while bundle and revision evidence survives", () => {
  assert.equal(
    resolveProductIdentity({ manufacturerId: "marantz", model: "MODEL10/FB" }, [
      {
        id: 1,
        manufacturerId: "marantz",
        canonicalModel: "MODEL 10",
        categoryIds: ["AMP.INTEGRATED"],
      },
    ]).status,
    "matched",
  );
  assert.equal(
    resolveProductIdentity({ manufacturerId: "accuphase", model: "C-2800+AD-290V" }, [
      { id: 2, manufacturerId: "accuphase", canonicalModel: "C-2800", aliases: ["C-2800+AD-290V"] },
    ]).status,
    "unresolved",
  );
  assert.equal(
    resolveProductIdentity({ manufacturerId: "tad", model: "D-1000 MK2" }, [
      { id: 3, manufacturerId: "tad", canonicalModel: "D-1000", aliases: ["D-1000 MK2"] },
    ]).status,
    "unresolved",
  );
  assert.equal(
    modelLookupAliases({ manufacturerId: "accuphase", model: "C-2800+AD-290V" }).find(
      (alias) => alias.value === "C-2800",
    )?.purpose,
    "category_only",
  );
});
