import { stripRawTextElements } from "../../html/raw-text.js";
import { availabilityFromSignals } from "../availability.js";
import {
  listingAttribute,
  listingBlocks,
  listingFieldHtml,
  listingFieldText,
} from "../listing-fields.js";
import { cleanText, inferCategory, parseYen } from "../normalize.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = "https://www.e-earphone.jp";
const COLLECTION_PATH = "/collections/recently-used";

// Seller collection IDs/labels observed on 2026-09-19. Membership must match the card's
// product ID and handle. Missing membership is never evidence that a listing has sold.
const IN_STOCK_COLLECTION = "463439855857"; // 【中古】在庫数1以上
const CATEGORY_COLLECTIONS: Readonly<Record<string, string>> = Object.freeze({
  "446590746865": "中古有線イヤホン",
  "446589862129": "中古有線ヘッドホン",
  "446776312049": "中古完全ワイヤレスイヤホン (5千円以上)",
  "456897757425": "中古完全ワイヤレスイヤホン (5千円未満)",
  "446590058737": "中古左右一体型ワイヤレスイヤホン",
  "446591140081": "中古ワイヤレスヘッドホン",
  "446590943473": "中古プレイヤー",
  "446591205617": "中古アンプ・DAC",
  "446591172849": "中古ケーブル",
  "446589305073": "中古スピーカー",
  "446590255345": "中古アクセサリ",
});
const RANK_COLLECTIONS: Readonly<Record<string, string>> = Object.freeze({
  "464455336177": "A",
  "464455762161": "B",
  "464455041265": "未",
});

export const E_EARPHONE_CATEGORY_MAPPING = Object.freeze({
  中古有線イヤホン: "wired_earphone",
  中古有線ヘッドホン: "wired_headphone",
  "中古完全ワイヤレスイヤホン (5千円以上)": "btw_earphone",
  "中古完全ワイヤレスイヤホン (5千円未満)": "btw_earphone",
  中古左右一体型ワイヤレスイヤホン: "btw_earphone",
  中古ワイヤレスヘッドホン: "btw_headphone",
  中古プレイヤー: "dap",
  // The mixed 中古アンプ・DAC bucket has no deterministic leaf. Leave it unmapped so
  // shared raw-label inference stays corroborative and product-specific evidence decides.
  中古ケーブル: "cable",
  中古スピーカー: "speaker",
  中古アクセサリ: "accessory",
});

export interface EEarphonePage extends CrawlPageObject {
  page: number;
}

function listingPage(page: number): EEarphonePage {
  return { url: `${BASE_URL}${COLLECTION_PATH}${page > 1 ? `?page=${page}` : ""}`, page };
}

function cardReference(
  card: string,
): { sourceId: string; productId: string; sourceUrl: string } | null {
  const attributes = card.match(/^<div\b([^>]*)>/i)?.[1] || "";
  const sourceId = listingAttribute(attributes, "data-product-handle");
  const productId = listingAttribute(attributes, "data-product-id");
  if (!/^\d+$/.test(sourceId) || !/^\d+$/.test(productId)) return null;
  for (const anchor of card.matchAll(/<a\b([^>]*)>/gi)) {
    if (!listingAttribute(anchor[1], "class").split(/\s+/).includes("grid-product__meta")) continue;
    try {
      const url = new URL(cleanText(listingAttribute(anchor[1], "href")), BASE_URL);
      const id = url.pathname.match(/^\/(?:collections\/[^/]+\/)?products\/(\d+)\/?$/)?.[1];
      if (url.origin !== BASE_URL || url.username || url.password || id !== sourceId) continue;
      return { sourceId, productId, sourceUrl: `${BASE_URL}/products/${sourceId}` };
    } catch {
      // A malformed seller link cannot identify a listing.
    }
  }
  return null;
}

function collectionIds(card: string, sourceId: string, productId: string): string[] {
  const ids = new Set<string>();
  for (const span of card.matchAll(/<span\b([^>]*)>/gi)) {
    if (!listingAttribute(span[1], "class").split(/\s+/).includes("col_clct")) continue;
    const json = listingAttribute(span[1], "clct");
    if (!json || json.length > 20_000) continue;
    try {
      const values: unknown = JSON.parse(cleanText(json));
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        if (value.product_handle !== sourceId || value.product_id !== productId) continue;
        if (typeof value.collection_id === "string" && /^\d+$/.test(value.collection_id)) {
          ids.add(value.collection_id);
        }
      }
    } catch {
      // Malformed metadata stays unknown; visible seller facts remain usable.
    }
  }
  return [...ids];
}

