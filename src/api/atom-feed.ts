import type { ProductOffer, ProductSearchItem } from "./contracts.js";

const EMPTY_FEED_UPDATED = "1970-01-01T00:00:00.000Z";

/**
 * Escape untrusted seller text for XML 1.0 and remove characters XML cannot represent.
 *
 * Iterating by Unicode code point preserves valid astral characters while rejecting unpaired
 * surrogates and the C0 control range except tab, LF, and CR.
 */
export function escapeXml(value: string): string {
  const valid = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      );
    })
    .join("");
  return valid
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function timestamp(value: string | null | undefined): string {
  if (!value) return EMPTY_FEED_UPDATED;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : EMPTY_FEED_UPDATED;
}

function itemUpdated(item: ProductSearchItem): string {
  return timestamp(
    item.latest_activity_at ??
      item.newest_listed_at ??
      item.representative_offer?.last_activity_at ??
      item.representative_offer?.last_seen_at ??
      item.representative_offer?.first_seen_at,
  );
}

function feedUpdated(items: readonly ProductSearchItem[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const parsed = Date.parse(itemUpdated(item));
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : EMPTY_FEED_UPDATED;
}

function yen(value: number): string {
  return `${Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}円`;
}

function priceSummary(item: ProductSearchItem): string | null {
  const low = item.lowest_price_yen;
  const high = item.highest_price_yen;
  if (low == null && high == null) return null;
  if (low == null) return yen(high!);
  if (high == null || high === low) return yen(low);
  return `${yen(low)}〜${yen(high)}`;
}

function stockLabel(offer: ProductOffer | null): string | null {
  if (!offer) return null;
  if (offer.stock_status === "in_stock") return "在庫あり";
  if (offer.stock_status === "sold_out") return "売り切れ";
  return "在庫状況不明";
}

function factualContent(item: ProductSearchItem): string {
  const offer = item.representative_offer;
  const facts: Array<[string, string | number | null | undefined]> = [
    ["メーカー", item.manufacturer],
    ["型番", item.model],
    ["カテゴリ", item.category],
    ["価格", priceSummary(item)],
    ["商品状態", offer?.condition_text],
    ["在庫", stockLabel(offer)],
    ["代表ショップ", offer?.shop_key],
    ["掲載ショップ数", item.shop_count],
    ["出品数", item.offer_count],
  ];
  return facts
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([label, value]) => `${label}: ${String(value)}`)
    .join("\n");
}

function entryTitle(item: ProductSearchItem): string {
  const offerTitle = item.representative_offer?.title.trim();
  if (offerTitle) return offerTitle;
  return [item.manufacturer, item.model].filter(Boolean).join(" ") || item.key;
}

function atomEntry(item: ProductSearchItem): string {
  const offer = item.representative_offer;
  const link = offer?.source_url ? `\n    <link href="${escapeXml(offer.source_url)}" />` : "";
  return `  <entry>
    <id>${escapeXml(`urn:hifiscout:product:${item.key}`)}</id>
    <title>${escapeXml(entryTitle(item))}</title>
    <updated>${itemUpdated(item)}</updated>${link}
    <content type="text">${escapeXml(factualContent(item))}</content>
  </entry>`;
}

/** Serialize a product-search page as deterministic Atom XML. */
export function productSearchAtomFeed(
  items: readonly ProductSearchItem[],
  canonicalUrl: URL,
): string {
  const self = canonicalUrl.toString();
  const entries = items.map(atomEntry).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(self)}</id>
  <title>HiFiScout — 保存した検索</title>
  <updated>${feedUpdated(items)}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeXml(self)}" />
  <author><name>HiFiScout</name></author>${entries ? `\n${entries}` : ""}
</feed>\n`;
}
