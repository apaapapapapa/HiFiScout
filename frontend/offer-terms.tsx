import { offerTermGroups } from "../src/api/offer-terms-contracts.js";
import type { OfferFact } from "../src/api/contracts.js";

/** Conditions of this particular priced offer, never a model-wide specification. */
export function OfferTerms({ facts = [] }: { facts?: readonly OfferFact[] }) {
  return (
    <dl className="offer-terms" aria-label="この出品の販売単位・仕様">
      {offerTermGroups(facts).map((group) => (
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
