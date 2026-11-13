import { collectListingCategoryEvidence } from "../../catalog/category-evidence.js";
import { availabilityFromSignals } from "../availability.js";
import { discoverLinkedPages } from "../html-listing.js";
import { listingAttribute, listingBlocks, listingFieldHtml } from "../listing-fields.js";
import { stripRawTextElements } from "../../html/raw-text.js";
import { cleanText, parseYen, splitManufacturerModel } from "../normalize.js";
import type { StockStatus } from "../../catalog/types.js";
import type { CrawlPageObject, SellerProduct, ShopAdapter } from "../types.js";

const SHOP_KEY = "soundpitplus";
const BASE_URL = "https://soundpit-plus.com";
const LISTING_PATH = "/used-products/";
const PAGE_PARAM = "sp_page";
const DETAIL_PATH_RE = /^\/products\/[^/?#]+\/$/u;
const POST_CLASS_RE = /^post-(\d+)$/u;
const CATEGORY_LINK_RE = /[?&]sp_category=[a-z0-9_-]+(?:&|$)/iu;

/** Labels the seller writes as `ラベル：値` paragraphs; only these become seller facts. */
const FIELD_LABELS = ["製品名", "付属品", "元箱", "カラー"] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];
const FIELD_RE = new RegExp(`^(${FIELD_LABELS.join("|")})\\s*[：:]\\s*(.+)$`, "u");

/** A leading seller marker such as `【委託品】`; it is listing context, not part of the name. */
const LEADING_LABEL_RE = /^【([^】]{1,20})】\s*/u;
const CONSIGNMENT_RE = /委託/u;
const NEGOTIATING_RE = /商談中|ご商談|HOLD|予約済|取り置き/iu;
const ASK_RE = /\bASK\b/iu;

/**
 * Exact product-type labels from the seller's detail lead (`…のプリアンプ「C-3900」…`). The listing
 * buckets AMPLIFIER / PLAYER / ACCESSORY each span several leaves and stay unmapped.
 */
export const SOUNDPITPLUS_CATEGORY_MAPPING = Object.freeze({
  プリアンプ: "AMP.PRE",
  コントロールアンプ: "AMP.PRE",
  パワーアンプ: "AMP.POWER",
  ステレオパワーアンプ: "AMP.POWER",
  モノラルパワーアンプ: "AMP.POWER",
  プリメインアンプ: "AMP.INTEGRATED",
  フォノイコライザー: "AMP.PHONO",
  SACDプレイヤー: "SRC.DISC",
  SACDプレーヤー: "SRC.DISC",
  CDプレイヤー: "SRC.DISC",
  CDプレーヤー: "SRC.DISC",
  ネットワークプレイヤー: "SRC.STREAMER",
  ネットワークプレーヤー: "SRC.STREAMER",
  "D/Aコンバーター": "PRC.DAC",
  "D/Aコンバータ": "PRC.DAC",
  マスタークロック: "PRC.CLOCK",
  アナログプレイヤー: "ANA.TURNTABLE",
  アナログプレーヤー: "ANA.TURNTABLE",
  レコードプレイヤー: "ANA.TURNTABLE",
  レコードプレーヤー: "ANA.TURNTABLE",
  ターンテーブル: "ANA.TURNTABLE",
  トーンアーム: "ANA.TONEARM",
  電源ユニット: "PWR.SUPPLY",
  スピーカー: "SPK.LOUDSPEAKER",
});

export interface SoundPitPlusPage extends CrawlPageObject {
  readonly kind: "listing" | "detail";
  /** Listing page number; page 1 is the bare `/used-products/` URL. */
  readonly page?: number;
  /** WordPress post id read from the listing card, re-checked against the detail page. */
  readonly postId?: string;
  /** The listing card's explicit SOLD term at discovery time. */
  readonly listingSold?: boolean;
  /** Unknown listing status terms must survive the detail fetch, not become available evidence. */
  readonly listingUnknownStatus?: boolean;
}

function listingPage(page: number): SoundPitPlusPage {
  const url = new URL(LISTING_PATH, BASE_URL);
  if (page > 1) url.searchParams.set(PAGE_PARAM, String(page));
  return { url: url.toString(), kind: "listing", page };
}

