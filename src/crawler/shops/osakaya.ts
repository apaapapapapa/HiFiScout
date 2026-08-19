import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://osakaya.com";
const CONDITION_PARAM = "search[c_pt][]";

interface OsakayaEntryPage {
  conditionCode: "2" | "3";
  conditionText: "中古品" | "特価品";
}

interface OsakayaPage extends CrawlPageObject, OsakayaEntryPage {
  page: number;
}

interface ProductAnchorRecord {
  sourceId: string;
  sourceUrl: string;
  categorySlug: string;
  index: number;
  titles: string[];
}

const ENTRY_PAGES: readonly OsakayaEntryPage[] = Object.freeze([
  { conditionCode: "2", conditionText: "中古品" },
  { conditionCode: "3", conditionText: "特価品" },
]);

const SOLD_PATTERN = /SOLD\s*OUT|売り切れ|売切れ|売約済(?:み)?|在庫なし|完売|品切れ|販売終了/iu;
const CONDITION_PATTERN = /(?:中古品|特価品)/gu;

function listingPage(entry: OsakayaEntryPage, page = 1): OsakayaPage {
  const url = new URL("/store/items/", BASE_URL);
  url.searchParams.append(CONDITION_PARAM, entry.conditionCode);
  if (page > 1) url.searchParams.set("page", String(page));
  return { url: url.toString(), page, ...entry };
}

function canonicalProductLink(
  href: string,
): Pick<ProductAnchorRecord, "sourceId" | "sourceUrl" | "categorySlug"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const match = url.pathname.match(/^\/store\/items\/([^/]+)\/(\d+)\/?$/u);
    if (!match) return null;
    url.search = "";
    url.hash = "";
    return {
      categorySlug: match[1],
      sourceId: match[2],
      sourceUrl: url.toString(),
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

function sellerText(record: ProductAnchorRecord): string {
  const candidates = [...new Set(record.titles.map(cleanText).filter(Boolean))];
  return (
    candidates.sort((a, b) => {
      const score = (value: string) =>
        (CONDITION_PATTERN.test(value) ? 1000 : 0) +
        (/[¥￥]\s*[0-9][0-9,]*\s*税込/u.test(value) ? 1000 : 0) +
        Math.min(value.length, 500);
      CONDITION_PATTERN.lastIndex = 0;
      const left = score(a);
      CONDITION_PATTERN.lastIndex = 0;
      const right = score(b);
      CONDITION_PATTERN.lastIndex = 0;
      return right - left;
    })[0] || ""
  );
}

function listingTitle(value: string): string {
  const text = cleanText(value);
  const boundaries = [
    text.search(/(?:中古品|特価品)/u),
    text.search(/標準価格\s*[:：]/u),
    text.search(/(?:[¥￥]\s*[0-9]|オープンプライス)/u),
  ].filter((index) => index > 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : text.length;
  return text.slice(0, end).trim();
}

function currentPrice(text: string): number | null {
  const normalized = cleanText(text).normalize("NFKC");
  const taxedPrices = [...normalized.matchAll(/[¥￥]\s*([0-9][0-9,]*)\s*税込/gu)];
  const taxed = taxedPrices[taxedPrices.length - 1]?.[1];
  if (taxed) return Number.parseInt(taxed.replaceAll(",", ""), 10);

  const explicit = normalized.match(/(?:販売)?価格\s*[:：]\s*[¥￥]\s*([0-9][0-9,]*)/u)?.[1];
  return explicit ? Number.parseInt(explicit.replaceAll(",", ""), 10) : null;
}

function sellerCondition(text: string, page: Partial<OsakayaPage>): string {
  const values = [...text.matchAll(CONDITION_PATTERN)].map((match) => match[0]);
  if (page.conditionText) values.push(page.conditionText);
  return [...new Set(values)].join(" / ");
}

function stripJapaneseBrandPrefix(value: string): string {
  const tokens = cleanText(value).split(/\s+/).filter(Boolean);
  const firstModelToken = tokens.findIndex((token) => /[A-Za-z0-9]/u.test(token));
  if (firstModelToken > 0) return tokens.slice(firstModelToken).join(" ");
  return tokens.join(" ");
}

function manufacturerModel(title: string) {
  const { manufacturer, model } = splitManufacturerModel(title, "osakaya");
  return {
    rawManufacturer: manufacturer,
    manufacturer,
    model: stripJapaneseBrandPrefix(model) || model || title,
  };
}

function resultCount(html: string): number | null {
  const raw = cleanText(html).match(/対象商品数\s*[:：]\s*([0-9][0-9,]*)/u)?.[1];
  return raw ? Number.parseInt(raw.replaceAll(",", ""), 10) : null;
}

function paginationTarget(href: string, label: string, page: Partial<OsakayaPage>): OsakayaPage | null {
  if (!page.conditionCode || !page.conditionText) return null;
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL || !/^\/store\/items\/?$/u.test(url.pathname)) return null;
    if (!url.searchParams.getAll(CONDITION_PARAM).includes(page.conditionCode)) return null;

    const numericLabel = /^\d+$/u.test(label) ? Number.parseInt(label, 10) : null;
    const numericQuery = ["page", "p", "pageno"]
      .map((name) => Number.parseInt(url.searchParams.get(name) || "", 10))
      .find((value) => Number.isFinite(value) && value > 0);
    const pageNumber = numericQuery || numericLabel;
    if (!pageNumber || pageNumber <= 1) return null;

    return {
      url: url.toString(),
      page: pageNumber,
      conditionCode: page.conditionCode,
      conditionText: page.conditionText,
    };
  } catch {
    return null;
  }
}

