import { availabilityFromSignals } from "../availability.js";
import { cleanText, inferCategory, parseYen, splitManufacturerModel } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://www.homeshokai.jp";
const SOLD_PATTERN = /売約済(?:み)?|sold\s*out|販売終了|在庫なし|完売|品切れ/iu;
const NEGOTIATING_PATTERN = /^商談中(?:\s+|$)/u;

export const HOME_SHOKAI_CATEGORY_MAPPING = Object.freeze({
  プリアンプ: "pre_amp",
  真空管プリアンプ: "pre_amp",
  パワーアンプ: "power_amp",
  ステレオパワーアンプ: "power_amp",
  モノラルパワーアンプ: "power_amp",
  プリメインアンプ: "integrated_amp",
  スピーカー: "speaker",
  スピーカーシステム: "speaker",
  "SACD/CDプレーヤー": "cd_sacd_player",
  SACDプレーヤー: "cd_sacd_player",
  CDプレーヤー: "cd_sacd_player",
  "D/Aコンバータ": "dac",
  "D/Aコンバーター": "dac",
  DAコンバータ: "dac",
  DAコンバーター: "dac",
  DAC: "dac",
  ネットワークプレーヤー: "network_player",
  ネットワークプレイヤー: "network_player",
  レコードプレーヤー: "turntable",
  ターンテーブル: "turntable",
  トーンアーム: "tonearm",
  カートリッジ: "cartridge",
  MCステップアップトランス: "phono_step_up_transformer",
  昇圧トランス: "phono_step_up_transformer",
  フォノイコライザー: "phono_eq",
  ヘッドホンアンプ: "headphone_amp",
  ヘッドホン: "headphone",
  イヤホン: "earphone",
  XLRインターコネクトケーブル: "cable",
  RCAインターコネクトケーブル: "cable",
  インターコネクトケーブル: "cable",
  スピーカーケーブル: "cable",
  電源ケーブル: "cable",
  デジタルケーブル: "cable",
  USBケーブル: "cable",
  LANケーブル: "cable",
  ケーブル: "cable",
  アクセサリー: "accessory",
  インシュレータ: "accessory",
  インシュレーター: "accessory",
  真空管: "vacuum_tube",
  ラック: "rack",
});

export const HOME_SHOKAI_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({ default: "authoritative" as const }),
  parserHint: "corroborative" as const,
});

type HomeShokaiListingType = "consignment" | "special";

export interface HomeShokaiPage extends CrawlPageObject {
  readonly kind: "listing";
  readonly listingType: HomeShokaiListingType;
}

const HOME_SHOKAI_PAGES: readonly HomeShokaiPage[] = Object.freeze([
  {
    url: `${BASE_URL}/itemlist.php?a=2`,
    kind: "listing",
    listingType: "consignment",
  },
  {
    url: `${BASE_URL}/itemlist.php?a=3`,
    kind: "listing",
    listingType: "special",
  },
]);

const CATEGORY_NAMES =
  "プリアンプ\\s*\\+\\s*パワーアンプ|真空管プリアンプ|ステレオパワーアンプ|モノラルパワーアンプ|プリアンプ|パワーアンプ|プリメインアンプ|スピーカーシステム|スピーカー|SACD\\/CDプレーヤー|SACDプレーヤー|CDプレーヤー|ネットワークプレーヤー|ネットワークプレイヤー|レコードプレーヤー|ターンテーブル|D\\/Aコンバータ(?:ー)?|DAコンバータ(?:ー)?|DAC|ネットワークトランスポート|CDトランスポート|SACDトランスポート|MCステップアップトランス|昇圧トランス|フォノイコライザー|フォノアンプ|トーンアーム|カートリッジ|ヘッドシェル|ヘッドホンアンプ|ヘッドホン|イヤホン|チャンネルデバイダー|FMチューナー|チューナー|XLRインターコネクトケーブル|RCAインターコネクトケーブル|インターコネクトケーブル|スピーカーケーブル|電源ケーブル|デジタルケーブル|USBケーブル|LANケーブル|ケーブル|インシュレータ(?:ー)?|アクセサリー|真空管|ラック";
const PRODUCT_FACTS_RE = new RegExp(`^(.+?)\\s+(${CATEGORY_NAMES})\\s+(.+)$`, "iu");

interface ProductReference {
  readonly sourceId: string;
  readonly sourceUrl: string;
}