/** Only the unfiltered used-product listing paginates here; category filters are not followed. */
function listingPageNumber(url: URL): number | null {
  if (url.origin !== BASE_URL || url.pathname !== LISTING_PATH) return null;
  const keys = [...url.searchParams.keys()];
  if (!keys.length) return 1;
  if (keys.length !== 1 || keys[0] !== PAGE_PARAM) return null;
  const value = url.searchParams.get(PAGE_PARAM) || "";
  return /^[1-9]\d{0,3}$/u.test(value) ? Number(value) : null;
}

function canonicalDetailUrl(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);
    if (url.origin !== BASE_URL || !DETAIL_PATH_RE.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function classNames(attributes: string): Set<string> {
  return new Set(listingAttribute(attributes, "class").split(/\s+/u).filter(Boolean));
}

function postId(classes: ReadonlySet<string>): string | null {
  for (const value of classes) {
    const id = value.match(POST_CLASS_RE)?.[1];
    if (id) return id;
  }
  return null;
}

/** WordPress `product_status` terms on a post: `used`, `sold`, and any other seller state. */
function productStatuses(classes: ReadonlySet<string>): Set<string> {
  return new Set(
    [...classes]
      .filter((value) => value.startsWith("product_status-"))
      .map((value) => value.slice("product_status-".length)),
  );
}

function hasUnrecognizedStatus(statuses: ReadonlySet<string>): boolean {
  return [...statuses].some((status) => status !== "used" && status !== "sold");
}

function openingAttributes(block: string): string {
  return block.match(/^<[a-z]+\b([^>]*)>/iu)?.[1] || "";
}

/** One product card of the listing grid, scoped to its own `<article>`. */
function listingCards(html: string): SoundPitPlusPage[] {
  const pages: SoundPitPlusPage[] = [];
  for (const card of listingBlocks(html, "article", "wp-block-post")) {
    const classes = classNames(openingAttributes(card));
    const id = postId(classes);
    if (!id || !classes.has("type-products")) continue;
    const statuses = productStatuses(classes);
    if (!statuses.has("used")) continue;
    const titleHtml = card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/iu)?.[1] || "";
    const href = titleHtml.match(/<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1/iu)?.[2] || "";
    const url = canonicalDetailUrl(href);
    if (!url) continue;
    pages.push({
      url,
      kind: "detail",
      postId: id,
      listingSold: statuses.has("sold"),
      ...(hasUnrecognizedStatus(statuses) ? { listingUnknownStatus: true } : {}),
    });
  }
  return pages;
}

/**
 * Listing pages expose names and SOLD terms but no prices, so each card becomes a detail target.
 * Pagination comes from the seller's own page navigation for the same unfiltered listing.
 */
export function discoverSoundPitPlusTargets(
  html: string,
  page: SoundPitPlusPage,
): SoundPitPlusPage[] | null {
  if (page.kind !== "listing") return [];
  html = stripRawTextElements(html);
  if (!/\bct-query-template-grid\b/u.test(html)) return null;
  const navigation = html.match(/<nav\b[^>]*\bspcn-pages\b[^>]*>[\s\S]*?<\/nav>/iu)?.[0] || "";
  const pages = discoverLinkedPages(navigation, {
    baseUrl: BASE_URL,
    currentPage: page.page ?? 1,
    pageNumber: listingPageNumber,
    createPage: listingPage,
  });
  return [...pages, ...listingCards(html)];
}

interface DetailFields {
  readonly title: string;
  readonly fields: ReadonlyMap<FieldLabel, string>;
  readonly priceText: string;
  readonly sellerCategory: string;
  readonly content: string;
}

function comparableName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

interface LeadFacts {
  /** The product type written right before the quoted model, e.g. `プリメインアンプ`. */
  readonly productType: string;
  /** The model name the seller quotes, e.g. `A-3`. */
  readonly quotedName: string;
}

const NO_LEAD: LeadFacts = Object.freeze({ productType: "", quotedName: "" });

/**
 * The seller's lead names this product's type right before its quoted model, as in
 * `ソウルノートのプリメインアンプ「A-3」の中古品です。`. Only the first quoting paragraph is read, and
 * only when its quoted name is part of this product's own title; later paragraphs compare other
 * models and are never used.
 */