export function parseOsakayaListing(
  html: string,
  page: Partial<OsakayaPage> = {},
): SellerProduct[] {
  const products: SellerProduct[] = [];

  for (const record of productAnchorRecords(html)) {
    const seller = sellerText(record);
    const title = listingTitle(seller);
    if (!title) continue;

    const { rawManufacturer, manufacturer, model } = manufacturerModel(title);
    const soldOut = SOLD_PATTERN.test(seller);
    products.push({
      sourceId: record.sourceId,
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer,
      manufacturer,
      model,
      rawCategory: record.categorySlug,
      category: inferCategory(title),
      conditionText: sellerCondition(seller, page),
      priceYen: currentPrice(seller),
      stockStatus: availabilityFromSignals({ soldOut, inStock: !soldOut }),
      metadata: {
        categorySlug: record.categorySlug,
        ...(page.conditionCode ? { conditionCode: page.conditionCode } : {}),
      },
    });
  }

  return products;
}

export function discoverOsakayaPageUrls(
  html: string,
  page: Partial<OsakayaPage>,
): OsakayaPage[] | null {
  if (!page.conditionCode || !page.conditionText) return [];
  if ((page.page || 1) !== 1) return [];

  const targets = new Map<number, OsakayaPage>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorRe)) {
    const label = cleanText(match[5]);
    if (!/^(?:\d+|[«»]+)$/u.test(label)) continue;
    const target = paginationTarget(match[3], label, page);
    if (target) targets.set(target.page, target);
  }

  if (targets.size > 0) return [...targets.values()].sort((a, b) => a.page - b.page);

  const total = resultCount(html);
  const itemsOnPage = productAnchorRecords(html).length;
  if (total === null || total <= itemsOnPage) return [];
  if (itemsOnPage <= 0) return null;

  const maxPage = Math.ceil(total / itemsOnPage);
  return Array.from({ length: Math.max(0, maxPage - 1) }, (_, index) =>
    listingPage(
      { conditionCode: page.conditionCode as "2" | "3", conditionText: page.conditionText },
      index + 2,
    ),
  );
}

export const osakayaAdapter = {
  key: "osakaya",
  name: "CAVIN大阪屋",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<OsakayaPage> {
      for (const entry of ENTRY_PAGES) yield listingPage(entry);
    },
    discoverTargets(html, page) {
      return discoverOsakayaPageUrls(html, page);
    },
  },
  parse(html, page) {
    return parseOsakayaListing(html, page);
  },
} satisfies ShopAdapter<OsakayaPage>;
