import { OFFER_FACT_DEFINITIONS, OFFER_FACT_GROUPS } from "../src/api/contracts.js";
import type { OfferFact, OfferFactId } from "../src/api/contracts.js";

export function OfferFacts({ facts = [] }: { facts?: readonly OfferFact[] }) {
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  return (
    <details className="offer-facts">
      <summary>状態・付属品・保証・整備歴</summary>
      {OFFER_FACT_GROUPS.map((group) => {
        const definitions = OFFER_FACT_DEFINITIONS.filter(
          (definition) => definition.group === group.id,
        );
        const visible = definitions.filter(
          (definition) =>
            group.id === "included" || group.id === "warranty" || byId.has(definition.id),
        );
        return (
          <section key={group.id} className="offer-fact-group" aria-label={group.name}>
            <h3>{group.name}</h3>
            {visible.length ? (
              <dl>
                {visible.map((definition) => {
                  const fact = byId.get(definition.id);
                  return (
                    <div key={definition.id}>
                      <dt>{definition.name}</dt>
                      <dd>
                        {fact?.state === "present"
                          ? fact.warrantyMonths
                            ? `あり（${fact.warrantyMonths}か月）`
                            : "あり"
                          : fact?.state === "absent"
                            ? "なし（明記）"
                            : fact?.source === "manual"
                              ? "不明（確認済み）"
                              : "記載なし"}
                        {fact ? (
                          <small>
                            {fact.source === "manual"
                              ? "管理者確認"
                              : fact.source === "seller_detail"
                                ? "店舗詳細の記載"
                                : "店舗の記載"}{" "}
                            /{" "}
                            <time dateTime={fact.observedAt}>
                              {new Date(fact.observedAt).toLocaleDateString("ja-JP")}
                            </time>
                          </small>
                        ) : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p>記載なし</p>
            )}
          </section>
        );
      })}
    </details>
  );
}

export function OfferFactFilters({
  selected = [],
  disabled,
  onChange,
}: {
  selected?: readonly OfferFactId[];
  disabled: boolean;
  onChange: (fact: OfferFactId, checked: boolean) => void;
}) {
  return (
    <details className="advanced-filters" open={selected.length > 0 ? true : undefined}>
      <summary>状態・付属品・保証で絞り込む</summary>
      <fieldset className="filter-features" disabled={disabled}>
        <legend>出品の条件</legend>
        {OFFER_FACT_GROUPS.map((group) => (
          <fieldset className="offer-fact-filter-group" key={group.id}>
            <legend>{group.name}</legend>
            {OFFER_FACT_DEFINITIONS.filter((fact) => fact.group === group.id).map((fact) => (
              <label className="check" key={fact.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(fact.id)}
                  onChange={(event) => onChange(fact.id, event.currentTarget.checked)}
                />
                <span>{fact.name}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <p className="filter-note">
          同じ出品にすべての条件が明記されているものを検索します。記載なし・未整理の出品は含みません。
        </p>
        {disabled ? (
          <p className="filter-note">お気に入り表示中は出品条件で絞り込めません</p>
        ) : null}
      </fieldset>
    </details>
  );
}