function productReference(href: string): ProductReference | null {
  try {
    const url = new URL(String(href || "").replaceAll("&amp;", "&"), BASE_URL);
    if (url.hostname.replace(/^www\./u, "") !== "homeshokai.jp") return null;
    if (url.pathname !== "/item.php") return null;
    const sourceId = cleanText(url.searchParams.get("z") || "");
    if (!sourceId || !/^[A-Za-z0-9_-]+$/u.test(sourceId)) return null;
    return {
      sourceId,
      sourceUrl: `${BASE_URL}/item.php?z=${encodeURIComponent(sourceId)}`,
    };
  } catch {
    return null;
  }
}

function listingLabel(type: HomeShokaiListingType | undefined): string {
  if (type === "consignment") return "委託販売品";
  if (type === "special") return "特価品";
  return "";
}

interface ListingFacts {
  readonly manufacturer: string;
  readonly model: string;
  readonly rawCategory: string;
  readonly listingLabel: string;
  readonly priceYen: number | null;
  readonly negotiating: boolean;
  readonly soldOut: boolean;
}

function splitProductFacts(core: string): Pick<ListingFacts, "manufacturer" | "model" | "rawCategory"> {
  const direct = core.match(PRODUCT_FACTS_RE);
  if (direct) {
    return {
      manufacturer: cleanText(direct[1]),
      rawCategory: cleanText(direct[2]),
      model: cleanText(direct[3]),
    };
  }

  const split = splitManufacturerModel(core, "home-shokai");
  return {
    manufacturer: cleanText(split.manufacturer),
    model: cleanText(split.model) || core,
    rawCategory: inferCategory(core),
  };
}

function listingFacts(text: string, expectedType?: HomeShokaiListingType): ListingFacts | null {
  const normalized = cleanText(text).normalize("NFKC");
  const marker = normalized.match(/\s*[〇○]?\s*(委託販売品|特価品)\s*/u);
  if (!marker || marker.index === undefined) return null;

  const expectedLabel = listingLabel(expectedType);
  if (expectedLabel && marker[1] !== expectedLabel) return null;

  let core = normalized.slice(0, marker.index).trim();
  const negotiating = NEGOTIATING_PATTERN.test(core);
  core = core.replace(NEGOTIATING_PATTERN, "").trim();
  if (!core) return null;

  const product = splitProductFacts(core);
  if (!product.manufacturer || !product.model) return null;

  const suffix = normalized.slice(marker.index + marker[0].length);
  const soldOut = SOLD_PATTERN.test(normalized);
  return {
    ...product,
    listingLabel: marker[1],
    priceYen: parseYen(suffix),
    negotiating,
    soldOut,
  };
}

export function parseHomeShokaiListing(
  html: string,
  page: Partial<HomeShokaiPage> = {},
): SellerProduct[] {
  const products = new Map<string, SellerProduct>();
  const anchorRe = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || "").matchAll(anchorRe)) {
    const reference = productReference(match[2]);
    if (!reference || products.has(reference.sourceId)) continue;

    const facts = listingFacts(match[3], page.listingType);
    if (!facts) continue;

    const title = cleanText(`${facts.manufacturer} ${facts.model}`);
    const conditionText = [facts.negotiating ? "商談中" : "", facts.soldOut ? "売約済" : ""]
      .filter(Boolean)
      .join(" / ");

    products.set(reference.sourceId, {
      sourceId: reference.sourceId,
      sourceUrl: reference.sourceUrl,
      title,
      rawManufacturer: facts.manufacturer,
      manufacturer: facts.manufacturer,
      model: facts.model,
      rawCategory: facts.rawCategory,
      category: facts.rawCategory || inferCategory(title),
      conditionText,
      priceYen: facts.soldOut ? null : facts.priceYen,
      stockStatus: availabilityFromSignals({
        soldOut: facts.soldOut,
        inStock: !facts.soldOut && !facts.negotiating,
      }),
      metadata: {
        homeShokaiListingType: facts.listingLabel,
        ...(page.url ? { listingUrl: page.url } : {}),
      },
    });
  }

  return [...products.values()];
}

export const homeShokaiAdapter = {
  key: "home-shokai",
  name: "ホーム商会",
  baseUrl: BASE_URL,
  discovery: {
    coverage: "complete",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<HomeShokaiPage> {
      yield* HOME_SHOKAI_PAGES;
    },
  },
  parse(html, page) {
    return parseHomeShokaiListing(html, page);
  },
} satisfies ShopAdapter<HomeShokaiPage>;
