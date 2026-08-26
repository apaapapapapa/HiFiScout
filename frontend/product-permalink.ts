const PRODUCT_KEY_PATTERN = /^(?:c|l)-(\d{1,15})$/;
const PRODUCT_PERMALINK_PREFIX = "/p/";

/** Browser-side mirror of the public wire-key grammar; never imports server implementation code. */
export function validProductKey(value: string): boolean {
  const match = PRODUCT_KEY_PATTERN.exec(value);
  if (!match) return false;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0;
}

export function isProductPermalinkRoute(pathname: string): boolean {
  return pathname === "/p" || pathname.startsWith(PRODUCT_PERMALINK_PREFIX);
}

export function productKeyFromPermalinkPath(pathname: string): string | null {
  if (!pathname.startsWith(PRODUCT_PERMALINK_PREFIX)) return null;
  const key = pathname.slice(PRODUCT_PERMALINK_PREFIX.length);
  return key.includes("/") || !validProductKey(key) ? null : key;
}

export function productPermalinkPath(key: string): string | null {
  return validProductKey(key) ? `${PRODUCT_PERMALINK_PREFIX}${key}` : null;
}
