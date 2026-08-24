import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, stableSourceId } from "../normalize.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://www.as-core.co.jp";
const LIST_URL = `${BASE_URL}/used`;
const SOLD_PATTERN = /売約済(?:み)?|sold\s*out|販売終了|ご成約|在庫なし|完売|品切れ/iu;
const NEGOTIATING_PATTERN = /商談中|予約中|取り置き/iu;

const USED_CATEGORY_LABELS = new Set([
  "スピーカー（ペア）",
  "セパレートアンプ（セット）",
  "プリアンプ",
  "パワーアンプ",
  "プリメインアンプ",
  "CDプレーヤー（CDP）",
  "D/Aコンバーター関連（DAC）",
  "オーディオシステム",
  "マルチプレーヤー",
  "ケーブル",
  "レコード関連",
  "オーディオラック・スタンド",
  "アクセサリー関連",
  "シアター関連",
  "チューナー",
]);

const CATEGORY_BY_SELLER_LABEL: Readonly<Record<string, string>> = {
  "スピーカー（ペア）": "スピーカー",
  プリアンプ: "プリアンプ",
  パワーアンプ: "パワーアンプ",
  プリメインアンプ: "プリメインアンプ",
  "CDプレーヤー（CDP）": "CD/SACDプレーヤー",
  "D/Aコンバーター関連（DAC）": "DAC",
  ケーブル: "ケーブル・アクセサリー",
  レコード関連: "アナログ",
  アクセサリー関連: "ケーブル・アクセサリー",
};

export const AUDIO_SPACE_CORE_CATEGORY_MAPPING = Object.freeze({
  "スピーカー（ペア）": "speaker",
  プリアンプ: "pre_amp",
  パワーアンプ: "power_amp",
  プリメインアンプ: "integrated_amp",
  "CDプレーヤー（CDP）": "cd_sacd_player",
  "D/Aコンバーター関連（DAC）": "dac",
  ケーブル: ["cable", "accessory"],
  アクセサリー関連: "accessory",
});

// Some seller buckets are broader than the catalog leaves (for example CD transports live in the
// CD-player bucket), so explicit model/title evidence must be allowed to refine the final category.
export const AUDIO_SPACE_CORE_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({ default: "corroborative" as const }),
  parserHint: "corroborative" as const,
});

function cellsFromRow(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((match) => match[1]);
}

function detailAnchor(cellHtml: string): { href: string; label: string } | null {
  for (const match of cellHtml.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu,
  )) {
    const href = cleanText(match[2]);
    const label = cleanText(match[3]);
    if (!href || !label) continue;

    try {
      const url = new URL(href, BASE_URL);
      if (!/^(?:www\.)?as-core\.co\.jp$/iu.test(url.hostname)) continue;
      if (url.pathname === "/used" || url.pathname.includes("/shop_used/category.php")) continue;
      url.protocol = "https:";
      url.hostname = "www.as-core.co.jp";
      url.hash = "";
      return { href: url.toString(), label };
    } catch {
      continue;
    }
  }
  return null;
}

function parseSection(sectionHtml: string, rawCategory: string): SellerProduct[] {
  const products: SellerProduct[] = [];

  for (const rowMatch of sectionHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = cellsFromRow(rowMatch[1]);
    if (cells.length < 5) continue;

    let modelCellIndex = -1;
    let anchor: { href: string; label: string } | null = null;
    for (let index = 0; index < cells.length; index += 1) {
      const candidate = detailAnchor(cells[index]);
      if (!candidate) continue;
      modelCellIndex = index;
      anchor = candidate;
      break;
    }
    if (!anchor || modelCellIndex < 0) continue;

    const productName = cleanText(cells[modelCellIndex + 1] || "");
    const manufacturer = cleanText(cells[modelCellIndex + 2] || "");
    const saleText = cleanText(cells.at(-1) || "");
    const noteText = cleanText(cells.slice(0, modelCellIndex).join(" "));
    const rowText = cleanText(rowMatch[1]);
    if (!manufacturer || !saleText) continue;

    // The used page keeps a long historical archive of sold items below the current inventory.
    // Treat those rows as history, not as listings to re-normalize and rewrite on every crawl.
    if (SOLD_PATTERN.test(saleText) || SOLD_PATTERN.test(rowText)) continue;

    const negotiating = NEGOTIATING_PATTERN.test(rowText);
    const stockStatus = availabilityFromSignals({ inStock: !negotiating });
    const category =
      CATEGORY_BY_SELLER_LABEL[rawCategory] ||
      inferCategory(`${rawCategory} ${productName} ${anchor.label}`);
    const conditionText = [noteText, negotiating ? "商談中" : ""].filter(Boolean).join(" ");

    products.push({
      sourceId: stableSourceId(anchor.href, anchor.label),
      manufacturer,
      rawManufacturer: manufacturer,
      model: anchor.label,
      title: [anchor.label, productName].filter(Boolean).join(" "),
      rawCategory,
      category,
      conditionText,
      priceYen: parseYen(saleText),
      stockStatus,
      sourceUrl: anchor.href,
    });
  }

  return products;
}

export function parseAudioSpaceCoreListing(html: string): SellerProduct[] {
  const products: SellerProduct[] = [];
  const sections = String(html || "").matchAll(
    /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/giu,
  );

  for (const section of sections) {
    const rawCategory = cleanText(section[1]);
    if (!USED_CATEGORY_LABELS.has(rawCategory)) continue;
    products.push(...parseSection(section[2], rawCategory));
  }

  return products;
}

export const audioSpaceCoreAdapter = {
  key: "audio-space-core",
  name: "オーディオスペースコア",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets() {
      yield LIST_URL;
    },
    discoverTargets() {
      return [];
    },
  },
  parse(html: string) {
    return parseAudioSpaceCoreListing(html);
  },
} satisfies ShopAdapter<string>;
