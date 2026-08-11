const MANUFACTURERS = [
  ['luxman', 'LUXMAN', ['luxman', 'ラックスマン']],
  ['accuphase', 'Accuphase', ['accuphase', 'アキュフェーズ']],
  ['tad', 'TAD', ['tad', 'technical audio devices', 'テクニカルオーディオデバイセズ']],
  ['bowers-wilkins', 'Bowers & Wilkins', ['bowers & wilkins', 'bowers and wilkins', 'b&w', 'bowers wilkins', 'バウワースアンドウィルキンス']],
  ['denon', 'DENON', ['denon', 'デノン']],
  ['marantz', 'Marantz', ['marantz', 'マランツ']],
  ['esoteric', 'ESOTERIC', ['esoteric', 'エソテリック']],
  ['yamaha', 'YAMAHA', ['yamaha', 'ヤマハ']],
  ['technics', 'Technics', ['technics', 'テクニクス']],
  ['sony', 'SONY', ['sony', 'ソニー']],
  ['pioneer', 'Pioneer', ['pioneer', 'パイオニア']],
  ['mcintosh', 'McIntosh', ['mcintosh', 'マッキントッシュ']],
  ['kef', 'KEF', ['kef']],
  ['jbl', 'JBL', ['jbl']],
  ['tannoy', 'TANNOY', ['tannoy', 'タンノイ']],
  ['focal', 'Focal', ['focal', 'フォーカル']],
  ['dali', 'DALI', ['dali', 'ダリ']],
  ['sonus-faber', 'Sonus faber', ['sonus faber', 'ソナスファベール']],
  ['dynaudio', 'Dynaudio', ['dynaudio', 'ディナウディオ']],
  ['monitor-audio', 'Monitor Audio', ['monitor audio', 'モニターオーディオ']],
  ['audio-technica', 'audio-technica', ['audio-technica', 'audio technica', 'オーディオテクニカ']],
  ['ortofon', 'Ortofon', ['ortofon', 'オルトフォン']],
  ['stax', 'STAX', ['stax', 'スタックス']],
  ['final', 'final', ['final', 'final audio', 'ファイナル']],
  ['sennheiser', 'Sennheiser', ['sennheiser', 'ゼンハイザー']],
  ['fostex', 'FOSTEX', ['fostex', 'フォステクス']],
  ['ifi-audio', 'iFi audio', ['ifi', 'ifi audio', 'アイファイ']],
  ['dcs', 'dCS', ['dcs']],
  ['lumin', 'LUMIN', ['lumin']],
  ['aurender', 'Aurender', ['aurender', 'オーレンダー']],
  ['soulnote', 'SOULNOTE', ['soulnote', 'ソウルノート']],
  ['gustard', 'Gustard', ['gustard']],
  ['bricasti', 'Bricasti Design', ['bricasti', 'bricasti design']],
  ['mola-mola', 'Mola Mola', ['mola mola']],
  ['linn', 'LINN', ['linn', 'リン']],
  ['naim', 'Naim', ['naim', 'ネイム']],
  ['chord', 'Chord Electronics', ['chord', 'chord electronics', 'コード']],
  ['ifi', 'iFi', ['ifi audio japan']],
  ['ibasso-audio', 'iBasso Audio', ['ibasso', 'ibasso audio', 'アイバッソ', 'アイバッソオーディオ']],
  ['moondrop', '水月雨 (MOONDROP)', ['moondrop', '水月雨', '水月雨(moondrop)', '水月雨（moondrop）', 'スイゲツアメ']]
].map(([id, name, aliases]) => Object.freeze({ id, name, aliases }));

function normalizeKey(value = '') {
  return String(value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, '')
    .replace(/(?:株式会社|有限会社|合同会社)/g, '')
    .replace(/[\s・･_\-\/&+.,'"()（）]+/g, '');
}

const BY_ALIAS = new Map();
for (const manufacturer of MANUFACTURERS) {
  BY_ALIAS.set(normalizeKey(manufacturer.name), manufacturer);
  for (const alias of manufacturer.aliases) BY_ALIAS.set(normalizeKey(alias), manufacturer);
}

function hashKey(value) {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fallbackId(key) {
  const ascii = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.length >= 2 ? ascii.slice(0, 80) : `brand-${hashKey(key)}`;
}

export function manufacturerIdForFilter(value = '') {
  const key = normalizeKey(value);
  if (!key) return '';
  return BY_ALIAS.get(key)?.id || fallbackId(key);
}

export function normalizeManufacturer(value = '') {
  const raw = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!raw) return { id: '', displayName: '', matchedAlias: false };
  const key = normalizeKey(raw);
  const known = BY_ALIAS.get(key);
  if (known) return { id: known.id, displayName: known.name, matchedAlias: true };
  return { id: fallbackId(key), displayName: raw, matchedAlias: false };
}
