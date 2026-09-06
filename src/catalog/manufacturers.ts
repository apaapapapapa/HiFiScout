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
  ["acoustic-revive", "ACOUSTIC REVIVE", ["acoustic revive", "アコースティックリバイブ"]],
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
  ["jelco", "JELCO", ["jelco", "ジェルコ"]],
  ["sme", "SME", ["sme"]],
  ["micro", "MICRO", ["micro", "micro seiki", "マイクロ", "マイクロ精機"]],
  ["audiocraft", "Audio Craft", ["audio craft", "audiocraft", "オーディオクラフト"]],
  ["acousticsolid", "Acoustic Solid", ["acoustic solid", "アコースティックソリッド"]],
  ["goldmund", "GOLDMUND", ["goldmund", "gold mund", "ゴールドムンド"]],
  ["chario", "Chario", ["chario", "チャリオ"]],
  ["linear-technology", "Linear Technology", ["linear technology"]],
  ["jeff-rowland", "Jeff Rowland", ["jeff rowland"]],
  ["first-watt", "First Watt", ["first watt"]],
  ["musical-fidelity", "MUSICAL FIDELITY", ["musical fidelity"]],
  ["flying-mole", "FLYING MOLE", ["flying mole"]],
  ["boenicke-audio", "Boenicke audio", ["boenicke audio"]],
  ["lite-audio", "Lite Audio", ["lite audio"]],
  ["aune-audio", "aune audio", ["aune audio"]],
  [
    "audiodesksysteme-glaess",
    "Audiodesksysteme Gläss",
    ["glass-audio desk systeme", "audio desk systeme"],
  ],
  ["my-sonic-lab", "My Sonic Lab", ["my sonic lab"]],
  ["rosen-kranz", "ROSEN KRANZ", ["rosen kranz"]],
  ["eau-rouge", "Eau Rouge", ["eau rouge"]],
  ["double-helix-cables", "Double Helix Cables", ["double helix cables"]],
  ["solid-tech", "SOLID TECH", ["solid tech"]],
  ["top-wing", "TOP WING", ["top wing"]],
  ["united-electronics", "UNITED ELECTRONICS", ["united electronics"]],
  ["yg-acoustics", "YG Acoustics", ["yg acoustics"]],
  ["luna-cables", "Luna Cables", ["luna cables"]],
  ["trinnov-audio", "TRINNOV AUDIO", ["trinnov audio"]],
  ["speaker-craft", "Speaker Craft", ["speaker craft"]],
  ["audio-replas", "Audio Replas", ["audio replas"]],
  ["gallo-acoustic", "GALLO ACOUSTIC", ["gallo acoustic", "gallo acoustic(旧 anthony gallo)"]],
  ["polk-audio", "Polk Audio", ["polk audio"]],
  ["storm-audio", "STORM AUDIO", ["storm audio"]],
  ["wilson-audio", "Wilson Audio", ["wilson audio"]],
  ["westlake-audio", "Westlake Audio", ["westlake audio"]],
  ["kiso-acoustic", "Kiso Acoustic", ["kiso acoustic"]],
  ["constellation-audio", "Constellation Audio", ["constellation audio"]],
  ["avalon-acoustics", "Avalon Acoustics", ["avalon acoustics"]],
  ["ferrum-audio", "Ferrum Audio", ["ferrum audio"]],
  ["austrian-audio", "Austrian Audio", ["austrian audio"]],
  ["brise-audio", "Brise Audio", ["brise audio"]],
  ["audia-flight", "Audia Flight", ["audia flight", "audia"]],
  ["electron-tube", "Electron tube", ["electron tube"]],
  ["kef", "KEF", ["kef"]],
  ["jbl", "JBL", ["jbl"]],
  [
    "western-electric",
    "Western Electric",
    ["western electric", "ウエスタンエレクトリック", "ウェスタン・エレクトリック"],
  ],
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
  ["ch-precision", "CH PRECISION", ["ch precision", "chprecision"]],
  ["silent-angel", "Silent Angel", ["silent angel", "silentangel"]],
  ["msb-technology", "MSB Technology", ["msb", "msb technology"]],
  [
    "camelot-technology",
    "CAMELOT TECHNOLOGY",
    ["camelot", "camelot technology", "キャメロットテクノロジー"],
  ],
  [
    "organic-audio",
    "Organic Audio",
    ["organic", "organic audio", "オーガニックオーディオ", "オーガニック・オーディオ"],
  ],
  ["lumin", "LUMIN", ["lumin"]],
  ["aurender", "Aurender", ["aurender", "オーレンダー"]],
  ["soulnote", "SOULNOTE", ["soulnote", "ソウルノート"]],
  ["gustard", "Gustard", ["gustard"]],
  ["bricasti", "Bricasti Design", ["bricasti", "bricasti design"]],
  ["mola-mola", "Mola Mola", ["mola mola"]],
  ["linn", "LINN", ["linn", "リン"]],
  ["naim", "Naim", ["naim", "ネイム"]],
  ["chord", "Chord Electronics", ["chord", "chord electronics", "コード"]],
  ["airbow", "AIRBOW", ["airbow", "エアボウ"]],
  ["aura", "AURA", ["aura"]],
  [
    "astellkern",
    "Astell&Kern",
    ["astell&kern", "astell & kern", "astell kern", "アステルアンドケルン", "アステル&ケルン"],
  ],
  ["fiio", "FiiO", ["fiio", "フィーオ"]],
  ["cayin", "Cayin", ["cayin", "カイン"]],
  ["hibymusic", "HiBy", ["hiby", "hibymusic", "hiby music", "ハイビー", "ハイビーミュージック"]],
  [
    "campfireaudio",
    "Campfire Audio",
    ["campfire audio", "campfireaudio", "キャンプファイヤーオーディオ"],
  ],
  ["uniquemelody", "Unique Melody", ["unique melody", "uniquemelody", "ユニークメロディ"]],
  ["audioquest", "AudioQuest", ["audioquest", "audio quest", "オーディオクエスト"]],
  ["tiglon", "TIGLON", ["tiglon", "ティグロン"]],
  ["kenwood", "KENWOOD", ["kenwood", "ケンウッド"]],
  ["trio", "TRIO", ["trio", "トリオ"]],
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

