import type { NormalizedCatalogProduct } from "../catalog/types.js";
import { stripRawTextElements } from "../html/raw-text.js";
import { listingBlocks } from "./listing-fields.js";
import { cleanText } from "./normalize.js";

export type DetailProductIdentity = Partial<Pick<NormalizedCatalogProduct, "model" | "title">>;

/** Model mentions in navigation or a different product are not proof of the detail's identity. */
export function mentionsDetailProduct(text: string, product: DetailProductIdentity): boolean {
  const normalized = cleanText(text).normalize("NFKC").toLowerCase();
  return [product.model, product.title].some((value) => {
    const needle = cleanText(value).normalize("NFKC").toLowerCase();
    if (needle.length < 2) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?![a-z0-9])`, "u").test(normalized);
  });
}

/** Drop complete non-product regions, including nested or unclosed navigation containers. */
function withoutPageChrome(html: string): string {
  const source = stripRawTextElements(html, ["script", "style", "noscript"]);
  const tags = /<(\/?)([a-z][a-z0-9-]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let output = "";
  let cursor = 0;
  let hiddenTag = "";
  let depth = 0;
  for (const match of source.matchAll(tags)) {
    const tag = match[2].toLowerCase();
    const closing = Boolean(match[1]);
    if (hiddenTag) {
      if (tag === hiddenTag) depth += closing ? -1 : 1;
      if (depth === 0) hiddenTag = "";
    } else if (!closing && /^(?:head|header|nav|aside|footer|template)$/.test(tag)) {
      output += `${source.slice(cursor, match.index)} `;
      hiddenTag = tag;
      depth = 1;
    } else {
      continue;
    }
    cursor = match.index + match[0].length;
  }
  return hiddenTag ? output : output + source.slice(cursor);
}

/**
 * Read the product lead, not the whole page. A heading must identify the expected listing when
 * headings are present. Prose readers end at any next heading. Explicit field readers can request
 * their product heading level and include its subsections, ending before the next product heading.
 * Heading-free fragments are allowed only for model-specific prose readers.
 */
export function productDetailScope(
  html: string,
  product: DetailProductIdentity,
  requiredHeadingLevel?: 1 | 2,
): string | null {
  const visible = withoutPageChrome(html);
  const body = listingBlocks(visible, "main")[0] || listingBlocks(visible, "body")[0] || visible;
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
  // H1, when present, owns the page identity; a related-product H2 must not override it.
  const level = requiredHeadingLevel ?? (headings.some((heading) => heading[1] === "1") ? 1 : 2);
  const identityHeadings = headings.filter((heading) => Number(heading[1]) === level);
  const heading = identityHeadings.find((item) => mentionsDetailProduct(item[2], product));
  if (!heading)
    return identityHeadings.length || requiredHeadingLevel ? null : body.slice(0, 16000);
  const start = heading.index + heading[0].length;
  const nextHeading = headings.find(
    (item) =>
      item.index >= start && (!requiredHeadingLevel || Number(item[1]) <= requiredHeadingLevel),
  );
  return body.slice(heading.index, Math.min(nextHeading?.index ?? body.length, start + 16000));
}
