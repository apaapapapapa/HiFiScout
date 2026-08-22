import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://www.tereon-tsuhan.com";

type TereonConditionCode = "003" | "004";

interface TereonEntryPage {
  conditionCode: TereonConditionCode;
  conditionText: "展示品・開封品" | "中古品";
}

interface TereonPage extends CrawlPageObject, TereonEntryPage {
  page: number;
}

interface ProductAnchorRecord {
  sourceId: string;
  sourceUrl: string;
  index: number;
  titles: string[];
}

const ENTRY_PAGES: readonly TereonEntryPage[] = Object.freeze([
  { conditionCode: "004", conditionText: "中古品" },
  { conditionCode: "003", conditionText: "展示品・開封品" },
]);

const SOLD_PATTERN = /SOLD\s*OUT|売り切れ|売切れ|売約済(?:み)?|在庫なし|完売|品切れ|販売終了/iu;
const CONDITION_PREFIX_PATTERN = /^(中古品|展示品|新品特価)\s*[：:；;]?\s*/u;

function listingPage(entry: TereonEntryPage, page = 1): TereonPage {
  const pathname =
    page > 1
      ? `/shopbrand/${entry.conditionCode}/X/page${page}/order/`
      : `/shopbrand/${entry.conditionCode}/X/`;
  return { url: new URL(pathname, BASE_URL).toString(), page, ...entry };
}

function canonicalProductLink(
  href: string,
): Pick<ProductAnchorRecord, "sourceId" | "sourceUrl"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const match = url.pathname.match(/^\/shopdetail\/(\d+)(?:\/.*)?$/u);
    if (!match) return null;
    return {
      sourceId: match[1],
      sourceUrl: new URL(`/shopdetail/${match[1]}/`, BASE_URL).toString(),
    };
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
    const title = cleanText(match[5]);
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

function sellerTitle(record: ProductAnchorRecord): string {
  const candidates = [...new Set(record.titles.map(cleanText).filter(Boolean))];
  const score = (value: string) =>
    (CONDITION_PREFIX_PATTERN.test(value) ? 1000 : 0) + Math.min(value.length, 500);
  return candidates.sort((a, b) => score(b) - score(a))[0] || "";
}

function listingTitle(value: string): string {
  return cleanText(value).replace(CONDITION_PREFIX_PATTERN, "").trim();
}

function sellerCondition(rawTitle: string, page: Partial<TereonPage>): string {
  return cleanText(rawTitle).match(CONDITION_PREFIX_PATTERN)?.[1] || page.conditionText || "";
}

function manufacturerModel(title: string) {
  const { manufacturer, model } = splitManufacturerModel(title, "tereon");
  return {
    rawManufacturer: manufacturer,
    manufacturer,
    // Tereon appends colour, carton and cosmetic notes in parentheses. Keep the stable model stem
    // so black/silver and other finish variants can resolve to the same catalog product.
    model: cleanText(model).replace(/\s*[（(].*$/u, "").trim() || cleanText(model),
  };
}

function resultCount(html: string): number | null {
  const raw = cleanText(html).match(/全\s*([0-9][0-9,]*)\s*件/u)?.[1];
  return raw ? Number.parseInt(raw.replaceAll(",", ""), 10) : null;
}

function paginationTarget(href: string, page: Partial<TereonPage>): TereonPage | null {
  if (!page.conditionCode || !page.conditionText) return null;
  try {
    const url = new URL(href, page.url || BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const match = url.pathname.match(/^\/shopbrand\/(003|004)\/X\/page(\d+)\/order\/?$/u);
    if (!match || match[1] !== page.conditionCode) return null;
    const pageNumber = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pageNumber) || pageNumber <= 1) return null;
    return listingPage(
      { conditionCode: page.conditionCode, conditionText: page.conditionText },
      pageNumber,
    );
  } catch {
    return null;
  }
}

export function parseTereonListing(
  html: string,
  page: Partial<TereonPage> = {},
): SellerProduct[] {
  const records = productAnchorRecords(html);
  const products: SellerProduct[] = [];

  for (const [index, record] of records.entries()) {
    const rawTitle = sellerTitle(record);
    const title = listingTitle(rawTitle);
    if (!title) continue;

    const nextIndex = records[index + 1]?.index ?? String(html || "").length;
    const seller = cleanText(String(html || "").slice(record.index, nextIndex));
    const { rawManufacturer, manufacturer, model } = manufacturerModel(title);
    const soldOut = SOLD_PATTERN.test(seller);

    products.push({
      sourceId: record.sourceId,
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer,
      manufacturer,
      model,
      rawCategory: "",
      category: inferCategory(`${title} ${model}`),
      conditionText: sellerCondition(rawTitle, page),
      priceYen: parseYen(seller),
      stockStatus: availabilityFromSignals({ soldOut, inStock: !soldOut }),
      metadata: page.conditionCode ? { conditionCategoryCode: page.conditionCode } : {},
    });
  }

  return products;
}

export function discoverTereonPageUrls(
  html: string,
  page: Partial<TereonPage>,
): TereonPage[] | null {
  if (!page.conditionCode || !page.conditionText) return [];
  if ((page.page || 1) !== 1) return [];

  const entry: TereonEntryPage = {
    conditionCode: page.conditionCode,
    conditionText: page.conditionText,
  };
  const records = productAnchorRecords(html);
  const total = resultCount(html);
  if (total !== null) {
    if (total <= records.length) return [];
    if (records.length <= 0) return null;
    const maxPage = Math.ceil(total / records.length);
    return Array.from({ length: Math.max(0, maxPage - 1) }, (_, index) =>
      listingPage(entry, index + 2),
    );
  }

  const targets = new Map<number, TereonPage>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorRe)) {
    const target = paginationTarget(match[3], page);
    if (target) targets.set(target.page, target);
  }
  return [...targets.values()].sort((a, b) => a.page - b.page);
}

export const tereonAdapter = {
  key: "tereon",
  name: "テレオン",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<TereonPage> {
      for (const entry of ENTRY_PAGES) yield listingPage(entry);
    },
    discoverTargets(html, page) {
      return discoverTereonPageUrls(html, page);
    },
  },
  parse(html, page) {
    return parseTereonListing(html, page);
  },
} satisfies ShopAdapter<TereonPage>;
