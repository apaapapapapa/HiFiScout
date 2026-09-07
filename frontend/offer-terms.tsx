import { OFFER_FACT_DEFINITIONS, OFFER_FACT_GROUPS } from "../src/api/contracts.js";
import type { OfferFact } from "../src/api/contracts.js";

/** These are conditions of this particular priced offer, never a model-wide specification. */
export function OfferTerms({ facts = [] }: { facts?: readonly OfferFact[] }) {
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  return (
    <dl className="offer-terms" aria-label="この出品の販売単位・仕様">
      {OFFER_FACT_GROUPS.filter((group) =>
        ["sale_unit", "voltage", "option"].includes(group.id),
      ).map((group) => {
        const definitions = OFFER_FACT_DEFINITIONS.filter(
          (definition) => definition.group === group.id,
        );
        const known = definitions.filter((definition) => {
          const fact = byId.get(definition.id);
          return fact && fact.state !== "unknown";
        });
        const conflict =
          group.id === "sale_unit" &&
          known.filter((definition) => byId.get(definition.id)?.state === "present").length > 1;
        return (
          <div key={group.id}>
            <dt>{group.name}</dt>
            <dd>
              {conflict
                ? "複数の記載あり・販売店で確認"
                : known.length
                  ? known.map((definition) => {
                      const fact = byId.get(definition.id)!;
                      return (
                        <span key={definition.id}>
                          {definition.id === "sale_single" ? "単体（1台・1本）" : definition.name}
                          {fact.state === "absent" ? "：なし（明記）" : ""}
                          {fact.source === "manual" ? "（管理者確認）" : ""}
                        </span>
                      );
                    })
                  : definitions.some((definition) => byId.get(definition.id)?.source === "manual")
                    ? "不明（管理者確認）"
                    : "記載なし"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
