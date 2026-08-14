/**
 * AudioUnion listing-page diagnostics.
 *
 * The relay-fetched listing occasionally returns a page whose product links are present but whose
 * availability markup is not, which shows up as an unexplained item-count swing. This summary is
 * attached to the crawl-run message so that case can be told apart from a parser regression
 * without re-fetching the page.
 */

const PRODUCT_LINK = /(?:https?:\/\/www\.audiounion\.jp)?\/ct\/detail\/used\/(\d+)\/?/gi;
const POSITIVE_CONTEXT = /在庫あり|カートに入れる|購入する/i;
const SOLD_CONTEXT = /売約済み?|売り切れ|売切|sold\s*out|在庫なし|完売|品切れ|販売終了|ご成約/i;

/** How far around a product link to read for availability wording. */
const CONTEXT_BEFORE = 700;
const CONTEXT_AFTER = 900;

export interface AudioUnionPageDiagnostic {
  links: number;
  uniqueProducts: number;
  positiveContexts: number;
  soldContexts: number;
  neutralContexts: number;
  markers: Record<string, number>;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...String(value || "").matchAll(pattern)].length;
}

export function diagnoseAudioUnionHtml(html: string): AudioUnionPageDiagnostic {
  const text = String(html || "");
  const matches = [...text.matchAll(PRODUCT_LINK)];
  const seen = new Set<string>();
  let positiveContexts = 0;
  let soldContexts = 0;
  let neutralContexts = 0;

  for (const match of matches) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const start = Math.max(0, (match.index || 0) - CONTEXT_BEFORE);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + CONTEXT_AFTER);
    const context = text.slice(start, end);
    const positive = POSITIVE_CONTEXT.test(context);
    const sold = SOLD_CONTEXT.test(context);
    if (sold) soldContexts += 1;
    else if (positive) positiveContexts += 1;
    else neutralContexts += 1;
  }

  return {
    links: matches.length,
    uniqueProducts: seen.size,
    positiveContexts,
    soldContexts,
    neutralContexts,
    markers: {
      inStock: countMatches(text, /在庫あり/g),
      cart: countMatches(text, /カートに入れる/g),
      purchase: countMatches(text, /購入する/g),
      reserved: countMatches(text, /売約済み?/g),
      soldOutJa: countMatches(text, /売り切れ|売切/g),
      soldOutEn: countMatches(text, /sold\s*out/gi),
      noStock: countMatches(text, /在庫なし/g),
      completed: countMatches(text, /完売|品切れ|販売終了|ご成約/g),
    },
  };
}
