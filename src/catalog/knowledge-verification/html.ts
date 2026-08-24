/**
 * HTML reading primitives shared by every knowledge-source verification path.
 *
 * These were once copied between the versioned verifier modules and had drifted apart —
 * `decodeHtml` in particular — so they live here once and every strategy imports them.
 *
 * Everything here treats its input as hostile: these parse manufacturer HTML fetched over the
 * network, so nothing may throw on malformed markup.
 */

import { isRecord } from "../../types.js";

/** NFKC-normalized, whitespace-collapsed text. The basis for every comparison downstream. */
export function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes the entity subset that appears in product markup.
 *
 * Out-of-range numeric references are left as-is rather than passed to `String.fromCodePoint`,
 * which would throw a `RangeError` and fail the whole verification. (The pre-consolidation copies
 * in v1/v2 had exactly that hole; v3's guarded version is the one kept.)
 */
export function decodeHtml(value: unknown = ""): string {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized in NAMED_ENTITIES) return NAMED_ENTITIES[normalized] ?? entity;

    const hexadecimal = normalized.startsWith("&#x");
    const codePoint = Number.parseInt(
      normalized.slice(hexadecimal ? 3 : 2, -1),
      hexadecimal ? 16 : 10,
    );
    return Number.isSafeInteger(codePoint) && codePoint <= MAX_CODE_POINT
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

export function stripTags(value: unknown = ""): string {
  return clean(decodeHtml(String(value).replace(/<[^>]+>/g, " ")));
}

/**
 * Text a reader would see: scripts and styles removed before tags are stripped.
 *
 * The closing tags allow trailing content (`</script >`, `</script data-x>`) because HTML parsers
 * accept those. A stricter `</script>` would leave the script body in the text, and script bodies
 * routinely mention model numbers and availability wording — exactly what the classifier reads.
 *
 * Both tags still require whitespace, `/` or `>` right after the name. A word boundary would end
 * the script at a `</script-x>` written inside a JavaScript string, which a browser reads as ordinary
 * script text — releasing the rest of the script into the page text this function exists to produce.
 */
export function visibleText(html: unknown = ""): string {
  return stripTags(
    String(html)
      .replace(/<script(?:[\s/][^>]*)?>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, " ")
      .replace(/<style(?:[\s/][^>]*)?>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, " "),
  );
}

/** For building the synthetic single-product documents the index strategies re-verify. */
export function escapeHtml(value: unknown = ""): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function parseTagAttributes(tag: string = ""): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

export function metaContent(html: string, name: string): string {
  const target = String(name || "").toLowerCase();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    if (clean(attributes.get("name")).toLowerCase() === target) {
      return clean(attributes.get("content"));
    }
  }
  return "";
}

/** Category evidence: the first two breadcrumb trails, which is where the product type appears. */
export function breadcrumbText(html: string): string {
  const values: string[] = [];
  for (const match of String(html).matchAll(
    /<(?:nav|div|ol|ul)\b[^>]*(?:class|id)=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|div|ol|ul)>/gi,
  )) {
    values.push(stripTags(match[1]));
    if (values.length >= 2) break;
  }
  return clean(values.join(" "));
}

/**
 * Unparseable JSON-LD blocks are skipped: one bad script must not hide the rest of the page.
 *
 * Tag names are delimited the way HTML delimits them, so `</script data-x>` still closes a block
 * and `<script-x type="application/ld+json">` is not one. Verification reads a missing block as
 * "the page does not state this", so skipping a well-formed block would read as evidence.
 */
export function jsonLdValues(html: string): unknown[] {
  const values: unknown[] = [];
  for (const match of String(html).matchAll(
    /<script[\s/][^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script(?:[\s/][^>]*)?>/gi,
  )) {
    try {
      values.push(JSON.parse(decodeHtml(match[1]).trim()));
    } catch {}
  }
  return values;
}

/** Flattens arrays and `@graph` containers so `Product` nodes can be found at any nesting. */
export function flattenJsonLd(
  value: unknown,
  output: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  if (!isRecord(value)) return output;
  output.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLd(value["@graph"], output);
  return output;
}

/** `@type` may be a string or an array of them. */
export function isProductNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  if (Array.isArray(type)) return type.some((value) => String(value).toLowerCase() === "product");
  return String(type || "").toLowerCase() === "product";
}

export function brandName(brand: unknown): string {
  if (typeof brand === "string") return clean(brand);
  if (isRecord(brand)) return clean(brand.name);
  return "";
}

/**
 * Resolves a link and keeps it only if it stays on the manufacturer's own origin.
 *
 * Discovery follows links from fetched pages, so this is the boundary that stops a crawl from
 * wandering onto a third-party site. Fragments are dropped so the same page is fetched once.
 */
export function sameOriginUrl(value: unknown, baseUrl: string): string {
  try {
    const resolved = new URL(decodeHtml(value), baseUrl);
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol) || resolved.origin !== base.origin) {
      return "";
    }
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return "";
  }
}

export function extractSitemapLocations(xml: string, baseUrl: string): string[] {
  const locations: string[] = [];
  for (const match of String(xml).matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const url = sameOriginUrl(stripTags(match[1]), baseUrl);
    if (url) locations.push(url);
  }
  return [...new Set(locations)];
}

/** Gzipped sitemaps are skipped: the fetch path reads text and cannot decompress them. */
export function sitemapUrlsFromRobots(robots: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const line of String(robots || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    const url = sameOriginUrl(match[1], baseUrl);
    if (url && !/\.gz(?:$|\?)/i.test(url)) urls.push(url);
  }
  return urls;
}
