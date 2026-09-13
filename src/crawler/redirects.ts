/**
 * Redirect handling for crawl traffic.
 *
 * `redirect: "follow"` hands the destination choice to the seller: any hop can move the request to
 * another origin, downgrade it to plain HTTP, or aim it at an address the crawler was never allowed
 * to reach. Constrained crawl requests therefore follow redirects manually and validate every hop
 * **before the request is sent**, so a rejected destination never receives traffic. Checking only
 * the final URL after the fact would already have leaked the request.
 *
 * This does not rely on "a Worker cannot reach a private address": the same crawl contract is also
 * served by the relay Lambda in AWS, where that assumption does not hold.
 */

import type { AugmentedCrawlError } from "./types.js";

/** RFC 9309 expects a crawler to follow at least five redirects; nothing here needs more. */
export const CRAWL_MAX_REDIRECTS = 5;

export const CRAWL_REDIRECT_REJECTED_CODE = "redirect_rejected";

/**
 * A redirect destination failed validation, or the chain did not terminate.
 *
 * Like an oversized body this is a crawl failure, never an empty page: the collection that raised it
 * fails so existing products keep their current state.
 */
export class CrawlRedirectRejectedError extends Error implements AugmentedCrawlError {
  readonly code = CRAWL_REDIRECT_REJECTED_CODE;

  constructor(reason: string) {
    super(`crawl redirect rejected: ${reason}`);
    this.name = "CrawlRedirectRejectedError";
  }
}

export function isCrawlRedirectRejectedError(error: unknown): error is CrawlRedirectRejectedError {
  return error instanceof CrawlRedirectRejectedError;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Builds the exact set a destination's origin is compared against.
 *
 * Comparison is whole-value set membership on `URL.origin`. A prefix or substring test would accept
 * `https://ippinkan.jp.example.com` for a shop configured as `https://ippinkan.jp`.
 */
export function allowedOriginSet(origins: Iterable<string>): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const candidate of origins) {
    let origin: string;
    try {
      origin = new URL(candidate).origin;
    } catch {
      continue;
    }
    if (origin && origin !== "null") allowed.add(origin);
  }
  return allowed;
}

/** Rejects a destination this crawl may not send a request to. Never echoes embedded credentials. */
export function assertAllowedCrawlTarget(target: URL, allowedOrigins: ReadonlySet<string>): void {
  if (target.username || target.password) {
    throw new CrawlRedirectRejectedError(
      `destination on ${target.origin} carries embedded credentials`,
    );
  }
  if (target.protocol !== "https:") {
    throw new CrawlRedirectRejectedError(`destination is not HTTPS: ${target.protocol}//`);
  }
  if (!allowedOrigins.has(target.origin)) {
    throw new CrawlRedirectRejectedError(`origin ${target.origin} is not allowed for this shop`);
  }
}

/** Resolves `Location` against the URL that produced it, as RFC 9110 requires. */
export function resolveRedirectLocation(currentUrl: string, location: string | null): URL {
  const value = location?.trim();
  if (!value) throw new CrawlRedirectRejectedError("redirect response had no Location header");
  try {
    return new URL(value, currentUrl);
  } catch {
    throw new CrawlRedirectRejectedError("redirect Location is not a resolvable URL");
  }
}

export interface ValidatedRedirectOptions {
  fetchFn: typeof fetch;
  allowedOrigins: ReadonlySet<string>;
  /**
   * Total budget for the whole chain and the body that follows it. One signal for every hop, so a
   * chain cannot extend the deadline by taking more of them.
   */
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Runs for each destination before it is requested; the crawl uses it to re-apply robots rules. */
  beforeRequest?: (url: string) => Promise<void> | void;
}

/**
 * Performs a request, following redirects one validated hop at a time.
 *
 * Unused redirect bodies are released rather than left for the runtime to buffer, and a repeated
 * destination ends the chain instead of cycling.
 */
export async function fetchFollowingValidatedRedirects(
  url: string,
  init: Omit<RequestInit, "redirect" | "signal">,
  {
    fetchFn,
    allowedOrigins,
    signal,
    maxRedirects = CRAWL_MAX_REDIRECTS,
    beforeRequest,
  }: ValidatedRedirectOptions,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CrawlRedirectRejectedError(`request URL is not a valid URL`);
  }

  const visited = new Set<string>();
  for (let hop = 0; ; hop += 1) {
    assertAllowedCrawlTarget(target, allowedOrigins);
    const href = target.toString();
    if (visited.has(href)) {
      throw new CrawlRedirectRejectedError(`redirect loop returning to ${href}`);
    }
    visited.add(href);

    await beforeRequest?.(href);
    const response = await fetchFn(href, { ...init, redirect: "manual", signal });
    if (!isRedirectStatus(response.status)) return response;

    // Nothing in a redirect body is ever read; release it instead of leaving it buffered.
    await response.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) {
      throw new CrawlRedirectRejectedError(`more than ${maxRedirects} redirects`);
    }
    target = resolveRedirectLocation(href, response.headers.get("location"));
  }
}

/**
 * Extra origins a shop has explicitly declared it may be redirected to.
 *
 * A shop's own `baseUrl` origin is always allowed and is added by the caller; this returns only the
 * declared additions, so an undeclared shop stays limited to its own origin.
 */
export function shopRedirectOrigins(shop: {
  readonly capabilities?: {
    readonly transport?: { readonly allowedRedirectOrigins?: readonly string[] };
  };
}): readonly string[] {
  return shop.capabilities?.transport?.allowedRedirectOrigins ?? [];
}
