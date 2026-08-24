import { stripManufacturerListingLabels } from "../../catalog/manufacturers.js";
import { availabilityFromSignals } from "../availability.js";
import { stripRawTextElements } from "../../html/raw-text.js";
import { cleanText, parseYen, splitManufacturerModel } from "../normalize.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

interface ShimamusenPage {
  url: string;
  kind: string;
}

interface ProductAnchor {
  sourceId: string;
  sourceUrl: string;
  title: string;
  index: number;
  end: number;
}

interface ProductBlock {
  sourceId: string;
  sourceUrl: string;
  title: string;
  html: string;
}

const BASE_URL = "https://www.shimamusen.com";
const DISPLAY_URL = `${BASE_URL}/shopbrand/063/Y/`;
const SALE_URL = `${BASE_URL}/shopbrand/036/Y/`;
const USED_URL = `${BASE_URL}/shopbrand/ct826/`;
const MARKETING_PREFIX = /^(?:(?:【(?:開封品|店頭在庫品処分セール|期間限定特価)】)\s*)+/u;
const REFURBISHED_PREFIX = /^メーカー新装商品\s*/u;
const LISTING_INDEX_PREFIX = /^[①-⑳]\s*/u;

function absoluteUrl(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);
    return url.hostname === "www.shimamusen.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stripTags(html = ""): string {
  return cleanText(
    stripRawTextElements(html)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function cleanedAnchorText(html = ""): string {
  return stripTags(html);
}

function productIdentityText(value: string): string {
  let result = String(value).trim();
  let previous = "";
  while (result && result !== previous) {
    previous = result;
    result = stripManufacturerListingLabels(result)
      .replace(MARKETING_PREFIX, "")
      .replace(REFURBISHED_PREFIX, "")
      .replace(LISTING_INDEX_PREFIX, "")
      .trim();
  }
  return cleanText(result);
}

function pageKind(page: Partial<ShimamusenPage> | string | undefined): string {
  if (typeof page === "object" && page?.kind) return page.kind;
  const url = typeof page === "string" ? page : page?.url || "";
  if (/\/063\/Y\/?/i.test(url)) return "展示処分品";
  if (/\/036\/Y\/?/i.test(url)) return "特価商品";
  return "中古品";
}

function productAnchors(html: string): ProductAnchor[] {
  const anchors: ProductAnchor[] = [];
  const re =
    /<a\b([^>]*\bhref\s*=\s*["']([^"']*\/shopdetail\/(\d+)\/[^"']*)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(re)) {
    const sourceUrl = absoluteUrl(match[2]);
    if (!sourceUrl) continue;
    anchors.push({
      sourceId: match[3],
      sourceUrl,
      title: cleanedAnchorText(match[4]),
      index: match.index || 0,
      end: (match.index || 0) + match[0].length,
    });
  }
  return anchors;
}

function distinctProductBlocks(html: string): ProductBlock[] {
  const anchors = productAnchors(html);
  const orderedIds: string[] = [];
  const grouped = new Map<string, ProductAnchor[]>();

  for (const anchor of anchors) {
    if (!grouped.has(anchor.sourceId)) {
      grouped.set(anchor.sourceId, []);
      orderedIds.push(anchor.sourceId);
    }
    grouped.get(anchor.sourceId)?.push(anchor);
  }

  return orderedIds.map((sourceId, index) => {
    const current = grouped.get(sourceId);
    if (!current?.length) throw new Error(`missing product anchors for ${sourceId}`);
    const titleAnchor = current.find((anchor) => anchor.title) || current[0];
    const nextId = orderedIds[index + 1];
    const nextAnchors = nextId ? grouped.get(nextId) : null;
    const blockStart = Math.max(0, current[0].index - 500);
    const blockEnd = nextAnchors
      ? nextAnchors[0].index
      : Math.min(String(html).length, current[current.length - 1].end + 1600);
    return {
      sourceId,
      sourceUrl: titleAnchor.sourceUrl,
      title: titleAnchor.title,
      html: String(html).slice(blockStart, blockEnd),
    };
  });
}

