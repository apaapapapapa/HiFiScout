import { cleanText, inferCategory, parseYen } from "../normalize.js";
import { availabilityFromSignals } from "../availability.js";
import type { SellerProduct, ShopAdapter } from "../types.js";

const CATEGORY_BY_SLUG: Readonly<Record<string, string>> = {
  "speaker-system": "スピーカー",
  "speaker-accessories": "スピーカーアクセサリー",
  "control-amplifiers": "プリアンプ",
  "power-amplifiers": "パワーアンプ",
  "integrated-amplifiers": "プリメインアンプ",
  "channel-divider": "チャンネルデバイダー",
  "cd-sacd-players": "CD/SACDプレーヤー",
  "da-converter": "DAC",
  "network-player": "ネットワーク",
  "analog-system": "アナログ",
  accessories: "ケーブル・アクセサリー",
  visual: "ビジュアル",
  others: "その他",
};

const FORMUSIC_CATEGORY_MAPPING = Object.freeze({
  "speaker-system": "speaker",
  "speaker-accessories": "accessory",
  "control-amplifiers": "pre_amp",
  "power-amplifiers": "power_amp",
  "integrated-amplifiers": "integrated_amp",
  "cd-sacd-players": "cd_sacd_player",
  "da-converter": "dac",
  "network-player": "network_player",
  accessories: ["accessory", "cable"],
  others: "other",
});

const EXCLUDED_CATEGORY_SLUGS = new Set(["music-book"]);
const CURRENT_KINDS = new Set(["中古", "展示現品", "委託品"]);

function absoluteUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://shop.formusic.jp");
    return url.hostname === "shop.formusic.jp" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cellsFromRow(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
}

function firstLine(html: string = ""): string {
  return cleanText(String(html).split(/<br\s*\/?>/i)[0]);
}

function altTexts(html: string = ""): string[] {
  return [...String(html).matchAll(/\balt\s*=\s*["']([^"']+)["']/gi)].map((match) =>
    cleanText(match[1]),
  );
}

function categoryFor(sourceUrl: string, title: string): { slug: string; category: string } {
  try {
    const slug = new URL(sourceUrl).pathname.split("/").filter(Boolean)[0] || "";
    return { slug, category: CATEGORY_BY_SLUG[slug] || inferCategory(title) };
  } catch {
    return { slug: "", category: inferCategory(title) };
  }
}

export function parseForMusicListing(html: string): SellerProduct[] {
  const products: SellerProduct[] = [];
  const rowRe = /<tr\b[^>]*id=["']post-(\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;

  for (const rowMatch of html.matchAll(rowRe)) {
    const sourceId = rowMatch[1];
    const rowHtml = rowMatch[2];
    const cells = cellsFromRow(rowHtml);
    if (cells.length < 8) continue;

    const titleMatch = cells[2].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const sourceUrl = absoluteUrl(titleMatch[1]);
    const title = cleanText(titleMatch[2]);
    if (!sourceUrl || !title) continue;

    const { slug, category } = categoryFor(sourceUrl, title);
    if (EXCLUDED_CATEGORY_SLUGS.has(slug)) continue;

    const badges = altTexts(cells[7]);
    const currentKind = badges.find((value) => CURRENT_KINDS.has(value)) || "";

    const saleHtml =
      cells[4].match(
        /class=["'][^"']*\bpost-meta-baika\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      )?.[1] || "";
    const saleText = cleanText(saleHtml);
    const soldOut = /SOLD\s*OUT/i.test(saleText) || badges.some((value) => /売約済/.test(value));
    const negotiating = badges.some((value) => /商談中|予約中/.test(value));

    if (!soldOut && !currentKind) continue;

    const manufacturer = firstLine(cells[1]);
    const grade = cleanText(
      cells[5].match(
        /class=["'][^"']*\bpost-meta-teido\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      )?.[1] || "",
    );
    const priceYen =
      soldOut || /^(?:ASK|-|ー|オープン|OPEN)$/i.test(saleText) ? null : parseYen(saleText);
    const stockStatus = availabilityFromSignals({
      soldOut,
      inStock: !soldOut && !negotiating,
    });
    const conditionText = [grade, currentKind, negotiating ? "商談中" : ""]
      .filter(Boolean)
      .join(" / ");

    products.push({
      sourceId,
      rawManufacturer: manufacturer,
      manufacturer,
      model: title,
      title,
      rawCategory: slug,
      category,
      conditionText,
      priceYen,
      stockStatus,
      sourceUrl,
    });
  }

  return [...new Map(products.map((product) => [product.sourceId, product])).values()];
}

export const forMusicAdapter = {
  key: "formusic",
  name: "FOR MUSIC",
  baseUrl: "https://shop.formusic.jp",
  categoryMapping: FORMUSIC_CATEGORY_MAPPING,
  discovery: {
    coverage: "complete",
    *initialTargets() {
      yield "https://shop.formusic.jp/";
    },
    discoverTargets() {
      return [];
    },
  },
  parse(html) {
    return parseForMusicListing(html);
  },
} satisfies ShopAdapter<string>;
