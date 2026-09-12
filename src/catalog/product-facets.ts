import { legacyCategoryFacetSelections } from "./categories.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import { saleSubjectText } from "./sale-subject.js";
import { reviewedNoiseAccessory } from "./reviewed-product-types.js";
import { isFacetId, isFacetValue } from "./types.js";
import type { FacetFact, FacetFactInput, FacetId, FacetSelection } from "./types.js";

export interface InferFacetFactsOptions {
  source?: string;
  confidence?: number;
  verifiedAt?: string | null;
  legacyCategoryIds?: readonly string[];
}

type FacetRule = readonly [FacetId, string, RegExp];

/** Independent rules: dual-mode products intentionally emit both wired and wireless facts. */
const FACET_RULES: readonly FacetRule[] = [
  [
    "connectivity",
    "wireless",
    /\bwireless\b|\bbluetooth\b|\bwi[\s-]?fi\b|ワイヤレス|無線|ブルートゥース|\bwf-\d|\bwh-\d{4}|\bwi-\d|\btour\s+pro\b|\bopen(?:fit|dots|run)\w*\b|\bairpods\b|\blinkbuds\b|\bfreebuds\b|quietcomfort|\bpx[78]\b|\bmomentum\s+\d+/i,
  ],
  [
    "connectivity",
    "wired",
    /\bwired\b|\b(?:usb|lan|ethernet|xlr|rca|hdmi|toslink)\b|有線|ケーブル接続|着脱式ケーブル/i,
  ],
  [
    "protocol",
    "bluetooth",
    /\bbluetooth\b|ブルートゥース|\bwf-\d|\bwh-\d{4}|\bwi-\d|\btour\s+pro\b|\bopen(?:fit|dots|run)\w*\b|\bairpods\b|\blinkbuds\b|\bfreebuds\b|quietcomfort|\bpx[78]\b|\bmomentum\s+\d+/i,
  ],
  ["protocol", "wifi", /\bwi[\s-]?fi\b|無線lan/i],
  ["protocol", "ethernet", /\bethernet\b|\blan\b|イーサネット|有線lan/i],
  ["form_factor", "bookshelf", /book[\s-]?shelf|stand[\s-]?mount|ブックシェルフ/i],
  ["form_factor", "floorstanding", /floor[\s-]?standing|tower\s+speaker|トールボーイ|フロア型/i],
  ["form_factor", "desktop", /\bdesktop\b|デスクトップ/i],
  ["form_factor", "one_box", /one[\s-]?box|一体型/i],
  ["channel_role", "center", /cent(?:er|re)(?:\s+channel)?|センター(?:・)?スピーカー/i],
  ["channel_role", "surround", /surround\s+speaker|サラウンドスピーカー/i],
  ["amplification_mode", "active", /\bactive\b|\bpowered\b|アクティブ|パワード/i],
  ["amplification_mode", "passive", /\bpassive\b|パッシブ/i],
  ["use_case", "studio", /\bstudio\b|スタジオ|レコーディング/i],
  ["use_case", "dj", /(?:^|\W)dj(?:\W|$)|ディージェイ/i],
  ["use_case", "pa", /\bpa\b|public\s+address|ライブサウンド|音響設備/i],
  ["use_case", "home", /\bhome\b|ホームオーディオ|家庭用/i],
  ["signal_type", "digital", /\bdigital\b|aes\s*\/\s*ebu|aes3|s\/?pdif|toslink|デジタル/i],
  ["signal_type", "data", /\b(?:usb|lan|ethernet)\b.*\bcable\b|(?:usb|lan|ネットワーク)ケーブル/i],
  ["signal_type", "speaker", /speaker\s+cable|スピーカーケーブル/i],
  ["signal_type", "power", /\b(?:ac|power|mains)\b.*(?:cable|cord)|電源(?:ケーブル|コード)/i],
  [
    "signal_type",
    "analog",
    /\banalog\b|\b(?:rca|phono)\b.*(?:cable|interconnect)|アナログ(?:ケーブル|インターコネクト)|フォノケーブル/i,
  ],
  [
    "network_device_type",
    "switch",
    /network\s+switch|ethernet\s+switch|switching\s+hub|ネットワークスイッチ|スイッチングハブ/i,
  ],
  ["network_device_type", "router", /audio\s+router|ネットワークルータ|オーディオルータ/i],
  ["network_device_type", "bridge", /digital\s+bridge|usb\s+bridge|デジタルブリッジ/i],
  ["technology", "tube", /vacuum\s+tube|tube\s+(?:amp|amplifier)|真空管/i],
  ["technology", "solid_state", /solid[\s-]?state|ソリッドステート/i],
  ["technology", "class_d", /class\s*d|d級/i],
  ["technology", "transformer", /\btransformer\b|トランス(?!ポート)/i],
  ["application", "phono", /\bphono\b|フォノ|トーンアーム/i],
  ["processor_type", "room_correction", /room\s+correction|音場補正|ルーム補正/i],
  ["processor_type", "equalizer", /(?<!phono\s)\bequalizer\b|(?<!フォノ)イコライザ/i],
  [
    "processor_type",
    "crossover",
    /\bcrossover\b|channel\s+divider|チャンネル(?:デバイダ|ディバイダ)/i,
  ],
  ["processor_type", "av", /\bav\b|audio\s+video|サラウンド/i],
  ["portability", "portable", /\bportable\b|ポータブル/i],
  ["portability", "stationary", /\bstationary\b|据[え]?置[き]?型/i],
  ["portability", "battery_powered", /battery[\s-]?powered|バッテリー駆動/i],
];

