import { normalizeManufacturer } from "../../catalog/manufacturers.js";
import {
  cleanText,
  inferCategory,
  inferStockStatus,
  parseYen,
  splitManufacturerModel,
  stableSourceId,
} from "../normalize.js";
import {
  listingAttribute,
  listingBlocks,
  listingFieldHtml,
  listingFieldText,
} from "../listing-fields.js";
import { stripRawTextElements } from "../../html/raw-text.js";
import {
  AUDIOUNION_CATEGORIES,
  AUDIOUNION_ORIGIN,
  AUDIOUNION_LEGACY_ENTRY_URL,
  audioUnionCategoryPage,
  audioUnionGoodsCode,
} from "./audiounion-urls.js";
import { availabilityFromSignals } from "../availability.js";
import { parseProductPage } from "../parser.js";
import type { ManufacturerNormalizationResult } from "../../catalog/types.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

export const AUDIOUNION_CATEGORY_MAPPING = Object.freeze({
  // The slash describes a DAC capability on one integrated amplifier, not two sale objects.
  "USB-DAC/プリメインアンプ": "AMP.INTEGRATED",
});

const DEFAULT_ENTRY_URL = `${AUDIOUNION_ORIGIN}/shop/c/camp-integrated-all_lS/`;
const DETAIL_URL_PATTERN = /audiounion\.jp\/ct\/detail\/used\/\d+\/?/i;
const BRAND_SUFFIXES = new Set([
  "audio",
  "acoustics",
  "acoustic",
  "audio labs",
  "labs",
  "lab",
  "design",
  "designs",
  "electronics",
  "technology",
  "technologies",
  "digital",
  "research",
  "engineering",
]);
const PRODUCT_TYPE_PREFIX =
  /^(?:スピーカー(?:システム)?|プリメインアンプ|プリアンプ|パワーアンプ|アンプ|cd\/?sacd(?:プレーヤー)?|sacd(?:プレーヤー)?|cd(?:プレーヤー)?|dac|d\/aコンバーター?|ネットワーク(?:プレーヤー)?|ターンテーブル|レコードプレーヤー|カートリッジ|ヘッドホン|イヤホン)\s+/i;
const SALES_NOISE = /(?:販売店|販売価格|税込価格|価格|商品コード|在庫)[：:]?/i;

interface KnownManufacturerParts {
  raw: string;
  consumed: Set<string>;
}

interface ManufacturerModelPair {
  manufacturer: string;
  model: string;
}

function stripTagsKeepingSpacing(html: unknown): string {
  return cleanText(
    String(html || "")
      .replace(/<(?:img|input)\b([^>]*)>/gi, (_match: string, attrs: string) => {
        const labels = [
          ...attrs.matchAll(/\b(?:alt|title|aria-label)\s*=\s*["']([^"']+)["']/gi),
        ].map((match) => match[1]);
        return labels.length ? ` ${labels.join(" ")} ` : " ";
      })
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function candidateText(value: unknown): string {
  let text = cleanText(value)
    .replace(/^中古\s*/i, "")
    .replace(/^NEW\s*/i, "")
    .trim();
  const noise = text.search(SALES_NOISE);
  if (noise >= 0) text = text.slice(0, noise).trim();
  return text;
}

function detailLinkCandidates(html: string, baseUrl: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorRe)) {
    let url;
    try {
      url = new URL(match[2], baseUrl).toString();
    } catch {
      continue;
    }
    if (!DETAIL_URL_PATTERN.test(url)) continue;
    const sourceId = stableSourceId(url);
    const text = candidateText(stripTagsKeepingSpacing(match[4]));
    if (!sourceId || !text || /^(?:詳細|商品を見る|画像|中古|NEW)$/i.test(text)) continue;
    const values = groups.get(sourceId) ?? [];
    if (!values.includes(text)) values.push(text);
    groups.set(sourceId, values);
  }
  return groups;
}

function exactKnownManufacturer(text: string): ManufacturerNormalizationResult | null {
  const normalized = normalizeManufacturer(text);
  return normalized.matchedAlias ? normalized : null;
}

function combineKnownManufacturer(candidates: readonly string[]): KnownManufacturerParts | null {
  for (let size = Math.min(3, candidates.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= candidates.length; start += 1) {
      const raw = candidates.slice(start, start + size).join(" ");
      if (exactKnownManufacturer(raw))
        return { raw, consumed: new Set(candidates.slice(start, start + size)) };
    }
  }
  return null;
}

