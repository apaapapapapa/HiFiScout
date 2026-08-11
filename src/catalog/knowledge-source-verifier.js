import { classifyCategoryEvidence } from './category-classifier.js';
import { inferExplicitCategoryIds } from './category-rules.js';
import { normalizeCatalogModel } from './knowledge-catalog.js';
import { normalizeManufacturer } from './manufacturers.js';

const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SITEMAPS = 6;
const DEFAULT_MAX_DISCOVERED_URLS = 5_000;
const DEFAULT_MAX_PRODUCT_PAGES = 4;

const DEFAULT_OFFICIAL_SOURCES = Object.freeze([
  {
    manufacturerId: 'luxman',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.luxman.co.jp/',
    catalogUrls: ['https://www.luxman.co.jp/']
  },
  {
    manufacturerId: 'accuphase',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.accuphase.com/',
    catalogUrls: ['https://www.accuphase.com/?lang=ja']
  },
  {
    manufacturerId: 'tad',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://tad-labs.com/jp/',
    catalogUrls: ['https://tad-labs.com/jp/']
  },
  {
    manufacturerId: 'esoteric',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.esoteric.jp/jp/',
    catalogUrls: ['https://www.esoteric.jp/jp/']
  },
  {
    manufacturerId: 'yamaha',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://jp.yamaha.com/',
    catalogUrls: ['https://jp.yamaha.com/products/audio_visual/hifi_components/']
  },
  {
    manufacturerId: 'denon',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.denon.com/ja-jp/',
    catalogUrls: ['https://www.denon.com/ja-jp/']
  },
  {
    manufacturerId: 'marantz',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.marantz.com/ja-jp/',
    catalogUrls: ['https://www.marantz.com/ja-jp/']
  },
  {
    manufacturerId: 'technics',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://jp.technics.com/',
    catalogUrls: ['https://jp.technics.com/']
  }
]);