const MEDIA_RULES: readonly (readonly [string, RegExp])[] = [
  ["cd", /\bcd(?:-r)?\b/i],
  ["sacd", /\bsacd\b|super\s+audio\s+cd/i],
  ["dvd", /\bdvd\b/i],
  ["blu_ray", /blu[\s-]?ray|ブルーレイ/i],
  ["md", /\bmd\b|mini[\s-]?disc|ミニディスク/i],
  ["ld", /\bld\b|laser[\s-]?disc|レーザーディスク/i],
  ["cassette", /\bcassette\b|カセット/i],
  ["open_reel", /open[\s-]*reel|reel[\s-]to[\s-]reel|オープンリール/i],
  ["dat", /\bdat\b/i],
  ["dcc", /\bdcc\b/i],
];
const PART_RULES: readonly (readonly [string, RegExp])[] = [
  ["tweeter", /tweeter|ツ[イィ]ーター/i],
  ["horn", /\bhorn\b|ホーン/i],
  ["enclosure", /\benclosure\b|エンクロージャー/i],
  ["driver", /\bdriver\b|speaker\s+unit|(?:スピーカー|フルレンジ|ウーファー|ドライバー)ユニット/i],
  ["terminal", /\bterminal\b|ターミナル|端子/i],
  ["knob", /\bknob\b|ノブ/i],
  ["board", /\bboard\b|基板/i],
  ["remote", /\bremote\b|リモコン/i],
];
const TARGET_RULES: readonly (readonly [string, RegExp])[] = [
  ["speaker", /\bspeaker\b|スピーカー/i],
  ["headphone", /\bheadphone\b|ヘッドホン/i],
  ["earphone", /\b(?:earphone|iem)\b|イヤホン/i],
  ["amplifier", /\b(?:amp|amplifier)\b|アンプ/i],
  ["disc_player", /(?:cd|sacd|md|ld|dvd|disc)\s*(?:player|プレーヤー|デッキ)/i],
  ["turntable", /\bturntable\b|レコードプレーヤー|ターンテーブル/i],
  ["tape_deck", /(?:tape|cassette)\s+deck|テープデッキ|カセットデッキ/i],
];

