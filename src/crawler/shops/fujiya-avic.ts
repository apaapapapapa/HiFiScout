import { categoryEvidenceFromText } from "../../catalog/category-evidence.js";
import { stripRawTextElements } from "../../html/raw-text.js";
import {
  cleanText,
  inferCategory,
  inferStockStatus,
  parseYen,
  stableSourceId,
} from "../normalize.js";
import { listingBlocks, listingFieldText } from "../listing-fields.js";
import { mentionsDetailProduct, productDetailScope } from "../detail-product-scope.js";
import { parseProductPage } from "../parser.js";
import type {
  CategoryEvidenceInput,
  ClassifiableCategoryId,
  NormalizedCatalogProduct,
} from "../../catalog/types.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const PAGE_SIZE = 50;
const NEW_ARRIVALS_PATH = "ea-usednw_ssd";
const OUTLET_PATH = "c31_dP";
const OUTLET_STOCK_SALE_PATH = "ea-outlet";
const FEED_NEW_ARRIVALS = "new-arrivals" as const;
const FEED_OUTLET = "outlet" as const;
const FEED_OUTLET_STOCK_SALE = "outlet-stock-sale" as const;

interface FujiyaPage extends CrawlPageObject {
  page?: number;
  feed: string;
}

function newArrivalsPageUrl(page = 1): string {
  if (page === 1)
    return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function outletPageUrl(page = 1): string {
  if (page === 1) return `https://www.fujiya-avic.co.jp/shop/c/c31/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/c/${OUTLET_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function outletStockSalePageUrl(page = 1): string {
  if (page === 1)
    return `https://www.fujiya-avic.co.jp/shop/e/${OUTLET_STOCK_SALE_PATH}/?ps=${PAGE_SIZE}`;
  return `https://www.fujiya-avic.co.jp/shop/e/${OUTLET_STOCK_SALE_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function pageFor(feed: string, page = 1): FujiyaPage {
  let url: string;
  if (feed === FEED_OUTLET) url = outletPageUrl(page);
  else if (feed === FEED_OUTLET_STOCK_SALE) url = outletStockSalePageUrl(page);
  else url = newArrivalsPageUrl(page);
  return { url, page, feed };
}

function attribute(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] || "";
}

function metaDescriptions(html: string): string[] {
  const descriptions: string[] = [];
  // Document metadata precedes the rendered content; body/template meta tags are not evidence.
  const header = html.split(/<(?:body|main|header|nav|aside|footer|template|h[1-6])\b/i, 1)[0];
  for (const match of header.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = (attribute(attrs, "name") || attribute(attrs, "property")).toLowerCase();
    if (!["description", "og:description", "twitter:description"].includes(name)) continue;
    const content = cleanText(attribute(attrs, "content"));
    if (content) descriptions.push(content);
  }
  return [...new Set(descriptions)];
}

function productTitleDeclaresCable(
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title">>,
): boolean {
  return /\bcables?\b|\bcord\b|ケーブル|コード/i.test(
    cleanText(`${product.title || ""} ${product.model || ""}`),
  );
}

function firstExplicitDetailEvidence(
  text: string,
  source: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title">>,
): CategoryEvidenceInput[] {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const sentences = normalized
    .split(/[。！？!?]+/)
    .map(cleanText)
    .filter(Boolean)
    .filter((sentence) => mentionsDetailProduct(sentence, product))
    .filter((sentence) => !/付属品|付属の|同梱|組み合わせ|対応機種|使用例/u.test(sentence));
  for (const sentence of sentences) {
    const evidence = categoryEvidenceFromText(sentence, {
      source,
      strength: "strong",
      context: "detail",
    });
    if (!evidence.length) continue;

    // `cable_other` was observed on DAPs, disc players, projectors and soundbars whose titles had no
    // cable token. A detail sentence can legitimately mention the product and an included/connected
    // cable, so proximity to the model alone is not sufficient evidence that the product *is* a
    // cable. Keep cable detail evidence only when the listing title/model itself declares a cable;
    // seller buckets and explicit title rules remain available for genuine model-only cable rows.
    const filtered = productTitleDeclaresCable(product)
      ? evidence
      : evidence.filter(
          (item) =>
            !item.categoryIds?.some(
              (id) => id.startsWith("cable_") || id.startsWith("CAB.") || id === "PWR.CORD",
            ),
        );
    if (filtered.length) return filtered;
  }
  return [];
}

const DETAIL_CATEGORY_LABELS: ReadonlyMap<string, ClassifiableCategoryId> = new Map([
  ["イヤホン", "PER.EARPHONE"],
  ["カナル型イヤホン", "PER.EARPHONE"],
  ["インナーイヤー型イヤホン", "PER.EARPHONE"],
  ["完全ワイヤレスイヤホン", "PER.EARPHONE"],
  ["ワイヤレスイヤホン", "PER.EARPHONE"],
  ["ヘッドホン", "PER.HEADPHONE"],
  ["リスニングヘッドホン", "PER.HEADPHONE"],
  ["モニターヘッドホン", "PER.HEADPHONE"],
  ["ワイヤレスヘッドホン", "PER.HEADPHONE"],
  ["イヤーピース", "ACC.WEAR"],
  ["ヘッドホン交換用イヤーパッド", "ACC.WEAR"],
  ["イヤホンパーツ", "ACC.PART"],
  ["ヘッドホンパーツ", "ACC.PART"],
  ["イヤホンケーブル", "CAB.PERSONAL"],
  ["ヘッドホンケーブル", "CAB.PERSONAL"],
  ["イヤホンケース", "ACC.CASE"],
  ["ヘッドホンスタンド", "ACC.STAND"],
  ["ポータブルプレーヤー", "SRC.DAP"],
  ["CDプレーヤー", "SRC.DISC"],
  ["ネットワークプレーヤー", "SRC.STREAMER"],
  ["アナログプレーヤー", "ANA.TURNTABLE"],
  ["スピーカー", "SPK.LOUDSPEAKER"],
]);

function breadcrumbCategoryEvidence(
  html: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title" | "sourceUrl">>,
): CategoryEvidenceInput[] {
  const candidates: {
    depth: number;
    categoryId: ClassifiableCategoryId | undefined;
    value: string;
  }[] = [];
  for (const trail of listingBlocks(html, "ul", "block-topic-path--list").slice(0, 16)) {
    const items = listingBlocks(trail, "li");
    const current = listingBlocks(trail, "li", "block-topic-path--item__current");
    if (current.length !== 1 || items.at(-1) !== current[0]) continue;
    if (!mentionsDetailProduct(cleanText(current[0]), product)) continue;
    const href = current[0].match(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try {
      const url = new URL(href, fujiyaAvicAdapter.baseUrl);
      if (url.origin !== fujiyaAvicAdapter.baseUrl || !/^\/shop\/g\/g\d+\/$/.test(url.pathname))
        continue;
      if (product.sourceUrl && url.pathname !== new URL(product.sourceUrl).pathname) continue;
    } catch {
      continue;
    }
    // Only the terminal category can describe the sale object. An unrecognized accessory bucket
    // must not fall back to its "earphones" ancestor. Brand-only trails contribute no evidence.
    const terminal = items.at(-2);
    if (!terminal) continue;
    const value = cleanText(terminal.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "")
      .normalize("NFKC")
      .replace(/\(中古\)$/, "");
    const categoryId = DETAIL_CATEGORY_LABELS.get(value);
    candidates.push({ depth: items.length, categoryId, value });
  }
  // Fujiya repeats ancestor trails; prefer its most specific product-bound trail. Equally deep
  // conflicting trails stay separate evidence so the classifier can leave them ambiguous.
  const deepest = Math.max(0, ...candidates.map((item) => item.depth));
  const seen = new Set<string>();
  return candidates
    .filter((item) => item.depth === deepest)
    .flatMap((item) => {
      if (!item.categoryId || seen.has(item.categoryId)) return [];
      seen.add(item.categoryId);
      return [
        {
          categoryIds: [item.categoryId],
          source: "detail_breadcrumb",
          strength: "strong" as const,
          value: item.value,
          ruleId: "fujiya.product_breadcrumb.v3",
        },
      ];
    });
}

export function extractFujiyaDetailCategoryEvidence(
  html: string,
  product: Partial<Pick<NormalizedCatalogProduct, "model" | "title" | "sourceUrl">> = {},
): CategoryEvidenceInput[] {
  const lead = productDetailScope(html, product);
  if (lead === null) return [];
  const breadcrumb = breadcrumbCategoryEvidence(html, product);
  for (const description of metaDescriptions(stripRawTextElements(html))) {
    const evidence = firstExplicitDetailEvidence(description, "detail_metadata", product);
    if (evidence.length) return [...breadcrumb, ...evidence];
  }

  // Keep block boundaries: a model heading followed by an accessories row is not one sentence.
  const segments = lead
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|dt|dd|tr|td|th|h[1-6])\s*>/gi, "\n")
    .split("\n")
    .map(cleanText);
  let remaining = 1200;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const evidence = firstExplicitDetailEvidence(
      segment.slice(0, remaining),
      "detail_product_text",
      product,
    );
    if (evidence.length) return [...breadcrumb, ...evidence];
    remaining -= segment.length;
  }
  return breadcrumb;
}

export function parseFujiyaResultCount(html: string): number | null {
  const text = cleanText(html);
  const match = text.match(/(?:検索結果|該当件数)\s*([0-9,，]+)\s*件|([0-9,，]+)\s*件あります/);
  const raw = match?.[1] || match?.[2];
  return raw ? Number.parseInt(raw.replace(/[，,]/g, ""), 10) : null;
}

export const FUJIYA_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({
    default: "authoritative" as const,
    categories: Object.freeze({
      dap: "corroborative" as const,
      headphone_amp: "corroborative" as const,
    }),
  }),
  parserHint: "corroborative" as const,
  enrichment: Object.freeze({
    maxRequestsPerCrawl: 20,
    cacheHours: 168,
  }),
});

function parseFujiyaCards(cards: readonly string[], page: FujiyaPage): SellerProduct[] {
  const products: SellerProduct[] = [];
  for (const card of cards) {
    const href = card.match(/\bhref\s*=\s*(["'])([^"']*\/shop\/g\/g[^"']+)\1/i)?.[2];
    const model = listingFieldText(card, "block-thumbnail-t--goods-name");
    const manufacturer = listingFieldText(card, "txt-en") || listingFieldText(card, "txt-ja");
    if (!href || !model) continue;
    let sourceUrl: string;
    try {
      const url = new URL(href, page.url);
      if (url.origin !== "https://www.fujiya-avic.co.jp") continue;
      sourceUrl = url.toString();
    } catch {
      continue;
    }
    const title = cleanText(`${listingFieldText(card, "block-thumbnail-t--goods-brand")} ${model}`);
    const statusText = cleanText(
      card.replace(
        /<img\b([^>]*)>/gi,
        (_match, attrs: string) => attrs.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || "",
      ),
    );
    products.push({
      sourceId: stableSourceId(sourceUrl),
      sourceUrl,
      title,
      manufacturer,
      rawManufacturer: manufacturer,
      model,
      rawCategory: "",
      category: inferCategory(title),
      priceYen: parseYen(listingFieldText(card, "js-enhanced-ecommerce-goods-price")),
      stockStatus: inferStockStatus(statusText),
      conditionText:
        page.feed === FEED_OUTLET
          ? "アウトレット"
          : listingFieldText(card, "block-thumbnail-t--goods-condition"),
    });
  }
  return products;
}

export const fujiyaAvicAdapter = {
  key: "fujiya-avic",
  name: "フジヤエービック",
  baseUrl: "https://www.fujiya-avic.co.jp",
  discovery: {
    // New arrivals and outlet feeds are intentionally bounded subsets of total inventory.
    coverage: "partial",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets() {
      yield pageFor(FEED_NEW_ARRIVALS);
      yield pageFor(FEED_OUTLET);
      yield pageFor(FEED_OUTLET_STOCK_SALE);
    },
    discoverTargets(html, page) {
      if ((page.page ?? 1) !== 1) return [];
      const count = parseFujiyaResultCount(html);
      if (count == null) return null;
      const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      return Array.from({ length: totalPages - 1 }, (_, index) => pageFor(page.feed, index + 2));
    },
  },
  parse(html, page = pageFor(FEED_NEW_ARRIVALS)) {
    const cards = listingBlocks(html, "dl", "block-thumbnail-t--goods");
    if (cards.length) return parseFujiyaCards(cards, page);
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i,
      priceContext: "forward",
      ...(page.feed === FEED_OUTLET ? { fixedConditionText: "アウトレット" } : {}),
    });
  },
} satisfies ShopAdapter<FujiyaPage>;
