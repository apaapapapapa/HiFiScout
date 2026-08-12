import { cleanText, inferCategory, parseYen } from "../normalize.js";

const BASE_URL = "https://www.u-audio.com";
const PAGE_SIZE = 40;

const CATEGORY_PAGES = Object.freeze([
  { code: "ct4", rawCategory: "中古スピーカー" },
  { code: "ct5", rawCategory: "中古プリアンプ" },
  { code: "ct6", rawCategory: "中古パワーアンプ" },
  { code: "ct7", rawCategory: "中古プリメインアンプ" },
  { code: "ct8", rawCategory: "中古デジタル機器関連" },
  { code: "ct9", rawCategory: "中古アナログ関連" },
  { code: "ct10", rawCategory: "中古アクセサリー" },
  { code: "ct18", rawCategory: "アウトレット", outlet: true },
]);

const OUTLET_PAGE = CATEGORY_PAGES.find((category) => category.outlet);
const USED_PAGES = CATEGORY_PAGES.filter((category) => !category.outlet);

const U_AUDIO_CATEGORY_MAPPING = Object.freeze({
  中古プリアンプ: "pre_amp",
  中古パワーアンプ: "power_amp",
  中古プリメインアンプ: "integrated_amp",
});

const SELLER_NOTE_SUFFIX = /\s*(?:※\s*)?(?:商談中|売約済(?:み)?|展示処分品?|展示処分|メーカ(?:ー)?デモ機処分(?:品)?(?:\s*[0-9０-９一二三四五六七八九十]+ペア)?|メーカ(?:ー)?デモ(?:機)?|デモ機処分(?:品)?|デモ|再生品|最終在庫|別売りケーブル付き)\s*$/i;

function listingPage(category, page = 1) {
  const suffix = page > 1 ? `?page=${page}` : "";
  return {
    url: `${BASE_URL}/view/category/${category.code}${suffix}`,
    page,
    categoryCode: category.code,
    rawCategory: category.rawCategory,
    outlet: category.outlet === true,
  };
}

function additionalPages(page, count) {
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const category = {
    code: page.categoryCode,
    rawCategory: page.rawCategory,
    outlet: page.outlet === true,
  };
  return Array.from({ length: totalPages - 1 }, (_, index) => listingPage(category, index + 2));
}

function canonicalProductLink(href) {
  try {
    const url = new URL(href, BASE_URL);
    if (url.hostname !== "www.u-audio.com") return null;
    const sourceId = url.pathname.match(/^\/view\/item\/(\d+)\/?$/i)?.[1];
    if (!sourceId) return null;
    url.search = "";
    url.hash = "";
    return { sourceId, sourceUrl: url.toString() };
  } catch {
    return null;
  }
}

function visibleText(html = "") {
  return cleanText(
    String(html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " "),
  );
}

function productAnchorRecords(html = "") {
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  const records = new Map();

  for (const match of String(html).matchAll(anchorRe)) {
    const product = canonicalProductLink(match[3]);
    if (!product) continue;
    const title = visibleText(match[5]);
    const existing = records.get(product.sourceId);
    if (existing) {
      if (title) existing.titles.push(title);
      continue;
    }
    records.set(product.sourceId, {
      ...product,
      index: match.index || 0,
      titles: title ? [title] : [],
    });
  }

  return [...records.values()].sort((a, b) => a.index - b.index);
}

function titleScore(value = "") {
  return (/\s\/\s/.test(value) ? 1000 : 0) + Math.min(value.length, 300);
}

function bestTitle(record) {
  return (
    [...new Set(record.titles)]
      .map(cleanText)
      .filter((value) => value.length >= 3 && !/^(?:image|画像|詳細|more)$/i.test(value))
      .sort((a, b) => titleScore(b) - titleScore(a))[0] || ""
  );
}

function stripSellerNotes(value = "") {
  let result = cleanText(value);
  let previous = "";
  while (result && result !== previous) {
    previous = result;
    result = result.replace(SELLER_NOTE_SUFFIX, "").trim();
  }
  return result;
}

function manufacturerAndModel(title = "") {
  const value = cleanText(title);
  const separator = value.lastIndexOf(" / ");
  if (separator < 0) return { manufacturer: "", model: stripSellerNotes(value) };
  return {
    model: stripSellerNotes(value.slice(0, separator)),
    manufacturer: stripSellerNotes(value.slice(separator + 3)),
  };
}