const MANUFACTURER_LISTING_LABEL =
  /^(?:(?:【|〖|\[)\s*(?:中古(?:品)?|新品|展示(?:処分)?品?|特価(?:商品|品)?|未使用(?:開封)?品?|B級品|アウトレット(?:品)?|現品処分品|セール中|送料無料)\s*(?:】|〗|\])\s*)+/iu;

/** Remove seller condition badges accidentally captured as part of manufacturer/title evidence. */
export function stripManufacturerListingLabels(value: unknown = ""): string {
  return String(value).replace(MANUFACTURER_LISTING_LABEL, "").trim();
}

const MANUFACTURER_PLACEHOLDER_RE = /^(?:不明(?:\s+.*)?|メーカー不明|その他|ノーブランド)$/u;

export function isManufacturerPlaceholder(value: unknown = ""): boolean {
  const text = stripManufacturerListingLabels(String(value))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return MANUFACTURER_PLACEHOLDER_RE.test(text);
}

export function normalizeManufacturerKey(value: unknown = ""): string {
  const stripped = stripManufacturerListingLabels(String(value).normalize("NFKC"));
  if (isManufacturerPlaceholder(stripped)) return "";
  return stripped
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

// Most seller titles begin with an ASCII brand. Match only aliases with that initial rather than
// running every bootstrap regular expression for every listing. Keep the full path for other
// scripts so Unicode case-folding semantics stay owned by the existing /iu patterns.
const PREFIX_ALIASES_BY_INITIAL = new Map<string, PrefixAliasEntry[]>();
for (const candidate of PREFIX_ALIASES) {
  const initial = cleanSourceText(candidate.alias)
    .replace(/^[\s・･_\-/&+.,'"()（）]+/u, "")[0]
    ?.toLowerCase();
  if (!initial || !/^[a-z]$/u.test(initial)) continue;
  const entries = PREFIX_ALIASES_BY_INITIAL.get(initial) || [];
  entries.push(candidate);
  PREFIX_ALIASES_BY_INITIAL.set(initial, entries);
}

function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fallbackId(key: string): string {
  if (!key) return "";
  const ascii = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii.length >= 2 ? ascii.slice(0, 80) : `brand-${hashKey(key)}`;
}

/**
 * Reproduce the pre-listing-label normalization key for legacy ids that can still exist while a
 * resolver-version replay is draining. This is deliberately private: new writes must always use
 * the current canonical normalization above.
 */
function legacyManufacturerKey(value: unknown = ""): string {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, "")
    .replace(/(?:株式会社|有限会社|合同会社)/g, "")
    .replace(/[\s・･_\-/&+.,'"()（）]+/g, "");
}

export function manufacturerIdForFilter(value: unknown = ""): string {
  const raw = cleanSourceText(value).toLowerCase();
  if (BY_ID.has(raw)) return raw;
  const key = normalizeManufacturerKey(value);
  if (!key) return "";
  return BY_ALIAS.get(key)?.id || fallbackId(key);
}

/**
 * IDs that may represent the same known manufacturer while historical resolver output is being
 * replayed. The canonical id is first; the remaining ids are exactly the fallback ids the previous
 * normalization produced for canonical names and aliases (for example `msb` before
 * `msb-technology`). Unknown manufacturers keep their single deterministic id.
 */
export function manufacturerFilterIds(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) {
    const id = manufacturerIdForFilter(value);
    return id ? [id] : [];
  }

  const ids = new Set<string>([manufacturer.id]);
  for (const alias of [manufacturer.name, ...manufacturer.aliases]) {
    const legacyKey = legacyManufacturerKey(alias);
    if (legacyKey) ids.add(fallbackId(legacyKey));
  }
  return [...ids];
}

/** Public and seller spellings that may appear in a stale entity's manufacturer presentation. */
export function manufacturerFilterPresentations(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) {
    const presentation = cleanSourceText(stripManufacturerListingLabels(value));
    return presentation ? [presentation] : [];
  }
  return [...new Set([manufacturer.name, ...manufacturer.aliases])];
}

export function manufacturerSearchAliases(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) return cleanSourceText(value) ? [cleanSourceText(value)] : [];
  return [...new Set([manufacturer.id, manufacturer.name, ...manufacturer.aliases])];
}

export function normalizeManufacturer(value: unknown = ""): ManufacturerNormalizationResult {
  const raw = cleanSourceText(stripManufacturerListingLabels(value));
  if (!raw) return { id: "", displayName: "", matchedAlias: false };
  const key = normalizeManufacturerKey(raw);
  const known = BY_ALIAS.get(key) || BY_ID.get(raw.toLowerCase());
  if (known) return { id: known.id, displayName: known.name, matchedAlias: true };
  return { id: fallbackId(key), displayName: raw, matchedAlias: false };
}

const BRACKETED_PREFIX = /^\s*[([［（【]\s*([^)\]］）】]{1,40})\s*[)\]］）】]/u;

