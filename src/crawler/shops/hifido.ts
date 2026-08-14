import { cleanText, inferCategory, inferStockStatus, parseYen } from "../normalize.js";
import { availabilityFromSignals } from "../availability.js";
import type { CrawlerEnv, SellerProduct, ShopAdapter } from "../types.js";

interface HifidoProductLink {
  href: string;
  sourceId: string;
  title: string;
}

interface HifidoRecheckContext {
  now?: Date;
  intervalMinutes?: number;
}

const PRODUCT_ID_RE = /\/(\d{2}-\d{5}-\d{5}-\d{2})\.html/i;
const PRODUCT_LINK_RE =
  /<a\b[^>]*href\s*=\s*["']([^"']*\/(\d{2}-\d{5}-\d{5}-\d{2})\.html[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const DIV_CLASS_RE = /<div\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/gi;
const CATEGORY_RE =
  /(スピーカー(?:（[^）]+）)?|コントロールアンプ(?:（[^）]+）)?|プリアンプ(?:（[^）]+）)?|プリメインアンプ(?:（[^）]+）)?|パワーアンプ(?:（[^）]+）)?|レコードプレーヤー|CDプレーヤー|SACD(?:\/CD)?プレーヤー|D\/Aコンバーター|DAコンバーター|ネットワークプレーヤー|ネットワークトランスポート|トーンアーム|カートリッジ|ヘッドホン|イヤホン|ケーブル|アクセサリー|真空管|ラック|その他オーディオ機器)/i;
const PAGE_SIZE = 30;
const DEFAULT_RECHECK_MAX_PAGE = 120;

const HIFIDO_CATEGORY_MAPPING = Object.freeze({
  スピーカー: "speaker",
  コントロールアンプ: "pre_amp",
  プリアンプ: "pre_amp",
  プリメインアンプ: "integrated_amp",
  パワーアンプ: "power_amp",
  レコードプレーヤー: "turntable",
  CDプレーヤー: "cd_sacd_player",
  SACDプレーヤー: "cd_sacd_player",
  "SACD/CDプレーヤー": "cd_sacd_player",
  "D/Aコンバーター": "dac",
  DAコンバーター: "dac",
  ネットワークプレーヤー: "network_player",
  ネットワークトランスポート: "network_transport",
  トーンアーム: "tonearm",
  カートリッジ: "cartridge",
  ヘッドホン: "headphone",
  イヤホン: "earphone",
  ケーブル: "cable",
  アクセサリー: "accessory",
  真空管: "vacuum_tube",
  ラック: "rack",
  その他オーディオ機器: "other",
});

function canonicalManufacturer(value = ""): string {
  const text = cleanText(value);
  const japaneseIndex = text.search(/[ぁ-んァ-ヶ一-龯]/);
  const latin = japaneseIndex > 0 ? text.slice(0, japaneseIndex).trim() : "";
  return latin || text;
}

function absoluteUrl(href: string): string | null {
  try {
    return new URL(href, "https://www.hifido.co.jp").toString();
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<\/(?:p|li|div|article|section|tr|td|h\d)>/gi, " "),
  );
}

function attr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] || "";
}

