import { isFeatureId } from "./types.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import { isAccessoryCategory } from "./sale-subject.js";
import type {
  FeatureFact,
  FeatureFactInput,
  FeatureId,
  InferFeatureFactsOptions,
  ResolvedFeatureState,
} from "./types.js";

/**
 * Ordered match table. The explicit tuple element type stops TypeScript widening each pair to
 * `(string | RegExp)[]`, which would erase the feature id when the table is destructured.
 */
const PRESENT_RULES: readonly (readonly [FeatureId, RegExp])[] = [
  [
    "dac",
    /\bdac\b|dac\s*(?:内蔵|搭載)|d\s*[/-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?/i,
  ],
  [
    "network_playback",
    /network\s+(?:player|transport|streaming)|streamer|streaming\s+(?:player|transport)|ネットワーク(?:再生|対応|プレーヤー|プレイヤー|トランスポート)/i,
  ],
  ["headphone_output", /headphone\s*(?:out|output|jack)|ヘッドホン(?:出力|端子)/i],
  ["phono_input", /phono\s*(?:in|input)|フォノ入力/i],
  [
    "recording",
    /\brecorder\b|\brecording\s+(?:function|capability|supported)\b|\bcan\s+record\b|レコーダー|録音(?:機能|可能|対応)|録再|録音機/i,
  ],
];

const FEATURE_TERMS: Readonly<Record<FeatureId, string>> = {
  dac: "(?:dac|d[/-]a\\s*converter)",
  network_playback: "(?:network\\s+(?:playback|streaming)|ネットワーク(?:再生|機能))",
  headphone_output: "(?:headphone\\s*(?:output|out|jack)|ヘッドホン(?:出力|端子))",
  phono_input: "(?:phono\\s*(?:input|in)|フォノ入力)",
  recording: "(?:recording|録音(?:機能)?)",
};

const ABSENT_RULES = new Map<FeatureId, RegExp>(
  Object.entries(FEATURE_TERMS).map(([id, term]) => [
    id as FeatureId,
    new RegExp(
      `(?:\\b(?:no|without)\\s+(?:an?\\s+)?${term}\\b|${term}\\s*(?:(?:is\\s+)?not\\s+(?:included|supported|available|built[ -]in)|非搭載|非対応|非内蔵|なし|無し|不可|機能なし))${id === "recording" ? "|playback[ -]only|再生専用" : ""}`,
      "gi",
    ),
  ]),
);

/** Contradictory listing evidence is unknown, not an assertion of absence. */
export function resolveFeatureState(
  facts: readonly FeatureFact[],
  featureId: FeatureId,
): ResolvedFeatureState {
  const states = new Set(
    facts.filter((fact) => fact.featureId === featureId).map((fact) => fact.state),
  );
  return states.size === 1 ? [...states][0] : "unknown";
}

export function inferFeatureFacts(
  text: string = "",
  { source = "title", confidence = 0.8, verifiedAt = null }: InferFeatureFactsOptions = {},
): FeatureFact[] {
  const value = String(text || "").normalize("NFKC");
  if (!value.trim()) return [];
  if (isAccessoryCategory(inferExplicitCategoryIds(value)[0] ?? "")) return [];
  const facts: FeatureFact[] = [];
  for (const [featureId, pattern] of PRESENT_RULES) {
    const negative = ABSENT_RULES.get(featureId)!;
    negative.lastIndex = 0;
    const absent = negative.test(value);
    negative.lastIndex = 0;
    const present = pattern.test(value.replace(negative, " "));
    if (absent === present) continue;
    facts.push({ featureId, state: absent ? "absent" : "present", source, confidence, verifiedAt });
  }
  return facts;
}

export function normalizeFeatureFacts(facts: FeatureFactInput[] = []): FeatureFact[] {
  const byKey = new Map<string, FeatureFact>();
  for (const fact of facts) {
    if (!isFeatureId(fact?.featureId)) continue;
    if (fact.state !== "present" && fact.state !== "absent") continue;
    const source = String(fact.source || "unknown");
    const key = `${fact.featureId}:${source}`;
    byKey.set(key, {
      featureId: fact.featureId,
      state: fact.state,
      source,
      confidence: Math.max(0, Math.min(1, Number(fact.confidence) || 0)),
      verifiedAt: fact.verifiedAt || null,
    });
  }
  return [...byKey.values()];
}