function salePrice(text = "") {
  const match = text.match(
    /販売価格(?:（税込）|\(税込\))?\s*(￥\s*[0-9][0-9,]*|¥\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円|お問い合わせください|－|—|-)/i,
  );
  const value = cleanText(match?.[1] || "");
  if (!value || /お問い合わせ|^[－—-]$/.test(value)) return null;
  return parseYen(value);
}

function boundedProductText(html = "") {
  const text = visibleText(html);
  const action = text.match(/カートに入れる|お問い合わせ|売り切れ|売切れ/i);
  return action ? text.slice(0, (action.index || 0) + action[0].length) : text;
}

function productCode(text = "") {
  return text.match(/商品コード\s*([A-Za-z0-9][A-Za-z0-9_-]*)/i)?.[1] || "";
}

function conditionText(title, text, { outlet = false } = {}) {
  const source = `${title} ${text}`;
  const conditions = [];
  if (/商談中/.test(source)) conditions.push("商談中");
  if (/売約済/.test(source)) conditions.push("売約済");
  if (/展示処分品|展示処分/.test(source)) conditions.push("展示処分");
  else if (/メーカ(?:ー)?デモ機処分|デモ機処分/.test(source)) conditions.push("デモ機処分");
  else if (/メーカ(?:ー)?デモ|\bデモ\b/.test(source)) conditions.push("デモ");
  if (/再生品/.test(source)) conditions.push("再生品");
  if (/最終在庫/.test(source)) conditions.push("最終在庫");
  if (outlet) conditions.push("アウトレット");
  return [...new Set(conditions)].join(" / ");
}

function stockStatus(title, text) {
  const source = `${title} ${text}`;
  if (/SOLD\s*OUT|売り切れ|売切れ|売約済|在庫なし|完売|品切れ/i.test(source)) {
    return "sold_out";
  }
  return "in_stock";
}

export function parseUAudioResultCount(html) {
  const match = visibleText(html).match(/全\s*([0-9][0-9,，]*)\s*件/);
  return match ? Number.parseInt(match[1].replace(/[，,]/g, ""), 10) : null;
}

export function parseUAudioListing(html, page = {}) {
  const records = productAnchorRecords(html);
  const products = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const end = records[index + 1]?.index ?? String(html).length;
    const blockText = boundedProductText(String(html).slice(record.index, end));
    const title = bestTitle(record);
    if (!title) continue;

    const { manufacturer, model } = manufacturerAndModel(title);
    if (!model) continue;
    const code = productCode(blockText);
    const metadata = {};
    if (code) metadata.productCode = code;
    if (page.outlet === true) metadata.outlet = true;

    products.push({
      sourceId: record.sourceId,
      rawManufacturer: manufacturer,
      manufacturer,
      model,
      title,
      rawCategory: page.rawCategory || "",
      category: inferCategory(title),
      conditionText: conditionText(title, blockText, page),
      priceYen: salePrice(blockText),
      stockStatus: stockStatus(title, blockText),
      sourceUrl: record.sourceUrl,
      metadata,
    });
  }

  return products;
}

export const uAudioAdapter = {
  key: "u-audio",
  name: "U-AUDIO",
  baseUrl: BASE_URL,
  categoryMapping: U_AUDIO_CATEGORY_MAPPING,
  categoryPolicy: Object.freeze({
    sellerCategory: Object.freeze({ default: "authoritative" }),
    parserHint: "corroborative",
  }),
  dynamicPagination: true,
  continueOnEmpty: true,
  *pageUrls() {
    yield { ...listingPage(OUTLET_PAGE, 1), bootstrap: true };
  },
  discoverPageUrls(html, page) {
    if (page.bootstrap) {
      const count = parseUAudioResultCount(html);
      if (count == null) throw new Error("U-AUDIO outlet result count not found");
      return [
        ...additionalPages(page, count),
        ...USED_PAGES.map((category) => listingPage(category, 1)),
      ];
    }
    if (page.page !== 1) return [];
    const count = parseUAudioResultCount(html);
    if (count == null) return null;
    return additionalPages(page, count);
  },
  parse(html, page) {
    return parseUAudioListing(html, page);
  },
};
