import { parseProductSearchKey } from "./product-search-key.js";

/** Public, bookmarkable product-detail route. */
export const PRODUCT_PERMALINK_PREFIX = "/p/";

/** True for the permalink namespace, including malformed paths that must not fall through to SPA. */
export function isProductPermalinkRoute(pathname: string): boolean {
  return pathname === "/p" || pathname.startsWith(PRODUCT_PERMALINK_PREFIX);
}

/** Returns the canonical product key only for an exact `/p/<key>` path. */
export function productKeyFromPermalinkPath(pathname: string): string | null {
  if (!pathname.startsWith(PRODUCT_PERMALINK_PREFIX)) return null;
  const key = pathname.slice(PRODUCT_PERMALINK_PREFIX.length);
  if (!key || key.includes("/") || !parseProductSearchKey(key)) return null;
  return key;
}

/** Builds a permalink only for a valid public product key. */
export function productPermalinkPath(key: string): string | null {
  return parseProductSearchKey(key) ? `${PRODUCT_PERMALINK_PREFIX}${key}` : null;
}
