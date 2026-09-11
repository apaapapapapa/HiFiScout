import { offerTermGroups } from "../src/api/offer-terms-contracts.js";
import type { OfferFact } from "../src/api/contracts.js";

/** Conditions of this particular priced offer, never a model-wide specification. */
export function OfferTerms({
  facts = [],
  compact = false,
}: {
  facts?: readonly OfferFact[];
  compact?: boolean;
}) {
  const groups = offerTermGroups(facts).filter(
    (group) => !compact || group.values.some((value) => value !== "記載なし"),
  );
  if (!groups.length) return null;
  return (
    <dl className="offer-terms" aria-label="この出品の販売単位・仕様">
      {groups.map((group) => (
        <div key={group.id}>
          <dt>{group.name}</dt>
          <dd>
            {group.values.map((value) => (
              <span key={value}>{value}</span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
