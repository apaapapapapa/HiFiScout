import { OFFER_FACT_DEFINITIONS, OFFER_FACT_GROUPS } from "../catalog/types.js";
import type { OfferFact } from "../catalog/types.js";

/** Shared wording for browser details and directly opened server-rendered product links. */
export function offerTermGroups(facts: readonly OfferFact[] = []) {
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  return OFFER_FACT_GROUPS.filter((group) =>
    ["sale_unit", "voltage", "option"].includes(group.id),
  ).map((group) => {
    const definitions = OFFER_FACT_DEFINITIONS.filter((d) => d.group === group.id);
    const shown = definitions.filter((d) => {
      const fact = byId.get(d.id);
      return fact && (fact.state !== "unknown" || fact.source === "manual");
    });
    const conflict =
      ["sale_unit", "voltage"].includes(group.id) &&
      shown.filter((d) => d.id !== "voltage_switchable" && byId.get(d.id)?.state === "present")
        .length > 1;
    const values = shown.map((d) => {
      const fact = byId.get(d.id)!;
      const name = d.id === "sale_single" ? "単体（1台・1本）" : d.name;
      return `${name}${fact.state === "absent" ? "：なし（明記）" : fact.state === "unknown" ? "：不明" : ""}${fact.source === "manual" ? "（管理者確認）" : ""}`;
    });
    return {
      id: group.id,
      name: group.name,
      values: conflict
        ? ["不明（記載が競合・販売店で確認）"]
        : values.length
          ? values
          : ["記載なし"],
    };
  });
}