function startsWithIdentityPrefix(detail: string, manufacturer: string): string {
  const value = candidateText(detail);
  const prefix = cleanText(manufacturer);
  if (!value || !prefix) return "";
  const withoutCondition = value.replace(/^中古\s*/i, "").trim();
  if (!withoutCondition.toLowerCase().startsWith(prefix.toLowerCase())) return "";
  const boundary = withoutCondition[prefix.length];
  if (boundary && !/[\s・･_\-/&+.,'"()（）]/.test(boundary)) return "";
  return withoutCondition
    .slice(prefix.length)
    .replace(/^[\s・･_\-/&+.,'"()（）]+/, "")
    .trim();
}

function cleanModel(value: string): string {
  let model = candidateText(value).replace(PRODUCT_TYPE_PREFIX, "").trim();
  const parts = model.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) model = parts[0];
  return model;
}

function bestModel(
  candidates: readonly string[],
  manufacturer: string,
  consumed: ReadonlySet<string> = new Set<string>(),
): string {
  const models: { model: string; score: number }[] = [];
  for (const candidate of candidates) {
    if (consumed.has(candidate) || candidate === manufacturer) continue;
    const prefixed = startsWithIdentityPrefix(candidate, manufacturer);
    const model = cleanModel(prefixed || candidate);
    if (!model || exactKnownManufacturer(model)) continue;
    let score = Math.min(model.length, 160);
    if (prefixed) score += 250;
    if (/\d/.test(model)) score += 300;
    if (/[-+./]/.test(model)) score += 40;
    if (model.length > 90) score -= 300;
    models.push({ model, score });
  }
  return models.sort((a, b) => b.score - a.score)[0]?.model || "";
}

function prefixPairIdentity(candidates: readonly string[]): ManufacturerModelPair | null {
  const brandLike = candidates.filter((value) => value.length <= 80 && !/\d/.test(value));
  for (const manufacturer of brandLike) {
    for (const detail of candidates) {
      if (detail === manufacturer) continue;
      const remainder = startsWithIdentityPrefix(detail, manufacturer);
      if (!remainder) continue;
      const model = cleanModel(remainder);
      if (model) return { manufacturer, model };
    }
  }
  return null;
}

function suffixBrandIdentity(candidates: readonly string[]): ManufacturerModelPair | null {
  if (candidates.length < 2) return null;
  for (let start = 0; start < candidates.length - 1; start += 1) {
    const first = candidates[start];
    const second = candidates[start + 1];
    if (/\d/.test(first) || /\d/.test(second)) continue;
    if (!BRAND_SUFFIXES.has(second.toLowerCase())) continue;
    const manufacturer = `${first} ${second}`;
    const consumed = new Set([first, second]);
    const model = bestModel(candidates, manufacturer, consumed);
    return { manufacturer, model };
  }
  return null;
}

function repairIdentity(
  item: SellerProduct,
  candidates: readonly string[] | undefined,
): SellerProduct {
  if (!candidates?.length) return item;

  const known = combineKnownManufacturer(candidates);
  if (known) {
    const model = bestModel(candidates, known.raw, known.consumed) || item.model;
    const title = model ? `${known.raw} ${model}` : known.raw;
    return {
      ...item,
      rawManufacturer: known.raw,
      manufacturer: known.raw,
      model,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const prefixPair = prefixPairIdentity(candidates);
  if (prefixPair) {
    const title = `${prefixPair.manufacturer} ${prefixPair.model}`.trim();
    return {
      ...item,
      rawManufacturer: prefixPair.manufacturer,
      ...prefixPair,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const suffixBrand = suffixBrandIdentity(candidates);
  if (suffixBrand) {
    const title = suffixBrand.model
      ? `${suffixBrand.manufacturer} ${suffixBrand.model}`
      : suffixBrand.manufacturer;
    return {
      ...item,
      rawManufacturer: suffixBrand.manufacturer,
      ...suffixBrand,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const cleanTitle = candidateText(item.title);
  if (cleanTitle !== item.title) {
    const split = splitManufacturerModel(cleanTitle, "audiounion");
    return {
      ...item,
      rawManufacturer: split.manufacturer,
      ...split,
      title: cleanTitle,
      category: inferCategory(cleanTitle, item.category === "その他" ? "" : item.category),
    };
  }
  return item;
}

function parseStorefrontCards(cards: string[], pageUrl: string): SellerProduct[] {
  const products = new Map<string, SellerProduct>();
  for (const card of cards) {
    // The same card template also presents new goods and buyback quotes.
    const classes = [...card.matchAll(/<input\b([^>]*)>/gi)]
      .filter((match) => listingAttribute(match[1], "name") === "class1")
      .map((match) => listingAttribute(match[1], "value"));
    if (classes.length !== 1 || classes[0] !== "S") continue;
    const name = listingFieldHtml(card, "block-thumbnail-t--goods-name");
    const href = name.match(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    let sourceUrl: string;
    try {
      sourceUrl = new URL(cleanText(href), pageUrl).href;
    } catch {
      continue;
    }
    const code = audioUnionGoodsCode(sourceUrl);
    const model = cleanText(name);
    if (!code || !model) continue;
    const manufacturer = listingFieldText(card, "block-thumbnail-t--goods-brand");
    const rawCategory = listingFieldText(card, "block-thumbnail-t--goods-category");
    // net-price is MSRP; an inquiry-only offer has no advertised selling price.
    const priceYen = parseYen(listingFieldText(card, "js-enhanced-ecommerce-goods-price"));
    const text = stripTagsKeepingSpacing(card);
    const soldOut = /売約済み?|売り切れ|売切|sold\s*out|在庫なし|完売|品切れ|販売終了|ご成約/i.test(
      text,
    );
    const positive = /在庫あり|カートに(?:入れる|追加する)|購入する/i.test(text);
    const title = cleanText(`${manufacturer} ${model}`);
    const sourceId = `goods:${code}`;
    products.set(sourceId, {
      sourceId,
      sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model,
      rawCategory,
      category: inferCategory(title, rawCategory),
      conditionText: "中古",
      priceYen,
      stockStatus: availabilityFromSignals({
        soldOut,
        inStock: positive || (!soldOut && priceYen !== null),
      }),
    });
  }
  return [...products.values()];
}

function parseAudioUnion(html: string, pageUrl: string): SellerProduct[] {
  html = stripRawTextElements(html, ["script", "style", "noscript"]);
  const storefrontCards = listingBlocks(html, "dl", "block-thumbnail-t--goods");
  if (storefrontCards.length) return parseStorefrontCards(storefrontCards, pageUrl);
  const cards = listingBlocks(html, "li", "item");
  if (cards.length) {
    const products: SellerProduct[] = [];
    for (const card of cards) {
      const manufacturer = listingFieldText(card, "maker_name");
      const modelHtml = listingFieldHtml(card, "item_name");
      const model = cleanText(modelHtml);
      const href = modelHtml.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!href || !model) continue;
      const sourceUrl = new URL(href, pageUrl).toString();
      if (!DETAIL_URL_PATTERN.test(sourceUrl)) continue;
      const rawCategory = listingFieldText(card, "category");
      const priceYen = parseYen(listingFieldText(card, "selling_price"));
      const stock = inferStockStatus(stripTagsKeepingSpacing(card));
      const title = cleanText(`${manufacturer} ${model}`);
      products.push({
        sourceId: stableSourceId(sourceUrl),
        sourceUrl,
        title,
        rawManufacturer: manufacturer,
        manufacturer,
        model,
        rawCategory,
        category: inferCategory(title, rawCategory),
        conditionText: "中古",
        priceYen,
        stockStatus: availabilityFromSignals({
          soldOut: stock === "sold_out",
          inStock: stock === "in_stock" || (stock !== "sold_out" && priceYen !== null),
        }),
      });
    }
    return products;
  }
  const fallback = parseProductPage(html, {
    shopKey: "audiounion",
    baseUrl: pageUrl,
    productUrlPattern: DETAIL_URL_PATTERN,
    priceContext: "forward",
    priceImpliesInStock: true,
    fixedConditionText: "中古",
    identityStrategy: "manufacturer-model-candidates",
  });
  const candidates = detailLinkCandidates(html, pageUrl);
  return fallback.map((item) => repairIdentity(item, candidates.get(item.sourceId)));
}

export const audioUnionAdapter = {
  key: "audiounion",
  name: "Audio Union",
  baseUrl: "https://www.audiounion.jp",
  discovery: {
    coverage: "partial",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets({ env }) {
      const override = env.AUDIOUNION_ENTRY_URL?.trim();
      if (override && override !== AUDIOUNION_LEGACY_ENTRY_URL) {
        yield override;
        return;
      }
      // Search is robots-disallowed. Category pages expose the seller's public used filter.
      for (const category of AUDIOUNION_CATEGORIES)
        yield `${AUDIOUNION_ORIGIN}/shop/c/c${category}_lS/`;
    },
    discoverTargets(html, pageUrl) {
      const current = audioUnionCategoryPage(pageUrl);
      if (!current) return [];
      const source = stripRawTextElements(html, ["script", "style", "noscript"]);
      const pager = listingFieldHtml(source, "block-goods-list--pager");
      if (!pager) {
        const category = listingFieldHtml(source, "block-category-list");
        return listingFieldText(category, "alert") ===
          "ご指定の条件に一致する商品が見つかりませんでした。" &&
          !listingBlocks(category, "dl", "block-thumbnail-t--goods").length
          ? []
          : null;
      }
      const next = listingFieldHtml(pager, "pager-next");
      if (!next) return [];
      const href = next.match(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!href) return null;
      try {
        const target = new URL(cleanText(href), pageUrl).href;
        const parsed = audioUnionCategoryPage(target);
        return parsed?.category === current.category && parsed.page === current.page + 1
          ? [target]
          : null;
      } catch {
        return null;
      }
    },
  },
  parse(html, pageUrl = DEFAULT_ENTRY_URL) {
    return parseAudioUnion(html, pageUrl);
  },
} satisfies ShopAdapter<string>;