function leadFacts(content: string, title: string): LeadFacts {
  for (const match of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)) {
    const text = cleanText(match[1]);
    if (FIELD_RE.test(text) || !text.includes("「")) continue;
    const quoted = text.match(/^([^「」]{1,80})「([^「」]{1,80})」/u);
    if (!quoted) return NO_LEAD;
    const quotedName = quoted[2].trim();
    if (quotedModelOffset(title, quotedName) < 0) return NO_LEAD;
    // The type is the last noun phrase: `光カートリッジ専用真空管式フォノイコライザー` names a phono
    // equalizer, and the qualifiers before `専用` / `式` describe what it serves or how it is built.
    const phrase =
      quoted[1]
        .split(/の|、|が開発した|専用|式/u)
        .at(-1)
        ?.trim() || "";
    return { productType: phrase.length >= 2 && phrase.length <= 30 ? phrase : "", quotedName };
  }
  return NO_LEAD;
}

/**
 * Match the entire quoted model to a title component, not a prefix of a different revision
 * (A-3 vs A-30 / A-3 MKII). Separators may differ (U・BROS vs U-BROS), and a separately
 * priced bundle may append " + <another model>" without changing the first model's identity.
 */
function quotedModelOffset(title: string, quotedName: string): number {
  const expected = comparableName(quotedName);
  if (expected.length < 2) return -1;
  const starts = [
    0,
    ...[...title.matchAll(/\s+/gu)].map((match) => (match.index ?? 0) + match[0].length),
  ];
  return (
    starts.find(
      (start) => comparableName(title.slice(start).split(/\s+\+\s+/u, 1)[0]) === expected,
    ) ?? -1
  );
}

/** Preserve the seller's entire maker spelling before a verified model (including multi-word makers). */
function manufacturerModel(
  title: string,
  quotedName: string,
): { manufacturer: string; model: string } {
  const index = quotedModelOffset(title, quotedName);
  if (index < 0) return splitManufacturerModel(title, SHOP_KEY);
  return { manufacturer: title.slice(0, index).trim(), model: title.slice(index).trim() };
}

/** A lead phrase replaces the seller's broad bucket only when it is a recognized seller label. */
function recognizedSellerCategory(value: string): boolean {
  return collectListingCategoryEvidence({
    rawCategory: value,
    categoryMapping: SOUNDPITPLUS_CATEGORY_MAPPING,
  }).evidence.some((item) => item.source === "seller_category");
}

function detailFields(article: string): DetailFields {
  const headerTitle = cleanText(
    article.match(/<h1\b[^>]*\bpage-title\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] || "",
  );
  const content = listingFieldHtml(article, "entry-content");
  const fields = new Map<FieldLabel, string>();
  for (const match of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)) {
    const field = cleanText(match[1]).match(FIELD_RE);
    if (!field) continue;
    const label = field[1] as FieldLabel;
    if (!fields.has(label)) fields.set(label, field[2].trim());
  }
  // The post's own tag list links its seller bucket (`#AMPLIFIER`) to the filtered listing.
  const tags = listingFieldHtml(content, "spcn-detail-tags");
  const categoryLink = [...tags.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)].find((match) =>
    CATEGORY_LINK_RE.test(listingAttribute(match[1], "href")),
  );
  const sellerCategory = cleanText(categoryLink?.[2] || "").replace(/^#\s*/u, "");
  return {
    title: headerTitle || fields.get("製品名") || "",
    fields,
    priceText: cleanText(listingFieldHtml(content, "item-price")),
    sellerCategory,
    content,
  };
}

function detailMetadata(
  fields: ReadonlyMap<FieldLabel, string>,
  listingLabel: string,
  sellerCategory: string,
  consignment: boolean,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (sellerCategory) metadata.soundPitPlusCategory = sellerCategory;
  if (listingLabel) metadata.listingLabel = listingLabel;
  if (consignment) metadata.consignment = true;
  const accessories = fields.get("付属品");
  if (accessories) metadata.accessories = accessories;
  const originalBox = fields.get("元箱");
  if (originalBox) metadata.originalBox = originalBox;
  const color = fields.get("カラー");
  if (color) metadata.color = color;
  return metadata;
}

