import { stripRawTextElements } from "../../html/raw-text.js";
import { cleanText } from "../normalize.js";

export interface CanonicalProductLink {
  readonly sourceId: string;
  readonly sourceUrl: string;
}

export interface ProductAnchorRecord extends CanonicalProductLink {
  readonly index: number;
  readonly titles: string[];
}

export interface ProductListingBlock {
  readonly record: ProductAnchorRecord;
  readonly text: string;
}

export function visibleListingText(html: unknown = ""): string {
  return cleanText(stripRawTextElements(html).replace(/<br\s*\/?>/gi, " "));
}

export function collectProductAnchors(
  html: string,
  canonicalProductLink: (href: string) => CanonicalProductLink | null,
): ProductAnchorRecord[] {
  const records = new Map<string, ProductAnchorRecord>();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || "").matchAll(anchorRe)) {
    const product = canonicalProductLink(match[3]);
    if (!product) continue;
    const title = visibleListingText(match[5]);
    const existing = records.get(product.sourceId);
    if (existing) {
      if (title) existing.titles.push(title);
      continue;
    }
    records.set(product.sourceId, {
      ...product,
      index: match.index || 0,
      titles: title ? [title] : [],
    });
  }

  return [...records.values()].sort((a, b) => a.index - b.index);
}

export function productListingBlocks(
  html: string,
  records: readonly ProductAnchorRecord[],
): ProductListingBlock[] {
  return records.map((record, index) => ({
    record,
    text: visibleListingText(html.slice(record.index, records[index + 1]?.index ?? html.length)),
  }));
}

export function bestListingTitle(
  record: ProductAnchorRecord,
  blockText: string,
  normalize: (value: string) => string,
  score: (value: string) => number,
): string {
  return (
    [...new Set([...record.titles, blockText])]
      .map(normalize)
      .filter((value) => value.length >= 3)
      .sort((a, b) => score(b) - score(a))[0] || ""
  );
}

interface LinkedPageDiscoveryOptions<T> {
  readonly baseUrl: string;
  readonly currentPage: number;
  readonly pageNumber: (url: URL) => number | null;
  readonly createPage: (page: number) => T;
}

export function discoverLinkedPages<T>(html: string, options: LinkedPageDiscoveryOptions<T>): T[] {
  let maxPage = options.currentPage;

  for (const match of String(html || "").matchAll(/href\s*=\s*(["'])([^"']+)\1/gi)) {
    try {
      const candidate = options.pageNumber(new URL(match[2], options.baseUrl));
      if (candidate !== null && Number.isFinite(candidate)) maxPage = Math.max(maxPage, candidate);
    } catch {
      continue;
    }
  }

  return Array.from({ length: Math.max(0, maxPage - options.currentPage) }, (_, index) =>
    options.createPage(options.currentPage + index + 1),
  );
}