export function parseEEarphoneListing(html: string): SellerProduct[] {
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const products = new Map<string, SellerProduct>();
  for (const card of listingBlocks(source, "div", "grid-product")) {
    const reference = cardReference(card);
    if (!reference || products.has(reference.sourceId)) continue;
    const title = listingFieldText(card, "grid-product__title");
    if (!title.startsWith("【中古】")) continue;
    const storeName = title.match(/【(秋葉原|日本橋|名古屋|仙台)】\s*$/)?.[1] || "";
    const model = title
      .replace(/^【中古】\s*/, "")
      .replace(/【(秋葉原|日本橋|名古屋|仙台)】\s*$/, "")
      .trim();
    if (!model) continue;
    const manufacturer = listingFieldText(card, "grid-product__vendor");
    const ids = collectionIds(card, reference.sourceId, reference.productId);
    const categories = [...new Set(ids.map((id) => CATEGORY_COLLECTIONS[id]).filter(Boolean))];
    const rawCategory = categories.length === 1 ? categories[0] : "";
    const ranks = [...new Set(ids.map((id) => RANK_COLLECTIONS[id]).filter(Boolean))];
    const visibleRank = listingFieldText(card, "rank").match(/(?:中古)?ランク\s*([SABCD未])/)?.[1];
    const rank = visibleRank || (ranks.length === 1 ? ranks[0] : "");
    const tags = listingFieldText(card, "grid-product__tags");
    const priceYen = parseYen(
      listingFieldText(card, "grid-product__price--save") ||
        listingFieldText(card, "grid-product__price--regurar"),
    );
    products.set(reference.sourceId, {
      sourceId: reference.sourceId,
      sourceUrl: reference.sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model,
      rawCategory,
      category: inferCategory(model),
      conditionText: rank ? `中古ランク ${rank}` : "中古",
      priceYen: priceYen != null && priceYen > 0 ? priceYen : null,
      stockStatus: availabilityFromSignals({
        inStock: ids.includes(IN_STOCK_COLLECTION) || /在庫あり/.test(tags),
        soldOut: /売り切れ|売切れ|在庫なし|完売|SOLD\s*OUT/i.test(tags),
      }),
      metadata: {
        sellerProductId: reference.productId,
        sellerCollectionIds: ids,
        ...(storeName ? { storeName } : {}),
        ...(rank ? { usedRank: rank } : {}),
      },
    });
  }
  return [...products.values()];
}

export const eEarphoneAdapter = {
  key: "e-earphone",
  name: "e☆イヤホン",
  baseUrl: BASE_URL,
  discovery: {
    // The recent-arrivals feed is not a full inventory snapshot, even at its last page.
    coverage: "partial",
    policy: { emptyPage: "stop", itemCountValidation: "always", extraPageBudget: 0 },
    *initialTargets(): Generator<EEarphonePage> {
      yield listingPage(1);
    },
    discoverTargets(html: string, page: EEarphonePage): EEarphonePage[] | null {
      const source = stripRawTextElements(html, ["script", "style", "noscript"]);
      const pagination = listingFieldHtml(source, "pagination");
      const next = listingFieldHtml(pagination, "next");
      if (!next) {
        return listingFieldHtml(source, "collection-grid__wrapper") ? [] : null;
      }
      const href = next.match(/<a\b([^>]*)>/i)?.[1] || "";
      try {
        const url = new URL(cleanText(listingAttribute(href, "href")), BASE_URL);
        if (
          url.origin !== BASE_URL ||
          url.username ||
          url.password ||
          url.pathname !== COLLECTION_PATH
        )
          return null;
        if ([...url.searchParams.keys()].some((key) => key !== "page")) return null;
        if (url.searchParams.getAll("page").length !== 1) return null;
        if (url.searchParams.get("page") !== String(page.page + 1)) return null;
        return [listingPage(page.page + 1)];
      } catch {
        return null;
      }
    },
  },
  parse: parseEEarphoneListing,
} satisfies ShopAdapter<EEarphonePage>;
