import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://sound-pit.jp";
const LIST_URL = `${BASE_URL}/pg98.html`;
const SOLD_PATTERN = /売約済(?:み)?|sold\s*out|販売終了|ご成約|在庫なし|完売|品切れ/iu;
const NEGOTIATING_PATTERN = /商談中|予約中|取り置き/iu;

export interface SoundPitPage extends CrawlPageObject {
  readonly kind: "index" | "detail";
  readonly soldOut?: boolean;
  readonly fallbackManufacturer?: string;
  readonly fallbackModel?: string;
  readonly fallbackCategory?: string;
}

function visibleLines(html: string): string[] {
  return String(html || "")
    .replace(/<script(?:[\s/][^>]*)?>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, " ")
    .replace(/<style(?:[\s/][^>]*)?>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|td|tr|section|article|figure)>/gi, "\n")
    .split(/\n+/u)
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function absoluteDetailUrl(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL || !/^\/pg\d+\.html$/u.test(url.pathname)) return null;
    if (url.toString() === LIST_URL) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sourceIdFromUrl(value: string): string | null {
  try {
    return new URL(value).pathname.match(/^\/pg(\d+)\.html$/u)?.[1] || null;
  } catch {
    return null;
  }
}

function fallbackFacts(fragment: string) {
  const lines = visibleLines(fragment).filter(
    (value) =>
      !/^(?:売約済(?:み)?|商談中|予約中|取り置き|NEW|NEW ITEM|中古商品|Used Audio)$/iu.test(value),
  );
  const tail = lines.slice(-3);
  return {
    fallbackManufacturer: tail.at(-3) || "",
    fallbackModel: tail.at(-2) || "",
    fallbackCategory: tail.at(-1) || "",
  };
}

export function discoverSoundPitDetails(html: string): SoundPitPage[] {
  const pages: SoundPitPage[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let segmentStart = 0;

  for (const match of String(html || "").matchAll(anchorRe)) {
    if (!/詳細はこちら/u.test(cleanText(match[3]))) continue;
    const url = absoluteDetailUrl(match[2]);
    if (!url || seen.has(url)) continue;

    const index = match.index ?? 0;
    const fragment = String(html).slice(segmentStart, index);
    segmentStart = index + match[0].length;
    const text = cleanText(fragment);
    const fallbacks = fallbackFacts(fragment);

    seen.add(url);
    pages.push({
      url,
      kind: "detail",
      soldOut: SOLD_PATTERN.test(text),
      ...fallbacks,
    });
  }

  return pages;
}

function productHeadings(html: string): string[] {
  return [...String(html || "").matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(
      (value) =>
        value &&
        !/Used Audio|中古商品|ハイエンド.*オーディオ専門店|SOUND PIT|サウンドピット/iu.test(value),
    );
}

function returnCategory(html: string): string {
  for (const match of String(html || "").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = cleanText(match[1]);
    if (!/一覧へ戻る/u.test(text)) continue;
    return cleanText(text.replace(/\s*\/?\s*一覧へ戻る.*$/u, "")).replace(/^Used\s+/iu, "");
  }
  return "";
}

function detailLeadText(html: string, model: string): string {
  const text = cleanText(html);
  const modelIndex = model ? text.indexOf(model) : -1;
  const start = modelIndex >= 0 ? modelIndex + model.length : 0;
  const returnIndex = text.indexOf("一覧へ戻る", start);
  const end = returnIndex >= 0 ? returnIndex : Math.min(text.length, start + 1600);
  return text.slice(start, Math.min(end, start + 1600));
}

function explicitCategory(leadText: string, fallback: string): string {
  const patterns = [
    /(?:ステレオ|モノラル)?\s*パワーアンプ/iu,
    /(?:コントロール|プリアンプ|プリアンプシステム)/iu,
    /プリメインアンプ/iu,
    /(?:SACD|CD)(?:\s*\/\s*(?:SACD|CD))?\s*プレーヤー(?:システム)?/iu,
    /D\s*\/\s*A\s*コンバーター/iu,
    /ネットワーク(?:オーディオ)?プレーヤー/iu,
    /(?:管球式)?\s*フォノイコライザー/iu,
    /ターンテーブル(?:\s*\/\s*トーンアーム)?/iu,
    /トーンアーム/iu,
    /カートリッジ/iu,
    /スピーカーケーブル/iu,
    /スピーカー/iu,
    /ヘッドホン/iu,
    /電源ケーブル/iu,
  ];
  for (const pattern of patterns) {
    const match = leadText.match(pattern)?.[0];
    if (match) return cleanText(match);
  }
  return fallback;
}

export function parseSoundPitDetail(
  html: string,
  page: Partial<SoundPitPage> = {},
): SellerProduct[] {
  if (page.kind === "index") return [];
  const sourceUrl = absoluteDetailUrl(page.url || "");
  const sourceId = sourceUrl ? sourceIdFromUrl(sourceUrl) : null;
  if (!sourceUrl || !sourceId) return [];

  const headings = productHeadings(html);
  const manufacturer = headings[0] || cleanText(page.fallbackManufacturer || "");
  const model = headings[1] || cleanText(page.fallbackModel || "");
  if (!manufacturer || !model) return [];

  const leadText = detailLeadText(html, model);
  const sellerCategory = returnCategory(html) || cleanText(page.fallbackCategory || "");
  const rawCategory = explicitCategory(leadText, sellerCategory);
  const negotiating = NEGOTIATING_PATTERN.test(leadText);
  const soldOut = Boolean(page.soldOut) || SOLD_PATTERN.test(leadText);
  const priceYen =
    soldOut || /(?:価格\s*)?[¥￥]?\s*ASK\b/iu.test(leadText) ? null : parseYen(leadText);
  const stockStatus = availabilityFromSignals({
    soldOut,
    inStock: !soldOut && !negotiating,
  });

  return [
    {
      sourceId,
      sourceUrl,
      title: model,
      rawManufacturer: manufacturer,
      manufacturer,
      model,
      rawCategory,
      category: inferCategory(leadText),
      conditionText: ["中古品", negotiating ? "商談中" : "", soldOut ? "売約済" : ""]
        .filter(Boolean)
        .join(" / "),
      priceYen,
      stockStatus,
      metadata: sellerCategory ? { soundPitCategory: sellerCategory } : {},
    },
  ];
}

export const soundPitAdapter = {
  key: "soundpit",
  name: "SOUND PIT",
  baseUrl: BASE_URL,
  discovery: {
    // pg98 is explicitly the latest-arrivals feed, not a complete inventory snapshot.
    coverage: "partial",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<SoundPitPage> {
      yield { url: LIST_URL, kind: "index" };
    },
    discoverTargets(html, page) {
      return page.kind === "index" ? discoverSoundPitDetails(html) : [];
    },
  },
  parse(html, page) {
    return parseSoundPitDetail(html, page);
  },
} satisfies ShopAdapter<SoundPitPage>;