/** Endpoints follow the order explicitly written by the seller, not a cartesian product. */
function cableEndpoints(value: string): string[] {
  const tokens =
    value.match(
      /usb[\s-]*(?:type[\s-]*)?[abc]\b|type[\s-]*[abc]\b|\b(?:xlr|rca|usb|ethernet|lan|rj-?45|hdmi|toslink|bnc|mmcx)\b|(?:2\.5|3\.5|4\.4|6\.3|6\.35)\s*mm|2[\s-]*pin|2ピン|バナナ|banana|Yラグ|spade|光デジタル|同軸/gi,
    ) ?? [];
  return tokens
    .map((token) => {
      const compact = token.toLowerCase().replace(/[\s-]/g, "");
      if (/^(?:usb(?:type)?|type)[abc]$/.test(compact)) return `usb_${compact.slice(-1)}`;
      if (/^(?:2\.5|3\.5|4\.4|6\.3)/.test(compact))
        return compact.slice(0, 3).replace(".", "_") + "mm";
      if (/^(?:lan|ethernet|rj45)$/.test(compact)) return "ethernet";
      if (/toslink|光デジタル/.test(compact)) return "optical";
      if (compact === "同軸") return "coaxial";
      if (/2pin|2ピン/.test(compact)) return "two_pin";
      if (/banana|バナナ/.test(compact)) return "banana";
      if (/spade|yラグ/.test(compact)) return "spade";
      return compact;
    })
    .filter((token, _index, all) => {
      // A generic USB/coaxial label is signal context when the actual shape is also named.
      if (token === "usb" && all.some((item) => item.startsWith("usb_"))) return false;
      return token !== "coaxial" || !all.some((item) => item === "rca" || item === "bnc");
    });
}

