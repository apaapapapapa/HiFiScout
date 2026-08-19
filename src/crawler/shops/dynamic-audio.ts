import { availabilityFromSignals } from "../availability.js";
import { cleanText, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://dynamicaudio5used.wordpress.com";

interface DynamicAudioPage extends CrawlPageObject {
  page: number;
}

interface WordPressArticle {
  sourceId: string;
  html: string;
}

interface EntryTitle {
  sourceUrl: string;
  title: string;
}

const SOLD_PATTERN = /SOLD\s*I?OUT|売約済(?:み)?|売り切れ|売切れ|完売|販売終了|在庫なし/i;
const PRICE_LABELS: readonly RegExp[] = [
  /決算セール価格/i,
  /セール価格/i,
  /SALE\s*Price/i,
  /現品価格/i,
  /中古価格/i,
  /販売価格/i,
];

function decodeNumericEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, rawCode: string) => {
    const hexadecimal = rawCode[0]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(
      hexadecimal ? rawCode.slice(1) : rawCode,
      hexadecimal ? 16 : 10,
    );
    if (!Number.isFinite(codePoint)) return entity;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

function textLines(html: string): string[] {
  const withLineBreaks = decodeNumericEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|section)>/gi, "\n"),
  );
  return withLineBreaks.split(/\n+/).map(cleanText).filter(Boolean);
}

function absolutePostUrl(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    if (!/^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/u.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function wordpressArticles(html: string): WordPressArticle[] {
  const articles: WordPressArticle[] = [];
  for (const match of String(html || "").matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const sourceId = match[1].match(/\bid\s*=\s*["']post-(\d+)["']/i)?.[1];
    if (!sourceId) continue;
    articles.push({ sourceId, html: match[2] });
  }
  return articles;
}

function entryTitle(articleHtml: string): EntryTitle | null {
  const titleBlock =
    articleHtml.match(
      /<h[1-6]\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i,
    )?.[1] || articleHtml;

  for (const match of titleBlock.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const sourceUrl = absolutePostUrl(match[1]);
    const title = cleanText(decodeNumericEntities(match[2]));
    if (sourceUrl && title) return { sourceUrl, title };
  }
  return null;
}

function listingClassification(
  lines: readonly string[],
): { listingKind: string; rawCategory: string } | null {
  for (const line of lines) {
    const separator = line.indexOf("＠");
    if (separator <= 0) continue;
    const listingKind = cleanText(line.slice(0, separator));
    const rawCategory = cleanText(line.slice(separator + 1));
    if (listingKind && rawCategory) return { listingKind, rawCategory };
  }
  return null;
}

function currentPrice(lines: readonly string[]): number | null {
  for (const label of PRICE_LABELS) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].normalize("NFKC");
      const labelMatch = line.match(label);
      if (!labelMatch || labelMatch.index === undefined) continue;
      const value = line.slice(labelMatch.index + labelMatch[0].length);
      if (SOLD_PATTERN.test(value)) return null;
      const prices = [...value.matchAll(/(?:[¥￥]\s*)?([0-9][0-9,]{2,})/g)];
      const raw = prices[prices.length - 1]?.[1];
      if (raw) return Number.parseInt(raw.replaceAll(",", ""), 10);
    }
  }
  return null;
}

function conditionText(
  lines: readonly string[],
  listingKind: string,
  negotiating: boolean,
): { text: string; grade: string; accessories: string } {
  const grade =
    lines
      .find((line) => /^状態\s*[:：]/u.test(line))
      ?.replace(/^状態\s*[:：]\s*/u, "")
      .trim() || "";
  const accessories =
    lines
      .find((line) => /^付属品\s*[:：]/u.test(line))
      ?.replace(/^付属品\s*[:：]\s*/u, "")
      .trim() || "";
  return {
    text: [listingKind, grade, negotiating ? "商談中" : ""].filter(Boolean).join(" / "),
    grade,
    accessories,
  };
}

export function parseDynamicAudioListing(html: string): SellerProduct[] {
  const products: SellerProduct[] = [];

  for (const article of wordpressArticles(html)) {
    const entry = entryTitle(article.html);
    if (!entry) continue;
    const lines = textLines(article.html);
    const classification = listingClassification(lines);
    if (!classification) continue;
    if (!lines.some((line) => PRICE_LABELS.some((label) => label.test(line)))) continue;

    const soldOut = lines.some((line) => SOLD_PATTERN.test(line));
    const negotiating = lines.some((line) => /商談中/u.test(line));
    const condition = conditionText(lines, classification.listingKind, negotiating);
    const { manufacturer, model } = splitManufacturerModel(entry.title, "dynamic-audio");
    const metadata: Record<string, unknown> = { listingKind: classification.listingKind };
    if (condition.grade) metadata.conditionGrade = condition.grade;
    if (condition.accessories) metadata.accessories = condition.accessories;

    products.push({
      sourceId: article.sourceId,
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: model || entry.title,
      rawCategory: classification.rawCategory,
      category: "",
      conditionText: condition.text,
      priceYen: soldOut ? null : currentPrice(lines),
      // Dynamic Audio keeps negotiating products on the sale page. Treat them as available until
      // the seller publishes an explicit sold marker, while preserving 商談中 in conditionText.
      stockStatus: availabilityFromSignals({ soldOut, inStock: !soldOut }),
      metadata,
    });
  }

  return [...new Map(products.map((product) => [product.sourceId, product])).values()];
}

export function discoverDynamicAudioPageUrls(html: string, currentPage = 1): DynamicAudioPage[] {
  const pages = new Map<number, DynamicAudioPage>();
  for (const match of String(html || "").matchAll(
    /href\s*=\s*["']([^"']*\/page\/(\d+)\/?[^"']*)["']/gi,
  )) {
    const page = Number.parseInt(match[2], 10);
    if (!Number.isFinite(page) || page <= currentPage) continue;
    try {
      const url = new URL(match[1], BASE_URL);
      if (url.origin !== BASE_URL) continue;
      url.search = "";
      url.hash = "";
      pages.set(page, { url: url.toString(), page });
    } catch {
      continue;
    }
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, page]) => page);
}

export const dynamicAudioAdapter = {
  key: "dynamic-audio",
  name: "DYNAMIC AUDIO",
  baseUrl: BASE_URL,
  discovery: {
    // WordPress is an append-only archive and old stock can remain published for a long time.
    // Crawl a bounded recent horizon without deactivating products merely because they age out.
    coverage: "partial",
    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<DynamicAudioPage> {
      yield { url: `${BASE_URL}/`, page: 1 };
    },
    discoverTargets(html, page) {
      return discoverDynamicAudioPageUrls(html, page.page);
    },
  },
  parse(html) {
    return parseDynamicAudioListing(html);
  },
} satisfies ShopAdapter<DynamicAudioPage>;