function manufacturerFromBlock(blockHtml: string, title: string): string {
  const explicit = String(blockHtml).match(
    /<(?:span|p|div|li)\b[^>]*class=["'][^"']*(?:maker|manufacturer|brand)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|p|div|li)>/i,
  )?.[1];
  const explicitText = productIdentityText(stripTags(explicit || ""));
  if (explicitText && explicitText.length <= 80) return explicitText;
  return splitManufacturerModel(productIdentityText(title), "shimamusen").manufacturer || "";
}

function modelFromTitle(title: string): string {
  const identityText = productIdentityText(title);
  return splitManufacturerModel(identityText, "shimamusen").model || identityText;
}

function extractPrice(blockHtml: string): number | null {
  const text = stripTags(blockHtml);
  const match =
    text.match(/(?:販売価格\s*)?([\d,]+)円(?:\s*\(税込\))?/i) || text.match(/([\d,]+)円\s*[～〜]/i);
  return match ? parseYen(match[1]) : null;
}

function stockStatusFor(title: string, blockHtml: string) {
  const text = `${title} ${stripTags(blockHtml)}`;
  const soldOut = /売り切れ|売切れ|SOLD\s*OUT|在庫なし|完売|販売終了/i.test(text);
  const ordered = /お取り寄せ/.test(title);
  return availabilityFromSignals({ soldOut, inStock: !soldOut && !ordered });
}

function conditionFor(kind: string, title: string, blockHtml: string): string {
  const parts = [kind];
  if (/未使用開封品/.test(title)) parts.push("未使用開封品");
  else if (/【開封品】/.test(title)) parts.push("開封品");
  else if (/B級品/.test(title)) parts.push("B級品");
  else if (/展示処分品|現品処分品/.test(title)) parts.push("展示処分品");
  if (/メーカー新装商品/.test(title)) parts.push("メーカー新装商品");
  if (/期間限定特価/.test(title)) parts.push("期間限定特価");
  if (/店頭在庫品処分セール/.test(title)) parts.push("店頭在庫品処分セール");
  if (/商談中|予約中/.test(stripTags(blockHtml))) parts.push("商談中");
  return [...new Set(parts)].join(" / ");
}

export function parseShimamusenListing(
  html: string,
  page?: Partial<ShimamusenPage> | string,
): SellerProduct[] {
  const kind = pageKind(page);
  const products: SellerProduct[] = [];

  for (const block of distinctProductBlocks(html)) {
    const title = cleanText(block.title);
    if (!title) continue;
    const manufacturer = manufacturerFromBlock(block.html, title);

    products.push({
      sourceId: block.sourceId,
      rawManufacturer: manufacturer,
      manufacturer,
      model: modelFromTitle(title),
      title,
      rawCategory: kind,
      category: "",
      conditionText: conditionFor(kind, title, block.html),
      priceYen: extractPrice(block.html),
      stockStatus: stockStatusFor(title, block.html),
      sourceUrl: block.sourceUrl,
      metadata: { listingKind: kind },
    });
  }

  return [...new Map(products.map((product) => [product.sourceId, product])).values()];
}

export function discoverShimamusenPageUrls(html: string): ShimamusenPage[] {
  const pages = new Map<number, ShimamusenPage>();
  const re = /href\s*=\s*["']([^"']*\/shopbrand\/ct826\/page(\d+)\/order\/?[^"']*)["']/gi;
  for (const match of String(html || "").matchAll(re)) {
    const url = absoluteUrl(match[1]);
    const pageNumber = Number.parseInt(match[2], 10);
    if (!url || !Number.isFinite(pageNumber) || pageNumber < 2) continue;
    pages.set(pageNumber, { url, kind: "中古品" });
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, page]) => page);
}

export const SHIMAMUSEN_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({ default: "ignore" as const }),
  parserHint: "ignore" as const,
});

export const shimamusenAdapter = {
  key: "shimamusen",
  name: "シマムセン",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "stop", itemCountValidation: "always", extraPageBudget: 0 },
    *initialTargets() {
      yield { url: DISPLAY_URL, kind: "展示処分品" };
      yield { url: SALE_URL, kind: "特価商品" };
      yield { url: USED_URL, kind: "中古品" };
    },
    discoverTargets(html, page) {
      return pageKind(page) === "中古品" ? discoverShimamusenPageUrls(html) : [];
    },
  },
  parse(html, page) {
    return parseShimamusenListing(html, page);
  },
} satisfies ShopAdapter<ShimamusenPage>;
