const CATEGORY_RULES = [
  ['スピーカー', /speaker|スピーカー|monitor\s*audio|bookshelf/i],
  ['プリメインアンプ', /integrated|プリメイン|pma-|ma\d|a-\d/i],
  ['プリアンプ', /preamp|pre amplifier|プリアンプ|control amplifier/i],
  ['パワーアンプ', /power amp|power amplifier|パワーアンプ/i],
  ['DAC', /\bdac\b|d\/a|d-a|コンバータ|converter|wandla|tambaqui/i],
  ['ネットワーク', /network|streamer|streaming|ネットワーク|rivo|zen stream/i],
  ['CD/SACDプレーヤー', /sacd|cd player|cdプレーヤ|dcd-/i],
  ['アナログ', /turntable|record player|phono|ターンテーブル|レコード|カートリッジ/i],
  ['イヤホン', /earphone|イヤホン|iem\b/i],
  ['ヘッドホン', /headphone|ヘッドホン|stax|d8000|susvara/i],
  ['DAP・ヘッドホンアンプ', /\bdap\b|digital audio player|headphone amp|ヘッドホンアンプ|ポータブルプレーヤ/i],
  ['DJ機器・DTM', /\bdj\b|\bddj[-\s]|rekordbox|serato|turntable controller|オーディオインターフェース|midi/i],
  ['ケーブル・アクセサリー', /cable|ケーブル|usb|電源|insulator|インシュレータ|アクセサリ/i]
];

export function cleanText(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&yen;|&#165;|&#x0*a5;/gi, '¥')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseYen(value = '') {
  const normalized = cleanText(value).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const marked = normalized.match(/[¥￥]\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円/);
  const markedValue = marked?.[1] || marked?.[2];
  if (markedValue) return Number.parseInt(markedValue.replace(/,/g, ''), 10);

  const numericOnly = normalized.trim().match(/^([0-9][0-9,]*)$/)?.[1];
  return numericOnly ? Number.parseInt(numericOnly.replace(/,/g, ''), 10) : null;
}

export function inferStockStatus(text = '') {
  const value = cleanText(text).toLowerCase();
  if (/売り切れ|売切|売約済(?:み)?|sold\s*out|販売終了|ご成約|在庫なし|完売|品切れ/.test(value)) return 'sold_out';
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

function splitFujiyaManufacturerModel(value) {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const firstJapaneseToken = tokens.findIndex(token => /[ぁ-んァ-ヶ一-龯]/.test(token));
  if (firstJapaneseToken < 0) return null;

  const manufacturerEnd = firstJapaneseToken === 0 ? 1 : firstJapaneseToken;
  const modelStart = tokens.findIndex((token, index) => index >= manufacturerEnd && /[A-Za-z0-9]/.test(token));
  if (modelStart < 0) return null;

  return {
    manufacturer: tokens.slice(0, manufacturerEnd).join(' '),
    model: tokens.slice(modelStart).join(' ')
  };
}

export function splitManufacturerModel(title, shopKey) {
  let value = cleanText(title)
    .replace(/^〖[^〗]+〗\s*/g, '')
    .replace(/^中古[：:]?\s*[A-Z+-]*\s*/i, '')
    .replace(/『[^』]+』/g, '')
    .replace(/《[^》]+》\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (shopKey === 'ippinkan' && value.includes(' - ')) {
    const [manufacturer, ...rest] = value.split(' - ');
    return { manufacturer: manufacturer.trim(), model: rest.join(' - ').trim() };
  }

  if (shopKey === 'fujiya-avic') {
    const fujiya = splitFujiyaManufacturerModel(value);
    if (fujiya) return fujiya;
  }

  const tokens = value.split(/\s+/);
  const manufacturer = tokens[0] || '';
  return { manufacturer, model: tokens.slice(1).join(' ') };
}

export function stableSourceId(url, title = '') {
  try {
    const parsed = new URL(url);
    const audioUnionId = parsed.pathname.match(/\/ct\/detail\/(?:used|new)\/(\d+)\/?/i)?.[1];
    if (audioUnionId) return audioUnionId;
    const pathId = parsed.pathname.match(/(?:detail|goods|item|product|shopdetail)[/_-]?([A-Za-z0-9_-]+)/i)?.[1];
    if (pathId) return pathId;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return cleanText(title).toLowerCase().replace(/\s+/g, '-').slice(0, 180);
  }
}
