import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://sound-support.jp";
const PRODUCT_PATH = /^\/(\d+)\.html$/u;
const SOLD_PATTERN = /売約済(?:み)?|sold\s*out|販売終了|在庫なし|完売|品切れ/iu;

export const SOUND_SUPPORT_CATEGORY_MAPPING = Object.freeze({
  プリアンプ: "pre_amp",
  パワーアンプ: "power_amp",
  プリメインアンプ: "integrated_amp",
  スピーカー: "speaker",
  "D/Aコンバーター": "dac",
  "D／Aコンバーター": "dac",
  "D／A コンバーター": "dac",
  ケーブル: "cable",
});

// Only precise seller buckets are mapped above, so those mappings can be authoritative. Unmapped
// mixed buckets (CD/universal, analog/FM, PC audio, etc.) fall back to raw inference, which the
// shared category-evidence layer automatically treats as corroborative instead of authoritative.
export const SOUND_SUPPORT_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({ default: "authoritative" as const }),
  parserHint: "corroborative" as const,
});

export interface SoundSupportPage extends CrawlPageObject {
  readonly kind: "category";
  readonly rawCategory: string;
}

const SOUND_SUPPORT_PAGES: readonly SoundSupportPage[] = Object.freeze([
  {
    url: `${BASE_URL}/category/used/used-preamp`,
    kind: "category",
    rawCategory: "プリアンプ",
  },
  {
    url: `${BASE_URL}/category/used/used-poweramp`,
    kind: "category",
    rawCategory: "パワーアンプ",
  },
  {
    url: `${BASE_URL}/category/used/used-premainamp`,
    kind: "category",
    rawCategory: "プリメインアンプ",
  },
  {
    url: `${BASE_URL}/category/used/used-speaker`,
    kind: "category",
    rawCategory: "スピーカー",
  },
  {
    url: `${BASE_URL}/category/used/used-cdplayer`,
    kind: "category",
    rawCategory: "CDプレーヤー／ユニバーサルプレーヤー",
  },
  {
    url: `${BASE_URL}/category/used/used-daconverter`,
    kind: "category",
    rawCategory: "D／A コンバーター",
  },
  {
    url: `${BASE_URL}/category/used/used-analogfmtuner`,
    kind: "category",
    rawCategory: "アナログ／FMチューナー",
  },
  {
    url: `${BASE_URL}/category/used/used-cable`,
    kind: "category",
    rawCategory: "ケーブル",
  },
  {
    url: `${BASE_URL}/category/used/used-pcaudio`,
    kind: "category",
    rawCategory: "PCオーディオ",
  },
  {
    url: `${BASE_URL}/category/used/used-etc`,
    kind: "category",
    rawCategory: "その他",
  },
]);

interface ProductAnchorRecord {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly index: number;
  readonly titles: string[];
}

function productUrl(href: string): Pick<ProductAnchorRecord, "sourceId" | "sourceUrl"> | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL) return null;
    const sourceId = url.pathname.match(PRODUCT_PATH)?.[1];
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
  const anchorRe = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || "").matchAll(anchorRe)) {
    const product = productUrl(match[2]);
    if (!product) continue;
    const title = cleanText(match[3]);
    const existing = records.get(product.sourceId);
    if (existing) {
      if (title) existing.titles.push(title);
      continue;
    }
    records.set(product.sourceId, {
      ...product,
      index: match.index ?? 0,
      titles: title ? [title] : [],
    });
  }

  return [...records.values()].sort((a, b) => a.index - b.index);
}

function productTitle(record: ProductAnchorRecord): string {
  return (
    [...new Set(record.titles.map(cleanText).filter(Boolean))].find(
      (value) => !/^(?:>\s*)?詳細を見る$/u.test(value),
    ) || ""
  );
}

function currentPrice(text: string): number | null {
  const normalized = cleanText(text).normalize("NFKC");
  const value = normalized.match(/(?:販売)?価格\s*[:：]\s*[¥￥]\s*([0-9][0-9,]*)/u)?.[1];
  return value ? Number.parseInt(value.replaceAll(",", ""), 10) : null;
}

function conditionGrade(text: string): string {
  return (
    cleanText(text)
      .normalize("NFKC")
      .match(/程度\s*[:：]\s*([A-Z]{1,3}(?:[+-])?)/iu)?.[1] || ""
  );
}

function categorySlug(page: Partial<SoundSupportPage>): string {
  try {
    return new URL(page.url || "").pathname.split("/").filter(Boolean).at(-1) || "";
  } catch {
    return "";
  }
}

export function parseSoundSupportListing(
  html: string,
  page: Partial<SoundSupportPage> = {},
): SellerProduct[] {
  const rawCategory = cleanText(page.rawCategory || "");
  const records = productAnchorRecords(html);
  const products: SellerProduct[] = [];

  records.forEach((record, index) => {
    const title = productTitle(record);
    if (!title) return;

    const end = records[index + 1]?.index ?? String(html || "").length;
    const sellerText = cleanText(String(html || "").slice(record.index, end));
    const split = splitManufacturerModel(title, "sound-support");
    const hasSplitModel = Boolean(cleanText(split.model));
    const manufacturer = hasSplitModel ? cleanText(split.manufacturer) : "";
    const model = hasSplitModel ? cleanText(split.model) : title;
    const soldOut = SOLD_PATTERN.test(sellerText);
    const grade = conditionGrade(sellerText);

    products.push({
      sourceId: record.sourceId,
      sourceUrl: record.sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model,
      rawCategory,
      category: rawCategory || inferCategory(title),
      conditionText: [grade ? `程度 ${grade}` : "", soldOut ? "売約済" : ""]
        .filter(Boolean)
        .join(" / "),
      priceYen: currentPrice(sellerText),
      stockStatus: availabilityFromSignals({ soldOut, inStock: !soldOut }),
      metadata: {
        ...(rawCategory ? { soundSupportCategory: rawCategory } : {}),
        ...(categorySlug(page) ? { categorySlug: categorySlug(page) } : {}),
      },
    });
  });

  return products;
}

export const soundSupportAdapter = {
  key: "sound-support",
  name: "Sound Support",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<SoundSupportPage> {
      yield* SOUND_SUPPORT_PAGES;
    },
  },
  parse(html, page) {
    return parseSoundSupportListing(html, page);
  },
} satisfies ShopAdapter<SoundSupportPage>;
