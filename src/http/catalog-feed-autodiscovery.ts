/** Server-side Atom autodiscovery for the public catalog HTML. */

import { isFeatureId } from "../catalog/types.js";
import { requestedFacetSelections, requestedFeatures } from "../api/product-query.js";
import { facetSelectionKey } from "../catalog/product-facets.js";

const TEXT_LIMITS = [
  { key: "q", maxLength: 100 },
  { key: "shop", maxLength: 80 },
  { key: "manufacturer", maxLength: 100 },
  { key: "category", maxLength: 100 },
] as const;

function validText(params: URLSearchParams, key: string, maxLength: number): string {
  const value = params.get(key)?.trim() || "";
  return value && [...value].length <= maxLength ? value : "";
}

function validPrice(params: URLSearchParams, key: "minPrice" | "maxPrice"): string {
  const value = params.get(key) || "";
  return /^\d{1,12}$/.test(value) ? String(Number.parseInt(value, 10)) : "";
}

/**
 * Converts the shareable catalog URL into the equivalent feed subscription path.
 *
 * The public UI defaults to in-stock results, whereas the lower-level product API defaults to all
 * stock states. The feed link therefore writes `inStock=true` unless the catalog URL explicitly
 * carries its shareable `inStock=false` state. Presentation-only `view`/`sort` values are omitted.
 * Invalid values are dropped exactly as the browser bootstrap sanitizer drops them rather than
 * emitting a feed URL that would fail validation.
 */
export function catalogFeedPath(url: URL): string {
  const source = url.searchParams;
  const params = new URLSearchParams();

  for (const { key, maxLength } of TEXT_LIMITS) {
    const value = validText(source, key, maxLength);
    if (value) params.set(key, value);
  }

  for (const feature of requestedFeatures(source).filter(isFeatureId).sort()) {
    params.append("feature", feature);
  }
  for (const facet of requestedFacetSelections(source).sort((left, right) =>
    facetSelectionKey(left).localeCompare(facetSelectionKey(right)),
  )) {
    params.append("facet", facetSelectionKey(facet));
  }

  if (source.get("inStock") !== "false") params.set("inStock", "true");
  if (source.get("newOnly") === "true") params.set("newOnly", "true");
  if (source.get("priceDropped") === "true") params.set("priceDropped", "true");

  for (const key of ["minPrice", "maxPrice"] as const) {
    const value = validPrice(source, key);
    if (value) params.set(key, value);
  }

  const search = params.toString();
  return `/api/feed${search ? `?${search}` : ""}`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** Rewrites only the explicitly marked Atom link in the static application shell. */
export function injectCatalogFeedAutodiscovery(html: string, url: URL): string {
  const href = escapeHtmlAttribute(catalogFeedPath(url));
  return html.replace(
    /(<link\b(?=[^>]*\bdata-saved-search-feed\b)[^>]*\bhref=")[^"]*(")/u,
    `$1${href}$2`,
  );
}

/**
 * Turns the static index asset into request-specific HTML for non-JavaScript feed readers.
 * Entity validators belong to the unmodified asset and are removed once the body is rewritten.
 */
export async function catalogHtmlWithFeedAutodiscovery(
  response: Response,
  url: URL,
): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("last-modified");

  return new Response(injectCatalogFeedAutodiscovery(await response.text(), url), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
