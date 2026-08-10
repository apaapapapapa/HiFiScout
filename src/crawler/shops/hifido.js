import { cleanText, inferCategory, inferStockStatus, parseYen } from '../normalize.js';

const PRODUCT_LINK_RE = /<a\b[^>]*href\s*=\s*["']([^"']*\/(\d{2}-\d{5}-\d{5}-\d{2})\.html[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
const CATEGORY_RE = /(スピーカー(?:（[^）]+）)?|コントロールアンプ(?:（[^）]+）)?|プリアンプ(?:（[^）]+）)?|プリメインアンプ(?:（[^）]+）)?|パワーアンプ(?:（[^）]+）)?|レコードプレーヤー|CDプレーヤー|SACD(?:\/CD)?プレーヤー|D\/Aコンバーター|DAコンバーター|ネットワークプレーヤー|ネットワークトランスポート|トーンアーム|カートリッジ|ヘッドホン|イヤホン|ケーブル|アクセサリー|真空管|ラック|その他オーディオ機器)/i;

function canonicalManufacturer(value = '') {
  const text = cleanText(value);
  const japaneseIndex = text.search(/[ぁ-んァ-ヶ一-龯]/);
  const latin = japaneseIndex > 0 ? text.slice(0, japaneseIndex).trim() : '';
  return latin || text;
}

function absoluteUrl(href) {
  try {
    return new URL(href, 'https://www.hifido.co.jp').toString();
  } catch {
    return null;
  }
}

function htmlToText(html) {
  return cleanText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<\/(?:p|li|div|article|section|tr|td|h\d)>/gi, ' ')
  );
}

export function parseHifidoListing(html) {
  const matches = [...html.matchAll(PRODUCT_LINK_RE)];
  const products = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextIndex = matches[index + 1]?.index ?? html.length;
    const blockEnd = Math.min(nextIndex, (match.index ?? 0) + 3500);
    const block = html.slice(match.index ?? 0, blockEnd);
    const text = htmlToText(block);
    const title = cleanText(match[3]);
    const sourceUrl = absoluteUrl(match[1]);
    if (!title || !sourceUrl) continue;

    const priceText = text.match(/売価(?:\([^)]*\))?\s*[:：]\s*[¥￥]?\s*([0-9０-９][0-9０-９,，]*)\s*円?/i)?.[1] || '';
    const priceYen = parseYen(priceText);
    if (priceYen == null) continue;

    const manufacturerRaw = text.match(/メーカー\s*[:：]\s*(.+?)(?=\s+(?:定価|売価)\s*[:：])/i)?.[1] || '';
    const manufacturer = canonicalManufacturer(manufacturerRaw);
    const categoryRaw = text.match(CATEGORY_RE)?.[1] || '';
    const category = categoryRaw ? categoryRaw.replace(/（[^）]+）/g, '').trim() : inferCategory(title);
    let stockStatus = inferStockStatus(text);
    if (stockStatus === 'unknown' && /(?:^|\s)注文(?:\s|$)/.test(text)) stockStatus = 'in_stock';

    products.push({
      sourceId: match[2],
      manufacturer,
      model: title,
      title,
      category,
      conditionText: /パーツ取り用商品|ジャンク/i.test(text) ? 'ジャンク' : '',
      priceYen,
      stockStatus,
      sourceUrl
    });
  }

  return [...new Map(products.map(product => [product.sourceId, product])).values()];
}

export const hifidoAdapter = {
  key: 'hifido',
  name: 'ハイファイ堂',
  baseUrl: 'https://www.hifido.co.jp',
  *pageUrls(maxPages) {
    const pageSize = 50;
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      yield `https://www.hifido.co.jp/?L=${pageSize}&LNG=J&O=${offset}&OD=0`;
    }
  },
  parse(html) {
    return parseHifidoListing(html);
  }
};
