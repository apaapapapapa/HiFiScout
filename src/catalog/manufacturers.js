const MANUFACTURERS = [
  ["luxman", "LUXMAN", ["luxman", "ラックスマン"]],
  ["accuphase", "Accuphase", ["accuphase", "アキュフェーズ"]],
  ["tad", "TAD", ["tad", "technical audio devices", "テクニカルオーディオデバイセズ"]],
  [
    "bowers-wilkins",
    "Bowers & Wilkins",
    [
      "bowers & wilkins",
      "bowers and wilkins",
      "b&w",
      "bowers wilkins",
      "バウワースアンドウィルキンス",
    ],
  ],
  ["denon", "DENON", ["denon", "デノン"]],
  ["marantz", "Marantz", ["marantz", "マランツ"]],
  ["esoteric", "ESOTERIC", ["esoteric", "エソテリック"]],
  ["yamaha", "YAMAHA", ["yamaha", "ヤマハ"]],
  ["technics", "Technics", ["technics", "テクニクス"]],
  ["sony", "SONY", ["sony", "ソニー"]],
  ["pioneer", "Pioneer", ["pioneer", "パイオニア"]],
  ["mcintosh", "McIntosh", ["mcintosh", "マッキントッシュ"]],
  [
    "mark-levinson",
    "Mark Levinson",
    ["mark levinson", "marklevinson", "マークレビンソン", "マーク・レビンソン"],
  ],
  ["thorens", "Thorens", ["thorens", "トーレンス"]],
  ["linear-technology", "Linear Technology", ["linear technology"]],
  ["kef", "KEF", ["kef"]],
  ["jbl", "JBL", ["jbl"]],
  ["tannoy", "TANNOY", ["tannoy", "タンノイ"]],
  ["focal", "Focal", ["focal", "フォーカル"]],
  ["dali", "DALI", ["dali", "ダリ"]],
  ["sonus-faber", "Sonus faber", ["sonus faber", "ソナスファベール"]],
  ["dynaudio", "Dynaudio", ["dynaudio", "ディナウディオ"]],
  ["monitor-audio", "Monitor Audio", ["monitor audio", "モニターオーディオ"]],
  ["audio-technica", "audio-technica", ["audio-technica", "audio technica", "オーディオテクニカ"]],
  ["ortofon", "Ortofon", ["ortofon", "オルトフォン"]],
  ["stax", "STAX", ["stax", "スタックス"]],
  ["final", "final", ["final", "final audio", "ファイナル"]],
  ["sennheiser", "Sennheiser", ["sennheiser", "ゼンハイザー"]],
  ["fostex", "FOSTEX", ["fostex", "フォステクス"]],
  ["ifi-audio", "iFi audio", ["ifi", "ifi audio", "ifi audio japan", "アイファイ"]],
  ["dcs", "dCS", ["dcs"]],
  ["lumin", "LUMIN", ["lumin"]],
  ["aurender", "Aurender", ["aurender", "オーレンダー"]],
  ["soulnote", "SOULNOTE", ["soulnote", "ソウルノート"]],
  ["gustard", "Gustard", ["gustard"]],
  ["bricasti", "Bricasti Design", ["bricasti", "bricasti design"]],
  ["mola-mola", "Mola Mola", ["mola mola"]],
  ["linn", "LINN", ["linn", "リン"]],
  ["naim", "Naim", ["naim", "ネイム"]],
  ["chord", "Chord Electronics", ["chord", "chord electronics", "コード"]],
  [
    "ibasso-audio",
    "iBasso Audio",
    ["ibasso", "ibasso audio", "アイバッソ", "アイバッソオーディオ"],
  ],
  [
    "moondrop",
    "水月雨 (MOONDROP)",
    ["moondrop", "水月雨", "水月雨(moondrop)", "水月雨（moondrop）", "スイゲツアメ"],
  ],
].map(([id, name, aliases]) => Object.freeze({ id, name, aliases }));

function normalizeKey(value = "") {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, "")
    .replace(/(?:株式会社|有限会社|合同会社)/g, "")
    .replace(/[\s・･_\-/&+.,'"()（）]+/g, "");
}

function cleanSourceText(value = "") {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixPattern(alias) {
  const tokens = cleanSourceText(alias)
    .split(/[\s・･_\-/&+.,'"()（）]+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const separator = `[\\s・･_\\-\\/&+.,'"()（）]*`;
  const boundary = `[\\s・･_\\-\\/&+.,'"()（）]`;
  return new RegExp(`^${tokens.map(escapeRegExp).join(separator)}(?=$|${boundary})`, "i");
}

const BY_ALIAS = new Map();
const PREFIX_ALIASES = [];
for (const manufacturer of MANUFACTURERS) {
  const aliases = [manufacturer.name, ...manufacturer.aliases];
  for (const alias of aliases) {
    const key = normalizeKey(alias);
    BY_ALIAS.set(key, manufacturer);
    const pattern = prefixPattern(alias);
    if (pattern) PREFIX_ALIASES.push({ manufacturer, alias, key, pattern });
  }
}
PREFIX_ALIASES.sort((a, b) => b.key.length - a.key.length || b.alias.length - a.alias.length);

function hashKey(value) {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fallbackId(key) {
  const ascii = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii.length >= 2 ? ascii.slice(0, 80) : `brand-${hashKey(key)}`;
}

export function manufacturerIdForFilter(value = "") {
  const key = normalizeKey(value);
  if (!key) return "";
  return BY_ALIAS.get(key)?.id || fallbackId(key);
}

export function normalizeManufacturer(value = "") {
  const raw = cleanSourceText(value);
  if (!raw) return { id: "", displayName: "", matchedAlias: false };
  const key = normalizeKey(raw);
  const known = BY_ALIAS.get(key);
  if (known) return { id: known.id, displayName: known.name, matchedAlias: true };
  return { id: fallbackId(key), displayName: raw, matchedAlias: false };
}

export function splitKnownManufacturerModel(value = "") {
  const raw = cleanSourceText(value);
  if (!raw) return null;

  for (const candidate of PREFIX_ALIASES) {
    const match = raw.match(candidate.pattern);
    if (!match) continue;
    const model = raw
      .slice(match[0].length)
      .replace(/^[\s・･_\-/&+.,'"()（）]+/, "")
      .trim();
    return {
      id: candidate.manufacturer.id,
      displayName: candidate.manufacturer.name,
      rawManufacturer: match[0].trim(),
      model,
    };
  }
  return null;
}
