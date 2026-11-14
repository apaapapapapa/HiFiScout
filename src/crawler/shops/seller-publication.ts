import { listingAttribute } from "../listing-fields.js";

export interface SellerPublication {
  /** Timestamp derived from the seller's own post, not the crawler's observation time. */
  readonly at: string;
  /** A date-only source must not enter minute-level freshness statistics. */
  readonly precision: "day" | "second";
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Only accept a machine-readable timestamp explicitly labelled as the post's publication time.
 * The caller passes a single seller-owned card or article header, never an entire search page.
 * A modified date, a date in a description, and timezone-less times are not publication evidence.
 */
export function explicitPublicationTime(html: string): SellerPublication | null {
  for (const match of html.matchAll(/<time\b([^>]*)>/giu)) {
    const attrs = match[1] || "";
    const itemprop = listingAttribute(attrs, "itemprop");
    const classes = listingAttribute(attrs, "class").split(/\s+/u);
    if (classes.includes("updated")) continue;
    if (itemprop !== "datePublished" && !classes.includes("published")) continue;
    const value = listingAttribute(attrs, "datetime");
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) ||
      !validCalendarDate(value.slice(0, 10))
    ) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return { at: date.toISOString(), precision: "second" };
  }
  return null;
}

/**
 * WordPress dated permalinks prove the post's calendar date, not its publication clock time.
 * Use the article header's explicit time when present; otherwise encode 00:00 JST and flag
 * day-only precision so lag reports never mistake midnight for an exact publish instant.
 */
export function wordpressPublication(
  articleHeader: string,
  permalink: string,
): SellerPublication | null {
  const datedPath = new URL(permalink).pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+\/?$/u);
  if (!datedPath) return null;
  const dateString = `${datedPath[1]}-${datedPath[2]}-${datedPath[3]}`;
  if (!validCalendarDate(dateString)) return null;
  const explicit = explicitPublicationTime(articleHeader);
  // A WordPress permalink's date and the labelled local post date should agree.
  if (explicit) {
    const sourceDate = articleHeader.match(/<time\b[^>]*datetime\s*=\s*["'](\d{4}-\d{2}-\d{2})/iu)?.[1];
    if (sourceDate === dateString) return explicit;
  }
  return { at: new Date(`${dateString}T00:00:00+09:00`).toISOString(), precision: "day" };
}
