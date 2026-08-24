import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://rewire.co.jp";
const LIST_URL = `${BASE_URL}/webshop/category/item/usedvintage/`;
const SOLD_PATTERN = /sold\s*out|売約済(?:み)?|販売終了|在庫なし|完売|品切れ/iu;
const SOURCE_CODE_PATTERN = /[#＃@＠]\s*(R\d{4,})/iu;
const CONDITION_PATTERN =
  /(?:美品|整備済|メンテナンス済|ワンオーナー|未使用|新品同様|現状|ジャンク)/iu;
const PRICE_MARKER_PATTERN = /[¥￥]\s*[0-9]|\bASK\b/iu;
const SELLER_CATEGORIES = [
  "アクセサリー",
  "アナログプレーヤー関連",
  "アナログプレーヤー関連",
  "真空管アンプ",
  "McIntosh",
  "ケーブル",
  "スピーカー",
  "プレーヤー",
  "プレーヤー",
  "楽器&PA関連",
  "電源関連",
  "アンプ",
  "その他",
] as const;

const FLOORSTANDING_MODEL_PATTERNS: readonly RegExp[] = [
  /(?:\btannoy\b|タンノイ)[\s\S]{0,120}\brectangular\s+grf\b|\brectangular\s+grf\b[\s\S]{0,120}(?:\btannoy\b|タンノイ)/iu,
  /(?:\bmcintosh\b|マッキントッシュ)[\s\S]{0,120}\bxrt\s*22\b|\bxrt\s*22\b[\s\S]{0,120}(?:\bmcintosh\b|マッキントッシュ)/iu,
];

const JAPANESE_TEXT_PATTERN = /[ぁ-んァ-ヶ一-龯]/u;
const ENGLISH_PRODUCT_TYPE_SUFFIX =
  /\s+(?:(?:stereo|mono(?:ral)?|tube|line)?\s*(?:power|integrated|pre)?\s*amplifier|preamp|preamplifier|speaker\s+system|sacd\/cd|sacd|cd\s+player|d\/a\s+converter)\b[\s\S]*$/iu;

export interface RewirePage extends CrawlPageObject {
  readonly page: number;
}

interface ProductAnchorRecord {
  sourceUrl: string;
  fallbackSourceId: string;
  text: string;
}

function listingPage(page = 1): RewirePage {
  return {
    url: page <= 1 ? LIST_URL : `${LIST_URL}page/${page}/`,
    page,
  };
}

function visibleText(html: unknown = ""): string {
  return cleanText(
    String(html || "")
      .replace(/<script(?:[\s/][^>]*)?>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, " ")
      .replace(/<style(?:[\s/][^>]*)?>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, " ")
      .replace(/<br\s*\/?>/gi, " "),
  );
}

function canonicalProductLink(
  href: string,
): Pick<ProductAnchorRecord, "sourceUrl" | "fallbackSourceId"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const match = url.pathname.match(/^\/webshop\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/?$/u);
    if (!match) return null;
    url.search = "";
    url.hash = "";
    return {
      sourceUrl: url.toString(),
      fallbackSourceId: `${match[1]}-${match[2]}-${match[3]}-${match[4]}`,
    };
  } catch {
    return null;
  }
}

function productAnchors(html: string): ProductAnchorRecord[] {
  const records = new Map<string, ProductAnchorRecord>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || "").matchAll(anchorRe)) {
    const product = canonicalProductLink(match[3]);
    if (!product) continue;
    const text = visibleText(match[5]);
    if (!text || !PRICE_MARKER_PATTERN.test(text)) continue;

    const existing = records.get(product.sourceUrl);
    if (!existing || text.length > existing.text.length) {
      records.set(product.sourceUrl, { ...product, text });
    }
  }

  return [...records.values()];
}

function sellerCategory(text: string): string {
  const priceIndex = text.search(PRICE_MARKER_PATTERN);
  const categoryRegion = priceIndex >= 0 ? text.slice(priceIndex) : text;
  let result = "";
  let resultIndex = -1;

  for (const category of SELLER_CATEGORIES) {
    const index = categoryRegion.lastIndexOf(category);
    if (index > resultIndex) {
      result = category;
      resultIndex = index;
    }
  }

  return result;
}

function normalizedSellerCategory(title: string, rawSellerCategory: string): string {
  if (FLOORSTANDING_MODEL_PATTERNS.some((pattern) => pattern.test(title))) {
    return "フロア型";
  }
  return rawSellerCategory;
}

/**
 * REWIRE list titles frequently append a translated brand, product type, output specs and sales
 * copy to the actual model. Product cards already render the manufacturer separately, so retain the
 * seller's complete title in `title` while extracting only the model-shaped prefix into `model`.
 */
