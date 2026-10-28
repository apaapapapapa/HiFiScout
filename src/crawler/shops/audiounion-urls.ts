/** Public category routes observed after AudioUnion's October 2026 storefront renewal. */
export const AUDIOUNION_ORIGIN = "https://www.audiounion.jp";
export const AUDIOUNION_LEGACY_ENTRY_URL = `${AUDIOUNION_ORIGIN}/st/new_arrival_used.html`;
export const AUDIOUNION_CATEGORIES = Object.freeze([
  "amp-integrated-all",
  "amp-control-all",
  "amp-power-all",
  "sp-all",
  "cdp-all",
  "analog-all",
  "network-pc-all",
  "hp-all",
  "acc-all",
  "other-all",
  "media-books-all",
]);

function storefrontUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === AUDIOUNION_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

export function audioUnionCategoryPage(value: string): { category: string; page: number } | null {
  const url = storefrontUrl(value);
  const match = url?.pathname.match(/^\/shop\/c\/c([a-z-]+)(?:_p([1-9]\d{0,3}))?_lS\/$/);
  return match && AUDIOUNION_CATEGORIES.includes(match[1])
    ? { category: match[1], page: Number(match[2] || 1) }
    : null;
}

export function audioUnionGoodsCode(value: string): string | null {
  return storefrontUrl(value)?.pathname.match(/^\/shop\/g\/g([0-9A-Za-z-]{1,40})\/$/)?.[1] || null;
}
