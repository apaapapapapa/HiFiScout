import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://afroaudio.jp";

interface AfroAudioCategory {
  id: number;
  rawCategory: string;
}

interface AfroAudioPage extends CrawlPageObject {
  page: number;
  categoryId: number;
  rawCategory: string;
}

interface ProductAnchorRecord {
  sourceId: string;
  sourceUrl: string;
  index: number;
  titles: string[];
}

/**
 * Top-level categories that belong to HiFiScout's audio scope. Afro Audio also sells cameras,
 * musical instruments, software and recording/PA equipment; those are intentionally excluded.
 * Condition buckets such as 現状/ジャンク and 販売済 overlap these product categories, so crawling
 * them separately would only duplicate listings.
 */
const AUDIO_CATEGORIES: readonly AfroAudioCategory[] = Object.freeze([
  { id: 1, rawCategory: "プレーヤー" },
  { id: 19, rawCategory: "アンプ" },
  { id: 3, rawCategory: "スピーカー・ヘッドフォン" },
  { id: 4, rawCategory: "デジタル機器・コンバーター類" },
  { id: 5, rawCategory: "アナログパーツ・フォノイコライザー" },
  { id: 6, rawCategory: "ケーブル類" },
  { id: 7, rawCategory: "電源" },
  { id: 8, rawCategory: "ラック・その他" },
  { id: 15, rawCategory: "真空管" },
]);

const SOLD_PATTERN = /販売済|売約済(?:み)?|売り切れ|売切れ|在庫なし|完売|品切れ/i;

function listingPage(category: AfroAudioCategory, page = 1): AfroAudioPage {
  const url = new URL("/products/list", BASE_URL);
  url.searchParams.set("category_id", String(category.id));
  if (page > 1) url.searchParams.set("pageno", String(page));
  return {
    url: url.toString(),
    page,
    categoryId: category.id,
    rawCategory: category.rawCategory,
  };
}

function visibleText(html: unknown = ""): string {
  return cleanText(
    String(html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " "),
  );
}

function canonicalProductLink(
  href: string,
): Pick<ProductAnchorRecord, "sourceId" | "sourceUrl"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const sourceId = url.pathname.match(/^\/products\/detail\/(\d+)\/?$/u)?.[1];
    if (!sourceId) return null;
    url.search = "";
    url.hash = "";
    return { sourceId, sourceUrl: url.toString() };
  } catch {
    return null;
  }
}

function productAnchorRecords(html: string): ProductAnchorRecord[] {
  const records = new Map<string, ProductAnchorRecord>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || "").matchAll(anchorRe)) {
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

function listingTitle(value: string): string {
  let text = cleanText(value).replace(/^NEW\s+/iu, "").trim();
  const productCode = text.search(/\s@\s*\d+/u);
  if (productCode > 0) text = text.slice(0, productCode).trim();
  else {
    const price = text.search(/(?:[¥￥]\s*[0-9]|[0-9][0-9,]*\s*円)/u);
    if (price > 0) text = text.slice(0, price).trim();
  }
  return text;
}

function titleScore(value: string): number {
  if (!value || /^(?:詳細|商品詳細|more|image|画像)$/iu.test(value)) return -1;
  return (/〖[^〗]+〗/u.test(value) ? 1000 : 0) + Math.min(value.length, 300);
}

function bestTitle(record: ProductAnchorRecord, blockText: string): string {
  return [...new Set([...record.titles, blockText])]
    .map(listingTitle)
    .filter((value) => value.length >= 3)
    .sort((a, b) => titleScore(b) - titleScore(a))[0] || "";
}

function conditionText(title: string): string {
  return [...title.matchAll(/〖([^〗]+)〗/gu)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
    .join(" / ");
}

function stockStatus(text: string) {
  const soldOut = SOLD_PATTERN.test(text);
  const inStock = !soldOut && /在庫あり/u.test(text);
  return availabilityFromSignals({ soldOut, inStock });
}

function productCode(text: string): string {
  return text.match(/@\s*(\d+)/u)?.[1] || "";
}

export function parseAfroAudioListing(
  html: string,
  page: Partial<AfroAudioPage> = {},
): SellerProduct[] {
  const records = productAnchorRecords(html);
  const products: SellerProduct[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const end = records[index + 1]?.index ?? String(html).length;
    const blockText = visibleText(String(html).slice(record.index, end));
    const title = bestTitle(record, blockText);
    if (!title) continue;

    const { manufacturer, model } = splitManufacturerModel(title, "afroaudio");
    const code = productCode(blockText);
    const metadata: Record<string, unknown> = {};
    if (code) metadata.productCode = code;

    products.push({
      sourceId: record.sourceId,
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: model || title,
      rawCategory: page.rawCategory || "",
      category: inferCategory(title),
      conditionText: conditionText(title),
      priceYen: parseYen(blockText),
      stockStatus: stockStatus(blockText),
      metadata,
    });
  }

  return products;
}

export function discoverAfroAudioPageUrls(
  html: string,
  page: Partial<AfroAudioPage>,
): AfroAudioPage[] {
  if (!page.categoryId || !page.rawCategory) return [];
  const currentPage = page.page || 1;
  let maxPage = currentPage;

  for (const match of String(html || "").matchAll(/href\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const url = new URL(match[2], BASE_URL);
      if (url.origin !== BASE_URL || url.pathname !== "/products/list") continue;
      if (url.searchParams.get("category_id") !== String(page.categoryId)) continue;
      const candidate = Number.parseInt(url.searchParams.get("pageno") || "1", 10);
      if (Number.isFinite(candidate)) maxPage = Math.max(maxPage, candidate);
    } catch {
      continue;
    }
  }

  const category = { id: page.categoryId, rawCategory: page.rawCategory };
  return Array.from({ length: Math.max(0, maxPage - currentPage) }, (_, index) =>
    listingPage(category, currentPage + index + 1),
  );
}

export const afroAudioAdapter = {
  key: "afroaudio",
  name: "アフロオーディオ",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<AfroAudioPage> {
      for (const category of AUDIO_CATEGORIES) yield listingPage(category);
    },
    discoverTargets(html, page) {
      if (page.page !== 1) return [];
      return discoverAfroAudioPageUrls(html, page);
    },
  },
  parse(html, page) {
    return parseAfroAudioListing(html, page);
  },
} satisfies ShopAdapter<AfroAudioPage>;
