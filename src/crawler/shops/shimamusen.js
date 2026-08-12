import { cleanText, parseYen } from '../normalize.js';

const BASE_URL = 'https://www.shimamusen.com';
const DISPLAY_URL = `${BASE_URL}/shopbrand/063/Y/`;
const SALE_URL = `${BASE_URL}/shopbrand/036/Y/`;
const USED_URL = `${BASE_URL}/shopbrand/ct826/`;

function absoluteUrl(href) {
  try {
    const url = new URL(href, BASE_URL);
    return url.hostname === 'www.shimamusen.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

function stripTags(html = '') {
  return cleanText(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function decodeBasicEntities(value = '') {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function cleanedAnchorText(html = '') {
  return cleanText(decodeBasicEntities(stripTags(html)));
}

function pageKind(page) {
  if (typeof page === 'object' && page?.kind) return page.kind;
  const url = typeof page === 'string' ? page : page?.url || '';
  if (/\/063\/Y\/?/i.test(url)) return '展示処分品';
  if (/\/036\/Y\/?/i.test(url)) return '特価商品';
  return '中古品';
}

function productAnchors(html) {
  const anchors = [];
  const re = /<a\b([^>]*\bhref\s*=\s*["']([^"']*\/shopdetail\/(\d+)\/[^"']*)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(re)) {
    const sourceUrl = absoluteUrl(match[2]);
    if (!sourceUrl) continue;
    anchors.push({
      sourceId: match[3],
      sourceUrl,
      title: cleanedAnchorText(match[4]),
      index: match.index || 0,
      end: (match.index || 0) + match[0].length
    });
  }
  return anchors;
}

function distinctProductBlocks(html) {
  const anchors = productAnchors(html);
  const orderedIds = [];
  const grouped = new Map();

  for (const anchor of anchors) {
    if (!grouped.has(anchor.sourceId)) {
      grouped.set(anchor.sourceId, []);
      orderedIds.push(anchor.sourceId);
    }
    grouped.get(anchor.sourceId).push(anchor);
  }

  return orderedIds.map((sourceId, index) => {
    const current = grouped.get(sourceId);
    const titleAnchor = current.find(anchor => anchor.title) || current[0];
    const nextId = orderedIds[index + 1];
    const nextAnchors = nextId ? grouped.get(nextId) : null;
    const blockStart = Math.max(0, current[0].index - 600);
    const blockEnd = nextAnchors ? nextAnchors[0].index : Math.min(String(html).length, current[current.length - 1].end + 1800);
    return {
      sourceId,
      sourceUrl: titleAnchor.sourceUrl,
      title: titleAnchor.title,
      html: String(html).slice(blockStart, blockEnd)
    };
  });
}

function manufacturerFromBlock(blockHtml, title) {
  const text = stripTags(blockHtml);
  const titleIndex = text.indexOf(title);
  if (titleIndex < 0) return '';
  const after = text.slice(titleIndex + title.length, titleIndex + title.length + 500);
  const priceIndex = after.search(/(?:販売価格\s*)?[\d,]+円|価格\s*[:：]/);
  const between = priceIndex >= 0 ? after.slice(0, priceIndex) : after.slice(0, 120);
  const candidates = between
    .split(/\s{2,}|[｜|]/)
    .map(value => cleanText(value))
    .filter(Boolean)
    .filter(value => !/^(?:販売価格|価格|税込|円|新着|商品名|製造元)$/i.test(value));
  return candidates.find(value => value.length <= 60 && !/\d{4,}/.test(value)) || '';
}

function extractPrice(blockHtml) {
  const text = stripTags(blockHtml);
  const match = text.match(/(?:販売価格\s*)?([\d,]+)円(?:\s*\(税込\))?/i)
    || text.match(/([\d,]+)円\s*[～〜]/i);
  return match ? parseYen(match[1]) : null;
}

function soldOut(blockHtml) {
  return /売り切れ|売切れ|SOLD\s*OUT|在庫なし|完売|販売終了/i.test(stripTags(blockHtml));
}

function conditionFor(kind, title, blockHtml) {
  const parts = [kind];
  if (/未使用開封品/.test(title)) parts.push('未使用開封品');
  else if (/B級品/.test(title)) parts.push('B級品');
  else if (/展示処分品|現品処分品/.test(title)) parts.push('展示処分品');
  if (/商談中|予約中/.test(stripTags(blockHtml))) parts.push('商談中');
  return [...new Set(parts)].join(' / ');
}

export function parseShimamusenListing(html, page = {}) {
  const kind = pageKind(page);
  const products = [];

  for (const block of distinctProductBlocks(html)) {
    const title = cleanText(block.title);
    if (!title) continue;

    products.push({
      sourceId: block.sourceId,
      rawManufacturer: manufacturerFromBlock(block.html, title),
      manufacturer: manufacturerFromBlock(block.html, title),
      model: title,
      title,
      rawCategory: kind,
      category: '',
      conditionText: conditionFor(kind, title, block.html),
      priceYen: extractPrice(block.html),
      stockStatus: soldOut(block.html) ? 'sold_out' : 'in_stock',
      sourceUrl: block.sourceUrl,
      metadata: { listingKind: kind }
    });
  }

  return [...new Map(products.map(product => [product.sourceId, product])).values()];
}

export function discoverShimamusenPageUrls(html) {
  const pages = new Map();
  const re = /href\s*=\s*["']([^"']*\/shopbrand\/ct826\/page(\d+)\/order\/?[^"']*)["']/gi;
  for (const match of String(html || '').matchAll(re)) {
    const url = absoluteUrl(match[1]);
    const pageNumber = Number.parseInt(match[2], 10);
    if (!url || !Number.isFinite(pageNumber) || pageNumber < 2) continue;
    pages.set(pageNumber, { url, kind: '中古品' });
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, page]) => page);
}

export const shimamusenAdapter = {
  key: 'shimamusen',
  name: 'シマムセン',
  baseUrl: BASE_URL,
  dynamicPagination: true,
  guardItemCount: true,
  categoryPolicy: {
    // These three entry pages are merchandising/condition buckets, not product-type categories.
    sellerCategory: { default: 'ignore' },
    parserHint: 'ignore'
  },
  *pageUrls() {
    yield { url: DISPLAY_URL, kind: '展示処分品' };
    yield { url: SALE_URL, kind: '特価商品' };
    yield { url: USED_URL, kind: '中古品' };
  },
  discoverPageUrls(html, page) {
    return pageKind(page) === '中古品' ? discoverShimamusenPageUrls(html) : [];
  },
  parse(html, page) {
    return parseShimamusenListing(html, page);
  }
};