/**
 * Remove a bracketed second spelling of the manufacturer that already matched as a prefix.
 *
 * Retailers write both spellings of one brand — `Bowers&Wilkins(B&W) 802D4 B`. Stripping the
 * bracketed alias as a whole group is what keeps the leading-separator cleanup below from eating
 * the opening bracket alone and stranding its closing bracket at the head of the model.
 */
export function stripBracketedManufacturerAlias(
  value: unknown = "",
  aliases: readonly string[] = [],
): string {
  const text = String(value);
  const match = text.match(BRACKETED_PREFIX);
  if (!match) return text;
  const key = normalizeManufacturerKey(match[1]);
  if (!key) return text;
  return aliases.some((alias) => normalizeManufacturerKey(alias) === key)
    ? text.slice(match[0].length)
    : text;
}

export function splitKnownManufacturerModel(value: unknown = ""): ManufacturerModelSplit | null {
  const raw = cleanSourceText(stripManufacturerListingLabels(value));
  if (!raw) return null;

  const initial = raw[0].toLowerCase();
  const candidates = /^[a-z]$/u.test(initial)
    ? PREFIX_ALIASES_BY_INITIAL.get(initial) || []
    : PREFIX_ALIASES;
  for (const candidate of candidates) {
    const match = raw.match(candidate.pattern);
    if (!match) continue;
    const model = stripBracketedManufacturerAlias(raw.slice(match[0].length), [
      candidate.manufacturer.name,
      ...candidate.manufacturer.aliases,
    ])
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
