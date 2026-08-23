import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MANUFACTURER_RESOLVER_VERSION,
  resolveManufacturer,
} from "../src/catalog/manufacturer-resolver.js";
import {
  manufacturerIdForFilter,
  normalizeManufacturer,
  normalizeManufacturerKey,
} from "../src/catalog/manufacturers.js";
import { resolveModel } from "../src/catalog/model-resolver.js";
import { normalizeIdentityModel, resolveProductIdentity } from "../src/catalog/product-identity.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parseHifidoListing } from "../src/crawler/shops/hifido.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("section 5 migration requeues manufacturer replay with a valid stale version", () => {
  const migration = readFileSync(
    new URL("../migrations/0042_remediate_product_identity_section5.sql", import.meta.url),
    "utf8",
  );
  const match = migration.match(/SET manufacturer_resolver_version = (\d+)/u);
  assert.ok(match, "section 5 migration must set a replay-eligible manufacturer resolver version");
  const replayVersion = Number(match[1]);
  assert.ok(replayVersion > 0, "products schema requires manufacturer_resolver_version > 0");
  assert.ok(
    replayVersion < MANUFACTURER_RESOLVER_VERSION,
    "section 5 migration must leave active listings stale for bounded replay",
  );
});

test("section 5 N-1 excludes Hifido music software by department and title", () => {
  const item = (sourceId: string, title: string) => `
    <div class="list-item">
      <h3><a id="type-${sourceId}" href="/${sourceId}.html">${title}</a></h3>
      <div>メーカー:SONY ソニー</div>
      <div>売価:2,500円(税込)</div>
      <div id="genre-${sourceId}">その他オーディオ機器</div>
    </div>`;
  const products = parseHifidoListing(
    item("26-20368-12345-00", "アマデウス弦楽四重奏団5枚セット") +
      item("26-50000-12345-00", "クラシック名演集 6枚組") +
      item("26-50001-12345-00", "TA-DA9000ES"),
  );
  assert.deepEqual(
    products.map((product) => product.sourceId),
    ["26-50001-12345-00"],
  );
});

test("section 5 N-2 resolves the audited high-volume manufacturer spellings", () => {
  const cases: readonly [string, string][] = [
    ["AIRBOW", "airbow"],
    ["Astell&Kern", "astellkern"],
    ["FIIO", "fiio"],
    ["Cayin", "cayin"],
    ["HiByMusic", "hibymusic"],
    ["Campfire Audio", "campfireaudio"],
    ["Unique Melody", "uniquemelody"],
    ["audioquest", "audioquest"],
    ["TIGLON", "tiglon"],
    ["KENWOOD", "kenwood"],
    ["TRIO", "trio"],
  ];
  for (const [raw, expectedId] of cases) {
    assert.equal(resolveManufacturer({ rawManufacturer: raw }).canonicalManufacturerId, expectedId);
    assert.equal(normalizeManufacturer(raw).id, expectedId);
    assert.equal(manufacturerIdForFilter(raw), expectedId);
  }
});

test("section 5 N-3 keeps unresolved public manufacturer ids deterministic", () => {
  const first = normalizeCatalogProduct(
    parsedProduct({
      title: "Mystery Brand X-1",
      manufacturer: "Mystery Brand",
      rawManufacturer: "Mystery Brand",
      model: "X-1",
    }),
  );
  const second = normalizeCatalogProduct(
    parsedProduct({
      title: "Mystery Brand X-1",
      manufacturer: "Mystery Brand",
      rawManufacturer: "Mystery Brand",
      model: "X-1",
    }),
  );
  assert.equal(first.manufacturerResolutionStatus, "unresolved");
  assert.equal(first.manufacturerId, manufacturerIdForFilter("Mystery Brand"));
  assert.equal(first.manufacturerId, second.manufacturerId);
});

test("section 5 N-4 rejects placeholder manufacturers without title inference", () => {
  for (const placeholder of [
    "不明",
    "不明 フメイ",
    "不明 ナガオカ",
    "メーカー不明",
    "その他",
    "ノーブランド",
  ]) {
    assert.equal(normalizeManufacturerKey(placeholder), "");
    assert.equal(manufacturerIdForFilter(placeholder), "");
    const resolution = resolveManufacturer({
      rawManufacturer: placeholder,
      manufacturerCandidate: placeholder,
      title: "SONY HAP-Z1ES",
    });
    assert.equal(resolution.canonicalManufacturerId, "");
    assert.equal(resolution.displayName, "");
  }
});

test("section 5 N-5 strips only terminal Japanese product-type annotations", () => {
  for (const [rawModel, expected] of [
    ["No5302 パワーアンプ", "No5302"],
    ["C-2800 プリアンプ", "C-2800"],
    ["GT-2000 ターンテーブル", "GT-2000"],
    ["KC62 サブウーファー", "KC62"],
  ] as const) {
    const result = resolveModel({ rawModel, manufacturerId: "mark-levinson" });
    assert.equal(result.status, "resolved");
    assert.equal(result.model, expected);
    assert.ok(result.removedAnnotations.includes("product_type_suffix"));
  }

  assert.equal(
    resolveModel({ rawModel: "D-1000 MK2 特別仕様", manufacturerId: "luxman" }).status,
    "candidate",
  );
  assert.equal(
    resolveModel({ rawModel: "GT-2000ダストカバー", manufacturerId: "yamaha" }).status,
    "candidate",
  );
});

test("section 5 N-6 preserves the known punctuation collision as ambiguous", () => {
  assert.equal(normalizeIdentityModel("SLH-7-550-BL"), normalizeIdentityModel("SLH-7-550B-L"));
  const resolution = resolveProductIdentity(
    {
      manufacturerId: "sony",
      model: "SLH-7-550-BL",
      modelResolutionStatus: "resolved",
    },
    [
      { id: 1, manufacturerId: "sony", canonicalModel: "SLH-7-550-BL" },
      { id: 2, manufacturerId: "sony", canonicalModel: "SLH-7-550B-L" },
    ],
  );
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.matchMethod, "exact_ambiguous");
});
