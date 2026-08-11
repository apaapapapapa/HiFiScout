import { categoryEvidenceFromText } from '../../catalog/category-evidence.js';
import { cleanText } from '../normalize.js';
import { parseProductPage } from '../parser.js';

const PAGE_SIZE = 50;
const NEW_ARRIVALS_PATH = 'ea-usednw_s1';

function pageUrl(page = 1) {
  if (page === 1) return 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_s1/';
  return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}_p${page}/?ps=${PAGE_SIZE}`;
}

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '';
}

function metaDescriptions(html) {
  const descriptions = [];
  for (const match of String(html || '').matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = (attribute(attrs, 'name') || attribute(attrs, 'property')).toLowerCase();
    if (!['description', 'og:description', 'twitter:description'].includes(name)) continue;
    const content = cleanText(attribute(attrs, 'content'));
    if (content) descriptions.push(content);
  }
  return [...new Set(descriptions)];
}

function firstExplicitDetailEvidence(text, source) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const sentences = normalized.split(/[。！？!?]+/).map(cleanText).filter(Boolean);
  for (const sentence of sentences) {
    const evidence = categoryEvidenceFromText(sentence, {
      source,
      strength: 'strong',
      context: 'detail'
    });
    if (evidence.length) return evidence;
  }
  return [];
}

function productLeadText(html, product = {}) {
  const visible = cleanText(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  );
  const needle = cleanText(product.model || product.title || '');
  if (!needle) return visible.slice(0, 1200);
  const index = visible.toLowerCase().indexOf(needle.toLowerCase());
  return visible.slice(index >= 0 ? index : 0, (index >= 0 ? index : 0) + 1200);
}

export function extractFujiyaDetailCategoryEvidence(html, product = {}) {
  // Prefer product-specific metadata. Never scan the entire detail page: related-product
  // copy can mention a different component (for example an amplifier page mentioning
  // a matching SACD player) and would otherwise create false category evidence.
  for (const description of metaDescriptions(html)) {
    const evidence = firstExplicitDetailEvidence(description, 'detail_metadata');
    if (evidence.length) return evidence;
  }

  return firstExplicitDetailEvidence(productLeadText(html, product), 'detail_product_text');
}

export function parseFujiyaResultCount(html) {
  const text = cleanText(html);
  const match = text.match(/(?:検索結果|該当件数)\s*([0-9,，]+)\s*件|([0-9,，]+)\s*件あります/);
  const raw = match?.[1] || match?.[2];
  return raw ? Number.parseInt(raw.replace(/[，,]/g, ''), 10) : null;
}

export const fujiyaAvicAdapter = {
  key: 'fujiya-avic',
  name: 'フジヤエービック',
  baseUrl: 'https://www.fujiya-avic.co.jp',
  categoryPolicy: Object.freeze({
    sellerCategory: Object.freeze({
      default: 'authoritative',
      categories: Object.freeze({
        // These merchandising buckets are known to contain heterogeneous products.
        dap: 'corroborative',
        headphone_amp: 'corroborative'
      })
    }),
    parserHint: 'corroborative',
    enrichment: Object.freeze({
      maxRequestsPerCrawl: 20,
      cacheHours: 168
    })
  }),
  extractDetailCategoryEvidence: extractFujiyaDetailCategoryEvidence,
  dynamicPagination: true,
  continueOnEmpty: true,
  *pageUrls() {
    yield { url: pageUrl(), page: 1 };
  },
  discoverPageUrls(html, page) {
    if (page.page !== 1) return [];
    const count = parseFujiyaResultCount(html);
    if (count == null) return null;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    return Array.from({ length: totalPages - 1 }, (_, index) => {
      const pageNumber = index + 2;
      return {
        url: pageUrl(pageNumber),
        page: pageNumber
      };
    });
  },
  parse(html, page) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i,
      priceContext: 'forward'
    });
  }
};