function conciseRewireModel(rawModel: string): string {
  const original = cleanText(rawModel);
  if (!original) return "";

  let value = original.replace(/^of\s+Oregon\s+/iu, "").trim();
  const japaneseIndex = value.search(JAPANESE_TEXT_PATTERN);
  if (japaneseIndex > 0) {
    const prefix = value.slice(0, japaneseIndex).trim();
    // A Latin/digit prefix followed by Japanese copy is the seller's model presentation followed
    // by its translated brand/category/description. Japanese-only model names start at index 0 and
    // are therefore left untouched.
    if (/[A-Za-z0-9]/u.test(prefix)) value = prefix;
  }

  value = cleanText(value.replace(ENGLISH_PRODUCT_TYPE_SUFFIX, " "));

  // REWIRE sometimes repeats the same model/brand presentation after a slash. Once the left side
  // already contains a model token, the right side is listing presentation rather than identity.
  const slash = value.indexOf(" / ");
  if (slash > 0) {
    const left = value.slice(0, slash).trim();
    if (/\d/u.test(left)) value = left;
  }

  value = value
    .replace(/[\s/／|]+$/u, "")
    .replace(/\s+(?:original\s+pair|mono\s+pair|pair)\s*$/iu, "")
    .replace(/\s+\(\d{4}\)\s*$/u, "")
    .trim();

  return value || original;
}

function conditionAndTitle(cardText: string): { conditionText: string; title: string } {
  let value = cleanText(cardText.replace(/^sold\s*out\s*/iu, ""));
  const priceIndex = value.search(PRICE_MARKER_PATTERN);
  if (priceIndex >= 0) value = value.slice(0, priceIndex).trim();

  value = cleanText(value.replace(SOURCE_CODE_PATTERN, " "));

  const conditions: string[] = [];
  while (true) {
    const match = value.match(/^[〖【]([^〗】]+)[〗】]\s*/u);
    if (!match || !CONDITION_PATTERN.test(match[1])) break;
    conditions.push(cleanText(match[1]));
    value = value.slice(match[0].length).trim();
  }

  return { conditionText: conditions.join(" / "), title: value };
}

function sourceId(cardText: string, fallbackSourceId: string): string {
  return cardText.match(SOURCE_CODE_PATTERN)?.[1]?.toUpperCase() || fallbackSourceId;
}

export function parseRewireListing(html: string): SellerProduct[] {
  const products: SellerProduct[] = [];

  for (const record of productAnchors(html)) {
    const { conditionText, title } = conditionAndTitle(record.text);
    if (!title) continue;

    const { manufacturer, model } = splitManufacturerModel(title, "rewire");
    const rawSellerCategory = sellerCategory(record.text);
    const rawCategory = normalizedSellerCategory(title, rawSellerCategory);
    const soldOut = SOLD_PATTERN.test(record.text);
    const metadata: Record<string, unknown> = {};
    const code = record.text.match(SOURCE_CODE_PATTERN)?.[1]?.toUpperCase();
    if (code) metadata.productCode = code;
    if (rawSellerCategory && rawSellerCategory !== rawCategory) {
      metadata.rewireSellerCategory = rawSellerCategory;
    }

    products.push({
      sourceId: sourceId(record.text, record.fallbackSourceId),
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: conciseRewireModel(model || title),
      rawCategory,
      category: inferCategory(title),
      conditionText,
      priceYen: parseYen(record.text),
      stockStatus: availabilityFromSignals({ soldOut, inStock: !soldOut }),
      metadata,
    });
  }

  return products;
}

export function discoverRewirePageUrls(html: string, page: Partial<RewirePage> = {}): RewirePage[] {
  const currentPage = page.page || 1;
  let maxPage = currentPage;

  for (const match of String(html || "").matchAll(/href\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const url = new URL(match[2], BASE_URL);
      if (url.origin !== BASE_URL) continue;
      const pageMatch = url.pathname.match(
        /^\/webshop\/category\/item\/usedvintage\/page\/(\d+)\/?$/u,
      );
      if (!pageMatch) continue;
      const candidate = Number.parseInt(pageMatch[1], 10);
      if (Number.isFinite(candidate)) maxPage = Math.max(maxPage, candidate);
    } catch {
      continue;
    }
  }

  return Array.from({ length: Math.max(0, maxPage - currentPage) }, (_, index) =>
    listingPage(currentPage + index + 1),
  );
}

export const rewireAdapter = {
  key: "rewire",
  name: "REWIRE",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<RewirePage> {
      yield listingPage();
    },
    discoverTargets(html, page) {
      return page.page === 1 ? discoverRewirePageUrls(html, page) : [];
    },
  },
  parse(html) {
    return parseRewireListing(html);
  },
} satisfies ShopAdapter<RewirePage>;
