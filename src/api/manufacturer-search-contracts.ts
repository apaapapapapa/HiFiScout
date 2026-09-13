/** Browser-safe vocabulary and prefix semantics for public search queries. */
import type { ManufacturerSourceEntry } from "../catalog/types.js";

export const MANUFACTURER_SOURCE: readonly ManufacturerSourceEntry[] = [
  ["luxman", "LUXMAN", ["luxman", "ラックスマン"]],
  ["accuphase", "Accuphase", ["accuphase", "アキュフェーズ"]],
  ["acoustic-revive", "ACOUSTIC REVIVE", ["acoustic revive", "アコースティックリバイブ"]],
  // KOJO TECHNOLOGY is 光城精工's audio brand: https://kojo-seiko.co.jp/
  [
    "kojo",
    "KOJO",
    [
      "KOJO TECHNOLOGY",
      "光城精工",
      "コージョー",
      "コウジョウテクノロジー",
      "KOJO TECHNOLOGY コウジョウテクノロジー",
      "KOJO（光城精工）",
    ],
  ],
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
  // Migration 0035 verifies Pioneer DJ as an alias of `pioneer`. Reuse that identity while
  // recognizing the full bilingual prefix in seller titles.
  [
    "pioneer",
    "Pioneer",
    ["pioneer", "パイオニア", "pioneer dj", "pioneerdj", "パイオニアディージェー"],
  ],
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
  ["counterpoint", "Counterpoint", ["counterpoint", "counter point", "カウンターポイント"]],
  ["golden-dragon", "Golden Dragon", ["golden dragon", "goldendragon", "ゴールデンドラゴン"]],
  ["essence-audio", "ESSENCE AUDIO", ["essence audio"]],
  ["quill-acoustics", "Quill Acoustics", ["quill acoustics", "quillacoustics"]],
  ["g4-audio", "G4 Audio", ["g4 audio"]],
  ["mother-audio", "Mother Audio", ["mother audio", "motheraudio"]],
  ["unisonresearch", "Unison Research", ["unison research"]],
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

const MANUFACTURER_LISTING_LABEL =
  /^(?:(?:【|〖|\[)\s*(?:中古(?:品)?|新品|展示(?:処分)?品?|特価(?:商品|品)?|未使用(?:開封)?品?|B級品|アウトレット(?:品)?|現品処分品|セール中|SALE|美品|極美品|送料無料|国内正規品(?:\s*100V)?|正規輸入品|バナナプラグ仕様)\s*(?:】|〗|\])\s*)+/iu;

/** Remove seller condition badges accidentally captured as part of manufacturer/title evidence. */
export function stripManufacturerListingLabels(value: unknown = ""): string {
  return String(value).trim().replace(MANUFACTURER_LISTING_LABEL, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function manufacturerPrefixPattern(alias: unknown = ""): RegExp | null {
  const tokens = String(alias)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .split(/[\s・･_\-/&+.,'"()（）]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  const separator = `[\\s・･_\\-\\/&+.,'"()（）]*`;
  const boundary = `[\\s・･_\\-\\/&+.,'"()（）]`;
  return new RegExp(`^${tokens.map(escapeRegExp).join(separator)}(?=$|${boundary})`, "iu");
}

const SEARCH_PREFIXES = MANUFACTURER_SOURCE.flatMap(([id, name, aliases]) =>
  [name, ...aliases].map((alias) => ({ id, alias, pattern: manufacturerPrefixPattern(alias)! })),
).sort((a, b) => b.alias.length - a.alias.length);

/** A complete known brand at the start of a query; substrings such as Lumina stay free text. */
export function inferredSearchManufacturerId(value: unknown = ""): string {
  const query = stripManufacturerListingLabels(
    String(value).normalize("NFKC").replace(/\s+/gu, " "),
  );
  return SEARCH_PREFIXES.find(({ pattern }) => pattern.test(query))?.id ?? "";
}

/** Public snapshots carry a canonical id; legacy snapshots can still identify a full alias. */
export function matchesSearchManufacturer(
  expectedId: string,
  manufacturerId: string,
  manufacturer: string,
): boolean {
  if (manufacturerId === expectedId) return true;
  return [manufacturerId, manufacturer].some((value) => {
    const label = stripManufacturerListingLabels(value.normalize("NFKC").replace(/\s+/gu, " "));
    return SEARCH_PREFIXES.some(
      ({ id, pattern }) => id === expectedId && pattern.exec(label)?.[0].length === label.length,
    );
  });
}
