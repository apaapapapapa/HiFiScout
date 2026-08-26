/**
 * Strips catalog query parameters the API would reject, before the app reads them.
 *
 * This runs ahead of `app.ts` on every page load, so a shared or crafted link cannot put the page
 * into a state whose first request comes back `400`. The bounds match `validateProductQuery` on the
 * server: a value that would be rejected there is dropped here instead of being echoed into the
 * controls and the address bar.
 *
 * Dropping is deliberate rather than clamping. A truncated 101-character search is a different
 * search, and silently running it would be worse than ignoring the parameter.
 *
 * Every shareable parameter has to be listed here. This is an allowlist, and it runs before the app
 * reads the URL, so a parameter that is merely forgotten is not passed through — it is erased from
 * a shared link before anything can act on it.
 */

import {
  isProductPermalinkRoute,
  productKeyFromPermalinkPath,
  productPermalinkPath,
} from "./product-permalink.js";
import { parseFeatureParams } from "./filters.js";

/** Mirrors the server's per-parameter character limits. */
const TEXT_LIMITS = [
  { key: "q", maxLength: 100 },
  { key: "shop", maxLength: 80 },
  { key: "manufacturer", maxLength: 100 },
  { key: "category", maxLength: 100 },
] as const;

/** Only the price sorts are shareable; the rest are defaults the app applies itself. */
const SHAREABLE_SORTS = ["priceAsc", "priceDesc"];

const VIEWS = ["cards", "list"];

/**
 * The sanitized query string, without a leading `?`.
 *
 * Parameter order is fixed rather than inherited from the input, so two links carrying the same
 * state normalize to the same URL.
 */
export function sanitizedCatalogSearch(search: string): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();

  for (const { key, maxLength } of TEXT_LIMITS) {
    const value = source.get(key);
    // Counted in code points: a Japanese query must not be rejected for its byte length.
    if (value == null || !value.trim() || [...value].length > maxLength) continue;
    params.set(key, value);
  }

  for (const key of ["minPrice", "maxPrice"]) {
    const value = source.get(key);
    if (value != null && /^\d{1,12}$/.test(value)) params.set(key, value);
  }

  const sort = source.get("sort");
  if (sort && SHAREABLE_SORTS.includes(sort)) params.set("sort", sort);

  // Emitted between `sort` and the toggles to match `filterUrlParams`, so a link the app wrote is
  // already clean and reloading it does not rewrite the address bar. Validation and de-duplication
  // are the filter module's, so the accepted vocabulary is not restated here.
  for (const feature of parseFeatureParams(source)) params.append("feature", feature);

  // Only the non-default state is carried: `inStock` defaults on, the other two default off.
  if (source.get("inStock") === "false") params.set("inStock", "false");
  if (source.get("newOnly") === "true") params.set("newOnly", "true");
  if (source.get("priceDropped") === "true") params.set("priceDropped", "true");

  const view = source.get("view");
  if (view && VIEWS.includes(view)) params.set("view", view);

  return params.toString();
}

function sanitizedCatalogPath(pathname: string): string {
  if (!isProductPermalinkRoute(pathname)) return pathname;
  const key = productKeyFromPermalinkPath(pathname);
  return key ? (productPermalinkPath(key) ?? "/") : "/";
}

/**
 * The path to replace the current URL with, or `null` when it is already clean.
 *
 * Returning `null` rather than an identical URL keeps the bootstrap from pushing a history entry
 * for a link that needed no correction.
 */
export function sanitizedCatalogUrl(pathname: string, search: string, hash: string): string | null {
  const nextPath = sanitizedCatalogPath(pathname);
  const nextSearch = sanitizedCatalogSearch(search);
  const nextUrl = `${nextPath}${nextSearch ? `?${nextSearch}` : ""}${hash}`;
  return nextUrl === `${pathname}${search}${hash}` ? null : nextUrl;
}