const ELEMENT_PATTERNS = Object.freeze({
  title: /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  h1: /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
});

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function clean(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripTags(value = '') {
  return clean(decodeHtml(String(value).replace(/<[^>]+>/g, ' ')));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeIdentityText(value = '') {
  return clean(value)
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ');
}

export function containsCatalogModelIdentity(text = '', model = '') {
  const normalizedText = normalizeIdentityText(text);
  const normalizedModel = normalizeIdentityText(model);
  if (!normalizedText || !normalizedModel) return false;
  const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizedModel)}($|[^A-Z0-9])`, 'i');
  return pattern.test(normalizedText);
}

function urlModelKey(value = '') {
  let decoded = String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  return decoded
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function urlMatchesModel(url, model) {
  try {
    const parsed = new URL(url);
    const haystack = urlModelKey(`${parsed.pathname} ${parsed.search}`);
    const needle = urlModelKey(model);
    if (!needle) return false;
    const index = haystack.indexOf(needle);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : '';
    const after = haystack[index + needle.length] || '';
    return !/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after);
  } catch {
    return false;
  }
}

function parseSourceOverrides(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([manufacturerId, config]) => ({
        manufacturerId,
        ...(config || {})
      }));
    }
  } catch {}
  return [];
}

function normalizedSource(source = {}) {
  const manufacturerId = clean(source.manufacturerId).toLowerCase();
  const baseUrl = clean(source.baseUrl);
  if (!manufacturerId || !baseUrl || source.enabled === false) return null;

  let base;
  try {
    base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) return null;
  } catch {
    return null;
  }

  const catalogUrls = Array.isArray(source.catalogUrls)
    ? source.catalogUrls.filter(Boolean).map(String)
    : [base.toString()];
  const sitemapUrls = Array.isArray(source.sitemapUrls)
    ? source.sitemapUrls.filter(Boolean).map(String)
    : [];

  return {
    manufacturerId,
    adapter: 'official_site',
    sourceType: clean(source.sourceType) || 'manufacturer_official',
    baseUrl: base.toString(),
    catalogUrls,
    sitemapUrls,
    searchUrlTemplate: clean(source.searchUrlTemplate)
  };
}

export function knowledgeSourceDefinitions(env = {}) {
  const byManufacturer = new Map();
  for (const source of DEFAULT_OFFICIAL_SOURCES) {
    const normalized = normalizedSource(source);
    if (normalized) byManufacturer.set(normalized.manufacturerId, [normalized]);
  }

  for (const raw of parseSourceOverrides(env.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON)) {
    const manufacturerId = clean(raw?.manufacturerId).toLowerCase();
    if (!manufacturerId) continue;
    if (raw?.enabled === false) {
      byManufacturer.delete(manufacturerId);
      continue;
    }
    const normalized = normalizedSource(raw);
    if (!normalized) continue;
    if (raw?.replace === false && byManufacturer.has(manufacturerId)) {
      byManufacturer.get(manufacturerId).push(normalized);
    } else {
      byManufacturer.set(manufacturerId, [normalized]);
    }
  }
  return byManufacturer;
}

function parseTagAttributes(tag = '') {
  const attributes = new Map();
  const pattern = /([A-Za-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function metaContent(html, name) {
  const target = String(name || '').toLowerCase();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    if (clean(attributes.get('name')).toLowerCase() === target) {
      return clean(attributes.get('content'));
    }
  }
  return '';
}

function firstElementText(html, tag) {
  const pattern = ELEMENT_PATTERNS[tag];
  if (!pattern) return '';
  const match = String(html).match(pattern);
  return match ? stripTags(match[1]) : '';
}

function breadcrumbText(html) {
  const values = [];
  for (const match of String(html).matchAll(/<(?:nav|div|ol|ul)\b[^>]*(?:class|id)=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|div|ol|ul)>/gi)) {
    values.push(stripTags(match[1]));
    if (values.length >= 2) break;
  }
  return clean(values.join(' '));
}

function jsonLdValues(html) {
  const values = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      values.push(JSON.parse(decodeHtml(match[1]).trim()));
    } catch {}
  }
  return values;
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  output.push(value);
  if (Array.isArray(value['@graph'])) flattenJsonLd(value['@graph'], output);
  return output;
}

function isProductNode(node) {
  const type = node?.['@type'];
  if (Array.isArray(type)) {
    return type.some(value => String(value).toLowerCase() === 'product');
  }
  return String(type || '').toLowerCase() === 'product';
}

function brandName(brand) {
  if (typeof brand === 'string') return clean(brand);
  if (brand && typeof brand === 'object') return clean(brand.name);
  return '';
}

function directModelMatches(value, normalizedModel) {
  return Boolean(value) && normalizeCatalogModel(value) === normalizedModel;
}

function matchingProductNode(products, candidate) {
  const normalizedModel = candidate.normalizedModel || normalizeCatalogModel(candidate.observedModel || candidate.model);
  const observedModel = candidate.observedModel || candidate.model || normalizedModel;
  return products.find(product =>
    [product.model, product.sku, product.mpn].some(value => directModelMatches(value, normalizedModel)) ||
    containsCatalogModelIdentity(product.name, observedModel)
  ) || null;
}

function categoryEvidenceForFields(fields, strength = 'verified') {
  const evidence = [];
  for (const field of fields) {
    const value = clean(field);
    if (!value) continue;
    const categoryIds = inferExplicitCategoryIds(value, { context: 'detail' });
    if (categoryIds.length) {
      evidence.push({
        categoryIds,
        source: 'manufacturer_official',
        strength,
        value
      });
    }
  }
  return evidence;
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) return '';
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyOfficialProductPageHtml({
  candidate,
  html,
  sourceUrl = '',
  sourceType = 'manufacturer_official',
  httpStatus = 200
} = {}) {
  const normalizedModel = candidate?.normalizedModel || normalizeCatalogModel(candidate?.observedModel || candidate?.model || '');
  const observedModel = candidate?.observedModel || candidate?.model || normalizedModel;
  if (!candidate?.manufacturerId || !normalizedModel || !html) {
    return {
      status: 'not_found',
      sourceUrl,
      sourceType,
      httpStatus,
      message: 'missing_candidate_or_page_content'
    };
  }

  const productNodes = jsonLdValues(html)
    .flatMap(value => flattenJsonLd(value))
    .filter(isProductNode);
  const product = matchingProductNode(productNodes, {
    ...candidate,
    normalizedModel,
    observedModel
  });
  const title = firstElementText(html, 'title');
  const h1 = firstElementText(html, 'h1');
  const description = metaContent(html, 'description');
  const breadcrumb = breadcrumbText(html);
  const directModels = product ? [product.model, product.sku, product.mpn].filter(Boolean) : [];

  const modelMatched = directModels.some(value => directModelMatches(value, normalizedModel)) ||
    [product?.name, h1, title].some(value => containsCatalogModelIdentity(value, observedModel));
  if (!modelMatched) {
    return {
      status: 'not_found',
      sourceUrl,
      sourceType,
      httpStatus,
      message: 'official_page_does_not_confirm_model'
    };
  }

  const explicitBrand = brandName(product?.brand);
  if (explicitBrand) {
    const resolved = normalizeManufacturer(explicitBrand);
    if (resolved.id && resolved.id !== candidate.manufacturerId) {
      return {
        status: 'ambiguous',
        sourceUrl,
        sourceType,
        httpStatus,
        message: `official_product_brand_mismatch:${resolved.id}`
      };
    }
  }

  let classification = classifyCategoryEvidence(categoryEvidenceForFields([
    product?.category,
    product?.name,
    h1,
    title
  ]));
  if (classification.classificationStatus !== 'classified') {
    if (classification.classificationState === 'ambiguous') {
      return {
        status: 'ambiguous',
        sourceUrl,
        sourceType,
        httpStatus,
        message: 'conflicting_official_category_evidence'
      };
    }
    classification = classifyCategoryEvidence(categoryEvidenceForFields([
      product?.description,
      description,
      breadcrumb
    ], 'strong'));
  }

  if (classification.classificationStatus !== 'classified' || !classification.categoryIds.length) {
    return {
      status: 'ambiguous',
      sourceUrl,
      sourceType,
      httpStatus,
      message: 'official_page_has_no_unambiguous_category'
    };
  }

  const canonicalModel = directModels.find(value => directModelMatches(value, normalizedModel)) || observedModel;
  const canonicalName = clean(
    product?.name || h1 || title || `${candidate.observedManufacturer || candidate.manufacturerId} ${canonicalModel}`
  );
  return {
    status: 'verified',
    sourceUrl,
    sourceType,
    httpStatus,
    canonicalModel: clean(canonicalModel),
    canonicalName,
    categoryIds: classification.categoryIds,
    primaryCategoryId: classification.primaryCategoryId,
    contentHash: await sha256Hex(html),
    message: 'verified_from_official_product_page'
  };
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= maxBytes) break;
    }
    text += decoder.decode();
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => {});
  }
  return text;
}

async function fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        'user-agent': userAgent
      }
    });
    const text = response.ok ? await readLimitedText(response, maxBytes) : '';
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      text
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      text: '',
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sameOriginUrl(value, baseUrl) {
  try {
    const resolved = new URL(decodeHtml(value), baseUrl);
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== base.origin) return '';
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return '';
  }
}

function extractHtmlLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const url = sameOriginUrl(match[1] || match[2], baseUrl);
    if (url) links.push(url);
  }
  return [...new Set(links)];
}

function extractSitemapLocations(xml, baseUrl) {
  const locations = [];
  for (const match of String(xml).matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const url = sameOriginUrl(stripTags(match[1]), baseUrl);
    if (url) locations.push(url);
  }
  return [...new Set(locations)];
}

function sitemapUrlsFromRobots(robots, baseUrl) {
  const urls = [];
  for (const line of String(robots || '').split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    const url = sameOriginUrl(match[1], baseUrl);
    if (url && !/\.gz(?:$|\?)/i.test(url)) urls.push(url);
  }
  return urls;
}

function applySearchTemplate(template, candidate) {
  if (!template) return '';
  return template
    .replaceAll('{model}', encodeURIComponent(candidate.observedModel || candidate.model || candidate.normalizedModel || ''))
    .replaceAll('{manufacturer}', encodeURIComponent(candidate.observedManufacturer || candidate.manufacturerId || ''));
}

export function createKnowledgeSourceVerifier(env = {}, { fetchImpl = globalThis.fetch } = {}) {
  const definitions = knowledgeSourceDefinitions(env);
  const sourceCache = new Map();
  const timeoutMs = boundedNumber(env.KNOWLEDGE_CATALOG_SOURCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  const maxBytes = boundedNumber(env.KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES, 100_000, 5_000_000);
  const maxSitemaps = boundedNumber(env.KNOWLEDGE_CATALOG_SOURCE_MAX_SITEMAPS, DEFAULT_MAX_SITEMAPS, 1, 20);
  const maxDiscoveredUrls = boundedNumber(env.KNOWLEDGE_CATALOG_SOURCE_MAX_URLS, DEFAULT_MAX_DISCOVERED_URLS, 100, 20_000);
  const maxProductPages = boundedNumber(env.KNOWLEDGE_CATALOG_SOURCE_MAX_PRODUCT_PAGES, DEFAULT_MAX_PRODUCT_PAGES, 1, 10);
  const userAgent = clean(env.CRAWLER_USER_AGENT) || 'HiFiScoutBot/0.1';

  async function cacheForSource(source) {
    const key = `${source.manufacturerId}:${source.baseUrl}`;
    if (sourceCache.has(key)) return sourceCache.get(key);

    const state = { catalogLinks: [], sitemapLinks: null };
    const links = [];
    for (const catalogUrl of source.catalogUrls.slice(0, 4)) {
      const resolved = sameOriginUrl(catalogUrl, source.baseUrl);
      if (!resolved) continue;
      const page = await fetchText(fetchImpl, resolved, { timeoutMs, maxBytes, userAgent });
      if (page.ok) links.push(...extractHtmlLinks(page.text, page.url));
    }
    state.catalogLinks = [...new Set(links)].slice(0, maxDiscoveredUrls);
    sourceCache.set(key, state);
    return state;
  }

  async function loadSitemapLinks(source, state) {
    if (state.sitemapLinks) return state.sitemapLinks;

    const queue = source.sitemapUrls
      .map(url => sameOriginUrl(url, source.baseUrl))
      .filter(Boolean);
    const robotsUrl = new URL('/robots.txt', source.baseUrl).toString();
    const robots = await fetchText(fetchImpl, robotsUrl, { timeoutMs, maxBytes: 250_000, userAgent });
    if (robots.ok) queue.push(...sitemapUrlsFromRobots(robots.text, source.baseUrl));
    queue.push(new URL('/sitemap.xml', source.baseUrl).toString());

    const visited = new Set();
    const pageUrls = [];
    while (queue.length && visited.size < maxSitemaps && pageUrls.length < maxDiscoveredUrls) {
      const sitemapUrl = queue.shift();
      if (!sitemapUrl || visited.has(sitemapUrl) || /\.gz(?:$|\?)/i.test(sitemapUrl)) continue;
      visited.add(sitemapUrl);

      const response = await fetchText(fetchImpl, sitemapUrl, { timeoutMs, maxBytes, userAgent });
      if (!response.ok) continue;

      for (const url of extractSitemapLocations(response.text, source.baseUrl)) {
        if (/\.xml(?:$|\?)/i.test(url) && visited.size + queue.length < maxSitemaps * 2) {
          queue.push(url);
        } else if (pageUrls.length < maxDiscoveredUrls) {
          pageUrls.push(url);
        }
      }
    }
    state.sitemapLinks = [...new Set(pageUrls)];
    return state.sitemapLinks;
  }

  async function discoverProductUrls(source, candidate) {
    const state = await cacheForSource(source);
    const model = candidate.observedModel || candidate.model || candidate.normalizedModel;
    let matches = state.catalogLinks.filter(url => urlMatchesModel(url, model));

    if (!matches.length && source.searchUrlTemplate) {
      const searchUrl = sameOriginUrl(applySearchTemplate(source.searchUrlTemplate, candidate), source.baseUrl);
      if (searchUrl) {
        const result = await fetchText(fetchImpl, searchUrl, { timeoutMs, maxBytes, userAgent });
        if (result.ok) {
          matches = extractHtmlLinks(result.text, result.url).filter(url => urlMatchesModel(url, model));
        }
      }
    }

    if (!matches.length) {
      const sitemapLinks = await loadSitemapLinks(source, state);
      matches = sitemapLinks.filter(url => urlMatchesModel(url, model));
    }
    return [...new Set(matches)].slice(0, maxProductPages);
  }

  async function verifyCandidate(candidate) {
    const manufacturerId = String(candidate?.manufacturerId || '').toLowerCase();
    const sources = definitions.get(manufacturerId) || [];
    if (!sources.length) {
      return { status: 'unsupported', sourceType: '', sourceUrl: '', httpStatus: null, message: 'no_official_source_adapter' };
    }

    let bestFailure = {
      status: 'not_found',
      sourceType: sources[0].sourceType,
      sourceUrl: '',
      httpStatus: null,
      message: 'official_product_page_not_discovered'
    };

    for (const source of sources) {
      const urls = await discoverProductUrls(source, candidate);
      for (const url of urls) {
        const page = await fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent });
        if (!page.ok) {
          bestFailure = {
            status: 'error',
            sourceType: source.sourceType,
            sourceUrl: url,
            httpStatus: page.status || null,
            message: page.error || `http_${page.status}`
          };
          continue;
        }

        const result = await verifyOfficialProductPageHtml({
          candidate,
          html: page.text,
          sourceUrl: page.url,
          sourceType: source.sourceType,
          httpStatus: page.status
        });
        if (result.status === 'verified') return result;
        if (result.status === 'ambiguous' || bestFailure.status === 'not_found') bestFailure = result;
      }
    }
    return bestFailure;
  }

  async function verifyStoredSource(product) {
    if (!product?.sourceUrl) {
      return {
        status: 'unsupported',
        sourceType: product?.sourceType || '',
        sourceUrl: '',
        httpStatus: null,
        message: 'verified_product_has_no_source_url'
      };
    }

    const page = await fetchText(fetchImpl, product.sourceUrl, { timeoutMs, maxBytes, userAgent });
    if (!page.ok) {
      return {
        status: page.status === 404 || page.status === 410 ? 'not_found' : 'error',
        sourceType: product.sourceType || '',
        sourceUrl: product.sourceUrl,
        httpStatus: page.status || null,
        message: page.error || `http_${page.status}`
      };
    }

    return verifyOfficialProductPageHtml({
      candidate: {
        manufacturerId: product.manufacturerId,
        observedManufacturer: product.canonicalName,
        observedModel: product.canonicalModel,
        normalizedModel: product.normalizedModel
      },
      html: page.text,
      sourceUrl: page.url,
      sourceType: product.sourceType || 'manufacturer_official',
      httpStatus: page.status
    });
  }

  return { verifyCandidate, verifyStoredSource, definitions };
}
