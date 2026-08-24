import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://www.avac.co.jp";
const LIST_PATH = "/buy/used/products/list";
const SALE_TYPE_USED = "2";

interface AvacCategory {
  readonly id: number;
  readonly rawCategory: string;
}

export interface AvacPage extends CrawlPageObject {
  readonly page: number;
  readonly categoryId: number;
  readonly rawCategory: string;
}

interface ProductAnchorRecord {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly index: number;
  readonly titles: string[];
}

/**
 * AVAC splits a few audio products into its VISUAL hierarchy. Crawl the complete AUDIO bucket plus
 * only the VISUAL leaves that are also HiFiScout product types. Projectors, displays, recorders,
 * disc-video players and soundbars are intentionally outside the collector's scope.
 */
const AUDIO_CATEGORIES: readonly AvacCategory[] = Object.freeze([
  { id: 3007, rawCategory: "中古 -AUDIO製品(全商品)-" },
  { id: 3171, rawCategory: "中古 AVアンプ" },
  { id: 3174, rawCategory: "中古 センタースピーカー" },
  { id: 3175, rawCategory: "中古 サブウーファー" },
]);

const CONDITION_MARKER_PATTERN = /[〖【]\s*(中古|展示処分品|アウトレット)\s*[〗】]/u;
const PRODUCT_CODE_PATTERN = /[〖【]\s*コード\s*([^〗】]+?)\s*[〗】]/u;
const SOLD_PATTERN =
  /この商品は完売しました|完売|売り切れ|売切れ|在庫なし|品切れ|販売終了|売約済(?:み)?/u;
const IN_STOCK_PATTERN = /カートに入れる|[〖【]\s*中古用\s*[〗】]|数量/u;

function listingPage(category: AvacCategory, page = 1): AvacPage {
  const url = new URL(LIST_PATH, BASE_URL);
  url.searchParams.set("category_id", String(category.id));
  if (page > 1) url.searchParams.set("pageno", String(page));
  url.searchParams.set("sale_type", SALE_TYPE_USED);
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
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, " "),
  );
}

function canonicalProductLink(
  href: string,
): Pick<ProductAnchorRecord, "sourceId" | "sourceUrl"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const sourceId = url.pathname.match(/^\/buy\/products\/detail\/(\d+)\/?$/u)?.[1];
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
  const text = cleanText(value);
  const priceIndex = text.search(/[¥￥]\s*[0-9]|[0-9][0-9,]*\s*円/u);
  return priceIndex > 0 ? text.slice(0, priceIndex).trim() : text;
}

function titleScore(value: string): number {
  if (!value || /^(?:詳細|商品詳細|more|image|画像)$/iu.test(value)) return -1;
  return (
    (CONDITION_MARKER_PATTERN.test(value) ? 10_000 : 0) +
    (PRODUCT_CODE_PATTERN.test(value) ? 1_000 : 0) +
    Math.min(value.length, 500)
  );
}

function bestTitle(record: ProductAnchorRecord, blockText: string): string {
  return (
    [...new Set([...record.titles, blockText])]
      .map(listingTitle)
      .filter((value) => value.length >= 3)
      .sort((a, b) => titleScore(b) - titleScore(a))[0] || ""
  );
}

interface ParsedTitle {
  readonly title: string;
  readonly productCode: string;
  readonly rawCategory: string;
  readonly conditionText: string;
}

function parseConditionedTitle(value: string, fallbackCategory: string): ParsedTitle | null {
  const sellerTitle = listingTitle(value);
  const condition = sellerTitle.match(CONDITION_MARKER_PATTERN);
  if (!condition || condition.index === undefined) return null;

  const afterCondition = sellerTitle.slice(condition.index + condition[0].length).trim();
  const code = afterCondition.match(PRODUCT_CODE_PATTERN);
  const codeIndex = code?.index ?? -1;
  const titleEnd = codeIndex >= 0 ? codeIndex : afterCondition.length;
  const categoryStart = codeIndex >= 0 && code ? codeIndex + code[0].length : afterCondition.length;
  const title = cleanText(afterCondition.slice(0, titleEnd))
    .replace(/[-－]\s*送料別途\s*$/u, "")
    .replace(/[-－]\s*特(?:価)?\s*$/u, "")
    .trim();
  if (!title) return null;

  return {
    title,
    productCode: cleanText(code?.[1] || ""),
    rawCategory: cleanText(afterCondition.slice(categoryStart)) || fallbackCategory,
    conditionText: cleanText(condition[1]),
  };
}

function stockStatus(text: string) {
  const soldOut = SOLD_PATTERN.test(text);
  return availabilityFromSignals({
    soldOut,
    inStock: !soldOut && IN_STOCK_PATTERN.test(text),
  });
}

export function parseAvacListing(html: string, page: Partial<AvacPage> = {}): SellerProduct[] {
  const records = productAnchorRecords(html);
  const products: SellerProduct[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const end = records[index + 1]?.index ?? String(html).length;
    const blockText = visibleText(String(html).slice(record.index, end));
    const parsedTitle = parseConditionedTitle(bestTitle(record, blockText), page.rawCategory || "");

    // AVAC's `sale_type=2` pages mix 中古, 展示処分品 and アウトレット. These three explicit
    // seller condition markers are the authoritative inclusion rule; unrelated conditions stay out.
    if (!parsedTitle) continue;

    const { manufacturer, model } = splitManufacturerModel(parsedTitle.title, "avac");
    const metadata: Record<string, unknown> = {};
    if (parsedTitle.productCode) metadata.productCode = parsedTitle.productCode;
    if (page.rawCategory) metadata.avacBrowseCategory = page.rawCategory;

    products.push({
      sourceId: record.sourceId,
      sourceUrl: record.sourceUrl,
      title: parsedTitle.title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: model || parsedTitle.title,
      rawCategory: parsedTitle.rawCategory,
      category: inferCategory(`${parsedTitle.rawCategory} ${parsedTitle.title}`),
      conditionText: parsedTitle.conditionText,
      priceYen: parseYen(blockText),
      stockStatus: stockStatus(blockText),
      metadata,
    });
  }

  return products;
}

export function discoverAvacPageUrls(html: string, page: Partial<AvacPage>): AvacPage[] {
  if (!page.categoryId || !page.rawCategory) return [];
  const currentPage = page.page || 1;
  let maxPage = currentPage;

  for (const match of String(html || "").matchAll(/href\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const url = new URL(match[2], BASE_URL);
      if (url.origin !== BASE_URL || url.pathname !== LIST_PATH) continue;
      if (url.searchParams.get("category_id") !== String(page.categoryId)) continue;
      const saleType = url.searchParams.get("sale_type");
      if (saleType && saleType !== SALE_TYPE_USED) continue;
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

export const avacAdapter = {
  key: "avac",
  name: "アバック",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<AvacPage> {
      for (const category of AUDIO_CATEGORIES) yield listingPage(category);
    },
    discoverTargets(html, page) {
      if (page.page !== 1) return [];
      return discoverAvacPageUrls(html, page);
    },
  },
  parse(html, page) {
    return parseAvacListing(html, page);
  },
} satisfies ShopAdapter<AvacPage>;