function listItemBlocks(html: string): string[] {
  const starts = [...html.matchAll(DIV_CLASS_RE)]
    .filter((match) => match[1].split(/\s+/).includes("list-item"))
    .map((match) => match.index ?? 0);
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

function productLinkFromBlock(block: string): HifidoProductLink | null {
  let fallback: HifidoProductLink | null = null;
  for (const match of block.matchAll(ANCHOR_RE)) {
    const href = attr(match[1], "href");
    const sourceId = href.match(PRODUCT_ID_RE)?.[1];
    if (!sourceId) continue;
    const candidate = { href, sourceId, title: cleanText(match[2]) };
    if (attr(match[1], "id") === `type-${sourceId}`) return candidate;
    fallback ||= candidate;
  }
  return fallback;
}

function sourcePublishedAt(text: string): string | null {
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})\s*入荷/);
  if (!match) return null;
  const year = match[1];
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  const parsed = new Date(`${year}-${month}-${day}T00:00:00+09:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseProductBlock(block: string, link: HifidoProductLink): SellerProduct | null {
  const text = htmlToText(block);
  const title = cleanText(link.title);
  const sourceUrl = absoluteUrl(link.href);
  if (!title || !sourceUrl) return null;

  const priceText =
    text.match(/売価(?:\([^)]*\))?\s*[:：]\s*[¥￥]?\s*([0-9０-９][0-9０-９,，]*)\s*円?/i)?.[1] ||
    "";
  const priceYen = parseYen(priceText);
  if (priceYen == null) return null;

  const manufacturerRaw =
    text.match(/メーカー\s*[:：]\s*(.+?)(?=\s+(?:定価|売価)\s*[:：])/i)?.[1] || "";
  const manufacturer = canonicalManufacturer(manufacturerRaw);
  const categoryRaw = text.match(CATEGORY_RE)?.[1] || "";
  const rawCategory = categoryRaw ? categoryRaw.replace(/（[^）]+）/g, "").trim() : "";
  const category = rawCategory || inferCategory(title);
  const inferred = inferStockStatus(text);
  const ordered = /(?:^|\s)注文(?:\s|$)/.test(text);
  const stockStatus = availabilityFromSignals({
    soldOut: inferred === "sold_out",
    inStock: inferred === "in_stock" || (ordered && inferred !== "sold_out"),
  });

  return {
    sourceId: link.sourceId,
    rawManufacturer: manufacturerRaw,
    manufacturer,
    model: title,
    title,
    rawCategory,
    category,
    conditionText: /パーツ取り用商品|ジャンク/i.test(text) ? "ジャンク" : "",
    priceYen,
    stockStatus,
    sourceUrl,
    sourcePublishedAt: sourcePublishedAt(text),
  };
}

function listingUrl(pageNumber: number): string {
  const offset = Math.max(0, pageNumber - 1) * PAGE_SIZE;
  return `https://www.hifido.co.jp/?L=50&LNG=J&O=${offset}&OD=0`;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function hifidoRecheckPage(
  maxRecentPages: number,
  env: CrawlerEnv = {},
  { now = new Date(), intervalMinutes = 30 }: HifidoRecheckContext = {},
): number | null {
  const maxPage = positiveInt(env.HIFIDO_RECHECK_MAX_PAGE, DEFAULT_RECHECK_MAX_PAGE);
  if (maxPage <= maxRecentPages) return null;
  const slots = maxPage - maxRecentPages;
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const slot = Math.floor(now.getTime() / intervalMs);
  return maxRecentPages + 1 + (((slot % slots) + slots) % slots);
}

export function parseHifidoListing(html: string): SellerProduct[] {
  const products: SellerProduct[] = [];
  const itemBlocks = listItemBlocks(html);

  if (itemBlocks.length) {
    for (const block of itemBlocks) {
      const link = productLinkFromBlock(block);
      if (!link) continue;
      const product = parseProductBlock(block, link);
      if (product) products.push(product);
    }
  } else {
    const matches = [...html.matchAll(PRODUCT_LINK_RE)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const nextIndex = matches[index + 1]?.index ?? html.length;
      const blockEnd = Math.min(nextIndex, (match.index ?? 0) + 3500);
      const block = html.slice(match.index ?? 0, blockEnd);
      const product = parseProductBlock(block, {
        href: match[1],
        sourceId: match[2],
        title: match[3],
      });
      if (product) products.push(product);
    }
  }

  return [...new Map(products.map((product) => [product.sourceId, product])).values()];
}

export const hifidoAdapter = {
  key: "hifido",
  name: "ハイファイ堂",
  baseUrl: "https://www.hifido.co.jp",
  categoryMapping: HIFIDO_CATEGORY_MAPPING,
  transport: "relay",
  discovery: {
    coverage: "partial",
    guardItemCount: true,
    continueOnEmpty: true,
    extraPageAllowance: 1,
    *initialTargets({ maxPages, env, now, intervalMinutes }) {
      for (let page = 1; page <= maxPages; page += 1) yield listingUrl(page);
      const recheckPage = hifidoRecheckPage(maxPages, env, { now, intervalMinutes });
      if (recheckPage != null) yield listingUrl(recheckPage);
    },
  },
  parse(html) {
    return parseHifidoListing(html);
  },
} satisfies ShopAdapter<string>;
