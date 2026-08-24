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
const STOCK_PATTERN = /在庫あり|販売済|売約済(?:み)?|売り切れ|売切れ|在庫なし|完売|品切れ/i;
const SELLER_CONDITION_PREFIX_PATTERN =
  /^(?:[〖【]\s*(?:開封未使用|未使用|新品|[SABC]ランク|現状|ジャンク)\s*[〗】]\s*)+/iu;
const CONDITION_MARKER_PATTERN = /[〖【]([^〗】]+)[〗】]/gu;
const SELLER_CONDITION_PATTERN = /^(?:開封未使用|未使用|新品|[SABC]ランク|現状|ジャンク)$/iu;
const ANY_CONDITION_MARKER_PATTERN = /[〖【][^〗】]+[〗】]/u;

/**
 * Afro Audio titles are presentation strings of the form
 *   manufacturer + model + product type + translated manufacturer.
 * The product type and translated manufacturer are useful evidence in `title`, but they are not
 * part of the model shown on a HiFiScout card. Keep the markers deliberately category-shaped so
 * descriptive model names such as "Acoustic Resolution Exciter" remain untouched.
 */
const SELLER_PRODUCT_TYPE_MARKERS: readonly RegExp[] = [
  /\s+(?:SACD\/CD|SACD|CD)(?:デッキ|プレーヤー)/iu,
  /\s+(?:プリメイン|パワー|プリアンプ|真空管)アンプ/u,
  /\s+パッシブコントローラー/u,
  /\s+フォノイコライザー/u,
  /\s+(?:MC|MM)カートリッジ/iu,
  /\s+カートリッジ/u,
  /\s+ターンテーブル/u,
  /\s+スピーカー/u,
  /\s+ヘッド(?:ホン|フォン)/u,
  /\s+昇圧トランス/u,
  /\s+仮想アース/u,
  /\s+オプションボード/u,
  /\s+アームベース/u,
  /\s+セレクター/u,
  /\s+電源(?:ユニット)?/u,
  /\s+(?:RCA|XLR|USB|LAN|同軸|デジタル|電源)?ケーブル/iu,
  /\s+(?:RCA|XLR)?アダプター(?:ペア)?/iu,
];

const MODEL_PREFIX_OVERRIDES: readonly {
  manufacturer: RegExp;
  prefix: RegExp;
}[] = [
  { manufacturer: /^アスカ$/u, prefix: /^ASUKA\s+/iu },
  { manufacturer: /^光城精工$/u, prefix: /^KOJO(?:\s+TECHNOLOGY)?\s+/iu },
];

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
      .replace(/<script(?:[ \t\n\f\r/][^>]*)?>[\s\S]*?<\/script(?:[ \t\n\f\r/][^>]*)?>/gi, " ")
      .replace(/<style(?:[ \t\n\f\r/][^>]*)?>[\s\S]*?<\/style(?:[ \t\n\f\r/][^>]*)?>/gi, " ")
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
  let text = cleanText(value)
    .replace(/^NEW\s+/iu, "")
    .trim();
  const productCode = text.search(/\s@\s*\d+/u);
  if (productCode > 0) text = text.slice(0, productCode).trim();
  else {
    const price = text.search(/(?:[¥￥]\s*[0-9]|[0-9][0-9,]*\s*円)/u);
    if (price > 0) text = text.slice(0, price).trim();
  }
  return text;
}

function canonicalTitle(value: string): string {
  return cleanText(value.replace(SELLER_CONDITION_PREFIX_PATTERN, " "));
}

function titleScore(value: string): number {
  if (!value || /^(?:詳細|商品詳細|more|image|画像)$/iu.test(value)) return -1;
  return (ANY_CONDITION_MARKER_PATTERN.test(value) ? 1000 : 0) + Math.min(value.length, 300);
}

function bestTitle(record: ProductAnchorRecord, blockText: string): string {
  return (
    [...new Set([...record.titles, blockText])]
      .map(listingTitle)
      .filter((value) => value.length >= 3)
      .sort((a, b) => titleScore(b) - titleScore(a))[0] || ""
  );
}

function conditionText(title: string): string {
  return [...title.matchAll(CONDITION_MARKER_PATTERN)]
    .map((match) => cleanText(match[1]))
    .filter((value) => SELLER_CONDITION_PATTERN.test(value))
    .join(" / ");
}

function stockStatus(text: string) {
  const priceIndex = text.search(/[¥￥]\s*[0-9]/u);
  const statusRegion = (priceIndex >= 0 ? text.slice(priceIndex) : text).slice(0, 160);
  const firstStatus = statusRegion.match(STOCK_PATTERN)?.[0] || "";
  const soldOut = SOLD_PATTERN.test(firstStatus);
  const inStock = /在庫あり/u.test(firstStatus);
  return availabilityFromSignals({ soldOut, inStock });
}

function productCode(text: string): string {
  return text.match(/@\s*(\d+)/u)?.[1] || "";
}

function conciseAfroAudioModel(rawModel: string, manufacturer: string): string {
  const original = cleanText(rawModel);
  if (!original) return "";

  let value = original
    .replace(/\s*@\s*\d+(?:\s+\d+)?[\s\S]*$/u, "")
    .replace(/\s*[〖【][^〗】]+[〗】]\s*$/u, "")
    .trim();

  for (const override of MODEL_PREFIX_OVERRIDES) {
    if (override.manufacturer.test(manufacturer)) {
      value = value.replace(override.prefix, "").trim();
    }
  }

  const markerIndexes = SELLER_PRODUCT_TYPE_MARKERS.map((pattern) => value.search(pattern)).filter(
    (index) => index >= 0,
  );
  if (markerIndexes.length > 0) {
    value = value.slice(0, Math.min(...markerIndexes)).trim();
  }

  return value || original;
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
    const sellerTitle = bestTitle(record, blockText);
    const title = canonicalTitle(sellerTitle);
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
      model: conciseAfroAudioModel(model || title, manufacturer),
      rawCategory: page.rawCategory || "",
      category: inferCategory(title),
      conditionText: conditionText(sellerTitle),
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
