import { legacyCategoryFacetSelections } from "./categories.js";
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
  ["connector_a", "xlr", /\bxlr\b|aes\s*\/\s*ebu|aes3/i],
  ["connector_b", "xlr", /\bxlr\b|aes\s*\/\s*ebu|aes3/i],
  ["connector_a", "rca", /\brca\b/i],
  ["connector_b", "rca", /\brca\b/i],
  ["connector_a", "usb", /\busb(?:-[abc])?\b/i],
  ["connector_b", "usb", /\busb(?:-[abc])?\b/i],
  ["connector_a", "ethernet", /\bethernet\b|\blan\b|rj-?45/i],
  ["connector_b", "ethernet", /\bethernet\b|\blan\b|rj-?45/i],
  ["connector_a", "hdmi", /\bhdmi\b/i],
  ["connector_b", "hdmi", /\bhdmi\b/i],
  ["connector_a", "optical", /\btoslink\b|optical\s+(?:digital|cable)|光デジタル/i],
  ["connector_b", "optical", /\btoslink\b|optical\s+(?:digital|cable)|光デジタル/i],
  ["connector_a", "coaxial", /\bcoax(?:ial)?\b|同軸(?:デジタル)?/i],
  ["connector_b", "coaxial", /\bcoax(?:ial)?\b|同軸(?:デジタル)?/i],
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
  ["technology", "transformer", /transformer|トランス/i],
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
  ["portability", "battery_powered", /battery[\s-]?powered|バッテリー駆動/i],
];

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
  const facts: FacetFactInput[] = [];
  if (value.trim()) {
    for (const [facetId, facetValue, pattern] of FACET_RULES) {
      if (pattern.test(value))
        facts.push({ facetId, value: facetValue, source, confidence, verifiedAt });
    }
  }
  for (const legacyCategoryId of legacyCategoryIds) {
    for (const facet of legacyCategoryFacetSelections(legacyCategoryId)) {
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
