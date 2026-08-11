import { cleanText, inferCategory, inferStockStatus, parseYen, splitManufacturerModel, stableSourceId } from './normalize.js';

function decodeJsonLd(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      results.push(JSON.parse(match[1].trim()));
    } catch {
      // Ignore malformed third-party JSON-LD and continue to the HTML fallback.
    }
  }
  return results;
}

function walkJson(value, visitor) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor);
    return;
  }
  if (typeof value === 'object') {
    visitor(value);
    for (const child of Object.values(value)) walkJson(child, visitor);
  }
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function inferCondition(title = '', context = '') {
  const rank = cleanText(context).match(/中古[：:]?\s*([A-Z][A-Z+\-]*)/i)?.[0];
  if (rank) return cleanText(rank);
  return cleanText(title).match(/『([^』]+)』/)?.[1] || '';
}

function fromJsonLd(html, { shopKey, baseUrl, hintedCategory }) {
  const products = [];
  for (const root of decodeJsonLd(html)) {
    walkJson(root, node => {
      const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (!type.some(v => String(v).toLowerCase() === 'product')) return;
      const title = cleanText(node.name || '');
      const url = absoluteUrl(baseUrl, node.url || node['@id'] || '');
      if (!title || !url) return;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
      const priceYen = parseYen(String(offer.price ?? node.price ?? ''));
      const availability = String(offer.availability || '');
      const stockStatus = /outofstock|soldout/i.test(availability) ? 'sold_out' : /instock/i.test(availability) ? 'in_stock' : 'unknown';
      const { manufacturer, model } = splitManufacturerModel(title, shopKey);
      products.push({
        sourceId: stableSourceId(url, title),
        manufacturer,
        model,
        title,
        category: inferCategory(title, hintedCategory),
        conditionText: inferCondition(title),
        priceYen,
        stockStatus,
        sourceUrl: url
      });
    });
  }
  return products;
}

function stripTagsKeepingSpacing(html) {
  const withAttributes = html.replace(/<(?:img|input)\b([^>]*)>/gi, (_, attrs) => {
    const labels = [...attrs.matchAll(/\b(?:alt|title|aria-label)\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
    return labels.length ? ` ${labels.join(' ')} ` : ' ';
  });
  return cleanText(withAttributes.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<\/p>|<\/li>|<\/div>|<\/article>/gi, ' '));
}

function fromAnchors(html, { shopKey, baseUrl, hintedCategory, productUrlPattern }) {
  const products = [];
  const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];

  for (const match of anchors) {
    const href = match[2];
    const url = absoluteUrl(baseUrl, href);
    if (!url || (productUrlPattern && !productUrlPattern.test(url))) continue;

    const index = match.index ?? 0;
    const before = html.slice(Math.max(0, index - 500), index);
    const after = html.slice(index, Math.min(html.length, index + match[0].length + 900));
    const context = stripTagsKeepingSpacing(`${before} ${match[4]} ${after}`);
    const anchorText = stripTagsKeepingSpacing(match[4]);
    // Fujiya and Audio Union place adjacent product cards close together. Reading a
    // backward window first can attach the previous card's price to the current item.
    const priceContext = shopKey === 'fujiya-avic' || shopKey === 'audiounion'
      ? stripTagsKeepingSpacing(`${match[4]} ${after}`)
      : context;
    const priceYen = parseYen(priceContext);
    if (!priceYen) continue;

    let title = anchorText;
    if (!title || title.length < 3 || /詳細|more|商品を見る|画像/i.test(title)) {
      const candidates = context.split(/￥|¥|[0-9][0-9,]*円/)[0].split(/\s{2,}|\|/).map(cleanText).filter(v => v.length >= 4);
      title = candidates.at(-1) || '';
    }
    title = cleanText(title);
    if (!title || title.length > 220) continue;

    const condition = inferCondition(title, context);
    const { manufacturer, model } = splitManufacturerModel(title, shopKey);
    products.push({
      sourceId: stableSourceId(url, title),
      manufacturer,
      model,
      title,
      category: inferCategory(title, hintedCategory),
      conditionText: condition,
      priceYen,
      stockStatus: inferStockStatus(context),
      sourceUrl: url
    });
  }
  return products;
}

function itemQuality(item) {
  return (item.stockStatus !== 'unknown' ? 500 : 0)
    + (item.model ? 200 : 0)
    + (item.priceYen != null ? 100 : 0)
    + Math.min(item.title?.length || 0, 180);
}

function mergeAudioUnionItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.sourceId || !item.sourceUrl || !item.title) continue;
    if (!groups.has(item.sourceId)) groups.set(item.sourceId, []);
    groups.get(item.sourceId).push(item);
  }

  const result = [];
  for (const group of groups.values()) {
    const first = group[0];
    const detail = group.reduce((best, item) => item.title.length > best.title.length ? item : best, first);
    if (group.length > 1 && first.title !== detail.title && first.title.length <= 80) {
      const manufacturer = cleanText(first.title);
      let model = cleanText(detail.title);
      if (model.toLowerCase().startsWith(`${manufacturer.toLowerCase()} `)) model = model.slice(manufacturer.length).trim();
      const stock = group.find(item => item.stockStatus !== 'unknown')?.stockStatus || detail.stockStatus;
      result.push({
        ...detail,
        manufacturer,
        model,
        title: model ? `${manufacturer} ${model}` : manufacturer,
        category: inferCategory(`${manufacturer} ${model}`),
        stockStatus: stock
      });
      continue;
    }
    result.push(group.reduce((best, item) => itemQuality(item) > itemQuality(best) ? item : best, first));
  }
  return result;
}

export function parseProductPage(html, options) {
  const merged = [...fromJsonLd(html, options), ...fromAnchors(html, options)];
  if (options.shopKey === 'audiounion') return mergeAudioUnionItems(merged);

  const unique = new Map();
  for (const item of merged) {
    if (!item.sourceId || !item.sourceUrl || !item.title) continue;
    const existing = unique.get(item.sourceId);
    if (!existing || itemQuality(item) > itemQuality(existing)) unique.set(item.sourceId, item);
  }
  return [...unique.values()];
}
