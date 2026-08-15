import type {
  ManufacturerDefinition,
  ManufacturerModelSplit,
  ManufacturerNormalizationResult,
  ManufacturerSourceEntry,
  PrefixAliasEntry,
} from "./types.js";

const MANUFACTURER_SOURCE: readonly ManufacturerSourceEntry[] = [
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
];

const MANUFACTURERS: readonly ManufacturerDefinition[] = MANUFACTURER_SOURCE.map(
  ([id, name, aliases]) => Object.freeze({ id, name, aliases }),
);

export function normalizeManufacturerKey(value: unknown = ""): string {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, "")
    .replace(/(?:株式会社|有限会社|合同会社)/g, "")
    .replace(/[\s・･_\-/&+.,'"()（）]+/g, "");
}

function cleanSourceText(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anchored pattern matching a manufacturer presentation prefix, tolerant of the separators
 * retailers put between brand words. Shared by manufacturer title extraction and by Model
 * Resolution, which removes the same tokens before extracting a model candidate.
 */
export function manufacturerPrefixPattern(alias: unknown = ""): RegExp | null {
  const tokens = cleanSourceText(alias)
    .split(/[\s・･_\-/&+.,'"()（）]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  const separator = `[\\s・･_\\-\\/&+.,'"()（）]*`;
  const boundary = `[\\s・･_\\-\\/&+.,'"()（）]`;
  return new RegExp(`^${tokens.map(escapeRegExp).join(separator)}(?=$|${boundary})`, "iu");
}

const BY_ALIAS = new Map<string, ManufacturerDefinition>();
const BY_ID = new Map<string, ManufacturerDefinition>();
const PREFIX_ALIASES: PrefixAliasEntry[] = [];
for (const manufacturer of MANUFACTURERS) {
  BY_ID.set(manufacturer.id, manufacturer);
  const aliases = [manufacturer.name, ...manufacturer.aliases];
  for (const alias of aliases) {
    const key = normalizeManufacturerKey(alias);
    BY_ALIAS.set(key, manufacturer);
    const pattern = manufacturerPrefixPattern(alias);
    if (pattern) PREFIX_ALIASES.push({ manufacturer, alias, key, pattern });
  }
}
PREFIX_ALIASES.sort((a, b) => b.key.length - a.key.length || b.alias.length - a.alias.length);

function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fallbackId(key: string): string {
  const ascii = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii.length >= 2 ? ascii.slice(0, 80) : `brand-${hashKey(key)}`;
}

export function manufacturerIdForFilter(value: unknown = ""): string {
  const raw = cleanSourceText(value).toLowerCase();
  if (BY_ID.has(raw)) return raw;
  const key = normalizeManufacturerKey(value);
  if (!key) return "";
  return BY_ALIAS.get(key)?.id || fallbackId(key);
}

export function manufacturerSearchAliases(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) return cleanSourceText(value) ? [cleanSourceText(value)] : [];
  return [...new Set([manufacturer.id, manufacturer.name, ...manufacturer.aliases])];
}

export function normalizeManufacturer(value: unknown = ""): ManufacturerNormalizationResult {
  const raw = cleanSourceText(value);
  if (!raw) return { id: "", displayName: "", matchedAlias: false };
  const key = normalizeManufacturerKey(raw);
  const known = BY_ALIAS.get(key) || BY_ID.get(raw.toLowerCase());
  if (known) return { id: known.id, displayName: known.name, matchedAlias: true };
  return { id: fallbackId(key), displayName: raw, matchedAlias: false };
}

export function splitKnownManufacturerModel(value: unknown = ""): ManufacturerModelSplit | null {
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

/** Immutable bootstrap catalog used when D1 has no operational alias for a spelling yet. */
export function bootstrapManufacturers(): readonly ManufacturerDefinition[] {
  return MANUFACTURERS;
}