function confidenceValue(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function normalizeFacetFacts(facts: readonly FacetFactInput[] = []): FacetFact[] {
  const byKey = new Map<string, FacetFact>();
  for (const fact of facts) {
    if (!isFacetId(fact?.facetId) || !isFacetValue(fact.facetId, fact.value)) continue;
    const source = String(fact.source || "unknown");
    const key = `${fact.facetId}:${fact.value}:${source}`;
    byKey.set(key, {
      facetId: fact.facetId,
      value: String(fact.value),
      source,
      confidence: confidenceValue(fact.confidence),
      verifiedAt: fact.verifiedAt || null,
    });
  }
  return [...byKey.values()];
}

export function inferFacetFacts(
  text: string = "",
  {
    source = "title",
    confidence = 0.8,
    verifiedAt = null,
    legacyCategoryIds = [],
  }: InferFacetFactsOptions = {},
): FacetFact[] {
  const value = String(text || "").normalize("NFKC");
  const categoryId = inferExplicitCategoryIds(value)[0] ?? "";
  const subject = saleSubjectText(value);
  const facts: FacetFactInput[] = [];
  const add = (facetId: FacetId, facetValue: string) =>
    facts.push({ facetId, value: facetValue, source, confidence, verifiedAt });
  const endpoints = categoryId.startsWith("CAB.") ? cableEndpoints(subject) : [];
  if (value.trim()) {
    if (categoryId === "REC.MEDIA") {
      if (/オープンリール|\bopen[\s-]*reel|(?:7|10)\s*号.*リール|空リール/i.test(subject))
        add("recording_medium", "open_reel");
      if (/カセット|\bcassette\b/i.test(subject)) add("recording_medium", "cassette");
      const sizes = [...subject.matchAll(/(?<!\d)(7|10)\s*号/gi)];
      const uniqueSizes = [...new Set(sizes.map((match) => match[1]))];
      if (uniqueSizes.length === 1) add("reel_size", `size_${uniqueSizes[0]}`);
    }
    const reviewedNoise = reviewedNoiseAccessory(value);
    if (categoryId === "ACC.GROUND_NOISE" || (!categoryId && reviewedNoise)) {
      if (reviewedNoise) add("noise_accessory_type", reviewedNoise.kind);
      else if (/仮想アース|virtual\s+ground|grounding\s*(?:box|unit)/i.test(subject))
        add("noise_accessory_type", "grounding");
      else if (/usb.*(?:フィルタ|filter)/i.test(subject)) add("noise_accessory_type", "usb_filter");
      else if (/プラグ|\bplug\b/i.test(subject)) add("noise_accessory_type", "plug");
    }
    for (const [facetId, facetValue, pattern] of FACET_RULES) {
      if (facetId === "processor_type" && categoryId !== "PRC.PROCESSOR") continue;
      if (facetId === "signal_type" && !categoryId.startsWith("CAB.") && categoryId !== "PWR.CORD")
        continue;
      if (pattern.test(value))
        facts.push({ facetId, value: facetValue, source, confidence, verifiedAt });
    }
    if (categoryId.startsWith("PER.")) {
      if (/semi[\s-]?open|半開放|セミオープン/i.test(subject)) add("acoustic_design", "semi_open");
      else if (/open[\s-]?back|開放型|オープンバック/i.test(subject))
        add("acoustic_design", "open_back");
      else if (/closed[\s-]?back|密閉型|クローズドバック/i.test(subject))
        add("acoustic_design", "closed_back");
      for (const [form, pattern] of [
        ["true_wireless", /true[\s-]?wireless|\btws\b|完全ワイヤレス/i],
        ["over_ear", /over[\s-]?ear|オーバーイヤー/i],
        ["on_ear", /on[\s-]?ear|オンイヤー/i],
        ["in_ear", /in[\s-]?ear|カナル型/i],
        ["open_ear", /open[\s-]?ear|オープンイヤー/i],
      ] as const)
        if (pattern.test(subject)) add("form_factor", form);
    }
    const cartridgeFacet =
      categoryId === "ANA.CARTRIDGE"
        ? "cartridge_type"
        : categoryId.startsWith("AMP.") && /phono|フォノ/i.test(subject)
          ? "phono_support"
          : null;
    if (cartridgeFacet)
      for (const type of ["mm", "mc", "mi"] as const) {
        if (type === "mi" && cartridgeFacet === "phono_support") continue;
        if (
          new RegExp(
            `(?:\\b${type}\\b|${type}型)(?!\\s*(?:非対応|不可|なし|not\\s+supported))`,
            "i",
          ).test(subject)
        )
          add(cartridgeFacet, type);
      }
    if (
      categoryId.startsWith("SRC.") ||
      categoryId === "ANA.TAPE" ||
      categoryId === "REC.RECORDER"
    ) {
      for (const [media, pattern] of MEDIA_RULES)
        if (
          pattern.test(media === "cd" ? subject.replace(/super\s+audio\s+cd/gi, "SACD") : subject)
        )
          add("supported_media", media);
    }
    if (categoryId.startsWith("CAB.") || categoryId === "PWR.CORD") {
      // Ambiguous multi-ended cables are left unspecified rather than inventing two endpoints.
      if (endpoints.length <= 2)
        endpoints.forEach((endpoint, index) =>
          add(index === 0 ? "connector_a" : "connector_b", endpoint),
        );
      const lengths = [
        ...subject.matchAll(/(?<![\d.])([\d]+(?:\.[\d]+)?)\s*(cm|m|メートル)(?![a-z\d])/gi),
      ];
      if (lengths.length === 1) {
        const meters = Number(lengths[0][1]) / (lengths[0][2].toLowerCase() === "cm" ? 100 : 1);
        if (meters > 0)
          add(
            "cable_length",
            meters < 1
              ? "under_1m"
              : meters < 2
                ? "1_to_2m"
                : meters < 3
                  ? "2_to_3m"
                  : meters < 5
                    ? "3_to_5m"
                    : "5m_plus",
          );
      }
    }
    if (categoryId === "ACC.PART") {
      const part = PART_RULES.find(([, pattern]) => pattern.test(subject))?.[0];
      if (part) add("part_type", part);
      const targets = TARGET_RULES.filter(([, pattern]) => pattern.test(subject)).map(
        ([target]) => target,
      );
      if (part && ["driver", "tweeter", "horn", "enclosure"].includes(part))
        targets.push("speaker");
      for (const target of new Set(targets)) add("target_equipment", target);
    }
  }
  for (const legacyCategoryId of legacyCategoryIds) {
    for (const facet of legacyCategoryFacetSelections(legacyCategoryId)) {
      if (endpoints.length && (facet.facetId === "connector_a" || facet.facetId === "connector_b"))
        continue;
      facts.push({
        facetId: facet.facetId,
        value: facet.value,
        source: "legacy_category",
        confidence: 0.9,
        verifiedAt,
      });
    }
  }
  return normalizeFacetFacts(facts);
}

export function parseFacetSelection(value: string = ""): FacetSelection | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const facetId = value.slice(0, separator);
  const facetValue = value.slice(separator + 1);
  return isFacetId(facetId) && isFacetValue(facetId, facetValue)
    ? { facetId, value: facetValue }
    : null;
}

export function facetSelectionKey(value: FacetSelection): string {
  return `${value.facetId}:${value.value}`;
}
