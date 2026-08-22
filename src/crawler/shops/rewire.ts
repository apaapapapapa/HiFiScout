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
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
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
    const rawCategory = sellerCategory(record.text);
    const soldOut = SOLD_PATTERN.test(record.text);
    const metadata: Record<string, unknown> = {};
    const code = record.text.match(SOURCE_CODE_PATTERN)?.[1]?.toUpperCase();
    if (code) metadata.productCode = code;

    products.push({
      sourceId: sourceId(record.text, record.fallbackSourceId),
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: model || title,
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
