import { test } from "vitest";
import assert from "node:assert/strict";
import {
  cleanText,
  parseYen,
  inferStockStatus,
  splitManufacturerModel,
} from "../src/crawler/normalize.js";

test("HTML entities are decoded exactly once", () => {
  assert.equal(cleanText("&lt;strong&gt;"), "<strong>");
  assert.equal(cleanText("&amp;lt;strong&amp;gt;"), "&lt;strong&gt;");
  assert.equal(cleanText("15&#8243; Monitor"), "15″ Monitor");
  assert.equal(cleanText("15&#x2033; Monitor"), "15″ Monitor");
  assert.equal(cleanText("&#165;1,000"), "¥1,000");
  assert.equal(cleanText("invalid &#xD800; entity"), "invalid &#xD800; entity");
});

test("parseYen parses Japanese prices", () => {
  assert.equal(parseYen("￥1,250,000（税込）"), 1250000);
  assert.equal(parseYen("49,900円"), 49900);
  assert.equal(parseYen("E2 / item 027559 / 980,000円（税込）"), 980000);
  assert.equal(parseYen("780000"), 780000);
});

test("parseYen restores thousands groups fragmented by HTML spacing", () => {
  assert.equal(parseYen("¥198 ,000（税込）"), 198000);
  assert.equal(parseYen("¥1 ,198 ,000"), 1198000);
  assert.equal(parseYen("￥１９８ ，０００円"), 198000);
  assert.equal(parseYen("¥198 ,00"), 198);
});

test("stock status is conservative", () => {
  assert.equal(inferStockStatus("在庫あり"), "in_stock");
  assert.equal(inferStockStatus("売り切れ"), "sold_out");
  assert.equal(inferStockStatus("売約済み"), "sold_out");
  assert.equal(inferStockStatus("予約中"), "unknown");
  assert.equal(inferStockStatus("商品情報"), "unknown");
});

test("Ippinkan title splitting removes listing condition markers", () => {
  assert.deepEqual(splitManufacturerModel("LUXMAN - D-10X《JP-u》", "ippinkan"), {
    manufacturer: "LUXMAN",
    model: "D-10X",
  });
  assert.deepEqual(
    splitManufacturerModel("TAD - E2-WN/ウォルナット『展示機』（ペア）《JP-u》", "ippinkan"),
    {
      manufacturer: "TAD",
      model: "E2-WN/ウォルナット（ペア）",
    },
  );
});

test("seller condition badges do not become part of the manufacturer", () => {
  assert.deepEqual(splitManufacturerModel("【中古品】MSB Analog DAC ※送料無料", "shimamusen"), {
    manufacturer: "MSB",
    model: "Analog DAC ※送料無料",
  });
  assert.deepEqual(splitManufacturerModel("[中古品] MSB Analog DAC", "shimamusen"), {
    manufacturer: "MSB",
    model: "Analog DAC",
  });
});

test("Fujiya title splitting keeps multi-word manufacturer names", () => {
  assert.deepEqual(
    splitManufacturerModel(
      "Bowers & Wilkins バウワースアンドウィルキンス FS-700S3/B",
      "fujiya-avic",
    ),
    {
      manufacturer: "Bowers & Wilkins",
      model: "FS-700S3/B",
    },
  );
  assert.deepEqual(
    splitManufacturerModel("iBasso Audio アイバッソオーディオ DC07PRO Black", "fujiya-avic"),
    {
      manufacturer: "iBasso Audio",
      model: "DC07PRO Black",
    },
  );
  assert.deepEqual(
    splitManufacturerModel("水月雨（MoonDrop） スイゲツアメ DISCDREAM 2", "fujiya-avic"),
    {
      manufacturer: "水月雨（MoonDrop）",
      model: "DISCDREAM 2",
    },
  );
});

test("shared title splitting recognizes known multi-word manufacturers", () => {
  assert.deepEqual(splitManufacturerModel("Mark Levinson No.5805", "audiounion"), {
    manufacturer: "Mark Levinson",
    model: "No.5805",
  });
  assert.deepEqual(splitManufacturerModel("Linear Technology Model 1", "example-shop"), {
    manufacturer: "Linear Technology",
    model: "Model 1",
  });
});
