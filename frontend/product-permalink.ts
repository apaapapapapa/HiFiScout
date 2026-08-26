const PRODUCT_KEY_PATTERN = /^(?:c|l)-[1-9]\d{0,14}$/;
const PRODUCT_PERMALINK_PREFIX = "/p/";

/** Browser-side mirror of the public wire-key grammar; never imports server implementation code. */
export function validProductKey(value: string): boolean {
  return PRODUCT_KEY_PATTERN.test(value);
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