/**
 * Product facts come from the detail page's own post: its header title, the labelled
 * `item-price` and `ラベル：値` paragraphs, and the seller's `product_status` terms. Neighbouring
 * products in the post navigation, descriptions and images are never read.
 */
export function parseSoundPitPlusDetail(
  html: string,
  page: Partial<SoundPitPlusPage> = {},
): SellerProduct[] {
  if (page.kind !== "detail") return [];
  const sourceUrl = canonicalDetailUrl(page.url || "");
  if (!sourceUrl) return [];
  html = stripRawTextElements(html);

  // The page's own post; a card's post id must match it (a redirect to another post yields nothing).
  const article = listingBlocks(html, "article", "type-products").find((block) => {
    const id = postId(classNames(openingAttributes(block)));
    return id !== null && (!page.postId || id === page.postId);
  });
  if (!article) return [];
  const classes = classNames(openingAttributes(article));
  const sourceId = postId(classes);
  if (!sourceId) return [];

  const { title: rawTitle, fields, priceText, sellerCategory, content } = detailFields(article);
  const listingLabel = rawTitle.match(LEADING_LABEL_RE)?.[1]?.trim() || "";
  const title = cleanText(rawTitle.replace(LEADING_LABEL_RE, ""));
  if (!title) return [];
  const { productType, quotedName } = leadFacts(content, title);
  const rawCategory =
    productType && recognizedSellerCategory(productType) ? productType : sellerCategory;

  const priceSeparator = priceText.search(/[：:]/u);
  const priceLabel = priceSeparator > 0 ? priceText.slice(0, priceSeparator).trim() : "";
  const priceValue = priceSeparator >= 0 ? priceText.slice(priceSeparator + 1) : priceText;

  const statuses = productStatuses(classes);
  const detailSold = statuses.has("sold");
  // Any status term the seller adds beyond USED/SOLD (or a negotiating marker) is not proof that
  // the product can still be bought.
  const unrecognizedStatus =
    hasUnrecognizedStatus(statuses) || page.listingUnknownStatus === true;
  const negotiating = NEGOTIATING_RE.test(`${listingLabel} ${priceText}`);
  const detailAvailable =
    statuses.has("used") && !detailSold && !unrecognizedStatus && !negotiating;
  // The listing card and the detail page observe the same post moments apart; if their SOLD
  // terms disagree, or either has an unknown term, neither observation is conclusive.
  const listingContradicts = page.listingSold !== undefined && page.listingSold !== detailSold;
  const stockStatus: StockStatus = listingContradicts || unrecognizedStatus
    ? "unknown"
    : availabilityFromSignals({ soldOut: detailSold, inStock: detailAvailable });
  const soldOut = detailSold || page.listingSold === true;

  const { manufacturer, model } = manufacturerModel(title, quotedName);
  const consignment = CONSIGNMENT_RE.test(`${listingLabel} ${priceLabel}`);

  return [
    {
      sourceId,
      sourceUrl,
      title,
      rawManufacturer: manufacturer,
      manufacturer,
      model: model || title,
      rawCategory,
      category: "",
      conditionText: ["中古品", consignment ? "委託品" : "", negotiating ? "商談中" : ""]
        .filter(Boolean)
        .join(" / "),
      priceYen: soldOut || ASK_RE.test(priceValue) ? null : parseYen(priceValue),
      stockStatus,
      metadata: detailMetadata(fields, listingLabel, sellerCategory, consignment),
    },
  ];
}

export const soundPitPlusAdapter = {
  key: SHOP_KEY,
  name: "SOUNDPIT+",
  baseUrl: BASE_URL,
  discovery: {
    // Listing pages carry no prices, so they parse no products and each card is fetched as its
    // own detail target. A listing page without products already marks the run's coverage
    // incomplete, and a failed detail fetch cannot prove a sale: absent listings are never
    // deactivated from this crawl. Sold products stay listed with the seller's SOLD term.
    coverage: "partial",
    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<SoundPitPlusPage> {
      yield listingPage(1);
    },
    discoverTargets(html, page) {
      return discoverSoundPitPlusTargets(html, page);
    },
  },
  parse(html, page) {
    return parseSoundPitPlusDetail(html, page);
  },
} satisfies ShopAdapter<SoundPitPlusPage>;
