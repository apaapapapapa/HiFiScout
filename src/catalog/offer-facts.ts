import { OFFER_FACT_DEFINITIONS } from "./types.js";
import type { OfferFact, OfferFactId } from "./types.js";

export const OFFER_FACT_RULE_VERSION = 1;

type Rule = readonly [OfferFactId, RegExp, RegExp?];
const RULES: Rule[] = [
  ["unused", /(?:未使用品|新品未使用|未開封品)/u],
  ["display", /(?:展示品|展示処分品|店頭展示機)/u],
  ["outlet", /アウトレット/u],
  ["used", /中古(?:品)?/u],
  ["junk", /ジャンク(?:品)?/u],
  ["operation_confirmed", /動作(?:確認済み?|確認済|チェック済み?|確認OK)/iu],
  ["operation_unchecked", /(?:動作未確認|動作未チェック|動作確認(?:は)?(?:していません|未実施))/u],
  ["shop_warranty", /(?:当店|店舗|販売店|ショップ)保証(?:付き|付|あり|有り|有|\s*[:：]\s*\d+\s*(?:年|ヶ月|か月|日))/u,
    /(?:当店|店舗|販売店|ショップ)保証(?:なし|無し|無|対象外|切れ)/u],
  ["manufacturer_warranty", /メーカー保証(?:付き|付|あり|有り|有|残あり)/u,
    /メーカー保証(?:なし|無し|無|対象外|切れ)/u],
  ["sale_pair", /(?:ペア販売|左右ペア|2本(?:1組|セット)|[（(【\s]ペア[）)】\s]|^ペア$)/u],
  ["sale_single", /(?:1本(?:のみ|販売)|1台(?:のみ|販売)|単体販売|単品販売|[（(【](?:1本|1台)[）)】])/u],
  ["sale_set", /(?:セット販売|2台セット)/u],
];

const INCLUDED: readonly (readonly [OfferFactId, string])[] = [
  ["original_box", "(?:元箱|オリジナル箱)"],
  ["remote_control", "リモコン"],
  ["manual", "(?:取扱説明書|取扱い説明書|説明書|取説)"],
];

for (const [id, term] of INCLUDED) {
  // Explicit qualifiers only: a model described as remote-compatible is not an included remote.
  RULES.push([
    id,
    new RegExp(`${term}\\s*(?:[:：]\\s*)?(?:付き|付属|付|あり|有り|有)(?!ません|無|なし|無し|しません|属なし|属しません)`, "u"),
    new RegExp(`(?:${term}\\s*(?:[:：]\\s*)?(?:なし|無し|無|欠品|欠損|付属なし|付属しません)|${term}は付属しません)`, "u"),
  ]);
}

/**
 * Bounded facts from fields already collected by every shop. No new fetches or seller prose
 * storage. Missing, hypothetical and contradictory statements remain unknown (no seller fact).
 */
export function inferOfferFacts(
  title: string,
  conditionText: string,
  observedAt: string,
): OfferFact[] {
  const fields = [
    ["title", title],
    ["condition_text", conditionText],
  ] as const;
  const facts: OfferFact[] = [];
  for (const [factId, positive, negative] of RULES) {
    const observations: { state: "present" | "absent"; field: "title" | "condition_text" }[] = [];
    for (const [field, raw] of fields) {
      const text = String(raw || "").slice(0, 4000).normalize("NFKC");
      // Refuse claims qualified as comparisons, exclusions, requests or uncertain descriptions.
      const clauses = text.split(/[。\n;；]/u).filter((clause) =>
        !/(?:同様|相当|ではありません|ではない|ではございません|不明|要確認|かもしれ|希望|別売)/u.test(clause),
      );
      for (const clause of clauses) {
        const absent = negative?.test(clause) ?? false;
        const present = positive.test(clause);
        if (absent) observations.push({ state: "absent", field });
        if (present) observations.push({ state: "present", field });
      }
    }
    const states = new Set(observations.map((observation) => observation.state));
    if (states.size !== 1) continue;
    const observation = observations.at(-1)!;
    facts.push({
      factId,
      state: observation.state,
      source: "seller",
      sourceField: observation.field,
      ruleId: `offer.v${OFFER_FACT_RULE_VERSION}.${factId}`,
      confidence: 1,
      observedAt,
    });
  }
  // Mutually inconsistent operation/unit claims are not resolved by arbitrary rule order.
  for (const group of [["operation_confirmed", "operation_unchecked"], ["sale_pair", "sale_single"]]) {
    if (group.every((id) => facts.some((fact) => fact.factId === id))) {
      for (let index = facts.length - 1; index >= 0; index--) {
        if (group.includes(facts[index].factId)) facts.splice(index, 1);
      }
    }
  }
  const order = new Map<string, number>(OFFER_FACT_DEFINITIONS.map((fact, index) => [fact.id, index]));
  return facts.sort((left, right) => order.get(left.factId)! - order.get(right.factId)!);
}
