const CATEGORY_RULES = [
  ['スピーカー', /speaker|スピーカー|monitor\s*audio|bookshelf/i],
  ['プリメインアンプ', /integrated|プリメイン|pma-|ma\d|a-\d/i],
  ['プリアンプ', /preamp|pre amplifier|プリアンプ|control amplifier/i],
  ['パワーアンプ', /power amp|power amplifier|パワーアンプ/i],
  ['DAC', /\bdac\b|d\/a|d-a|コンバータ|converter|wandla|tambaqui/i],
  ['ネットワーク', /network|streamer|streaming|ネットワーク|rivo|zen stream/i],
  ['CD/SACDプレーヤー', /sacd|cd player|cdプレーヤ|dcd-/i],
  ['アナログ', /turntable|record player|phono|ターンテーブル|レコード|カートリッジ/i],
  ['ヘッドホン', /headphone|ヘッドホン|イヤホン|earphone|stax|d8000|susvara/i],
  ['ケーブル・アクセサリー', /cable|ケーブル|usb|電源|insulator|インシュレータ|アクセサリ/i]
];

export function cleanText(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseYen(value = '') {
  const normalized = String(value).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const match = normalized.match(/[¥￥]?\s*([0-9][0-9,]*)\s*円?/);
  return match ? Number.parseInt(match[1].replace(/,/g, ''), 10) : null;
}

export function inferStockStatus(text = '') {
  const value = cleanText(text).toLowerCase();
  if (/売り切れ|売切|sold\s*out|販売終了|ご成約|在庫なし/.test(value)) return 'sold_out';
  if (/在庫あり|in\s*stock|カートに入れる|購入する/.test(value)) return 'in_stock';
  return 'unknown';
}

export function inferCategory(title = '', hintedCategory = '') {
  if (hintedCategory) return hintedCategory;
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(title)) return category;
  }
  return 'その他';
}

export function splitManufacturerModel(title, shopKey) {
  let value = cleanText(title)
    .replace(/^〖[^〗]+〗\s*/g, '')
    .replace(/^中古[：:]?\s*[A-Z+-]*\s*/i, '')
    .replace(/《[^》]+》\s*$/g, '')
    .trim();

  if (shopKey === 'ippinkan' && value.includes(' - ')) {
    const [manufacturer, ...rest] = value.split(' - ');
    return { manufacturer: manufacturer.trim(), model: rest.join(' - ').trim() };
  }

  const tokens = value.split(/\s+/);
  const manufacturer = tokens[0] || '';
  return { manufacturer, model: tokens.slice(1).join(' ') };
}

export function stableSourceId(url, title = '') {
  try {
    const parsed = new URL(url);
    const pathId = parsed.pathname.match(/(?:detail|goods|item|product|shopdetail)[/_-]?([A-Za-z0-9_-]+)/i)?.[1];
    if (pathId) return pathId;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return cleanText(title).toLowerCase().replace(/\s+/g, '-').slice(0, 180);
  }
}
