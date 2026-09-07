import { isOfferFactId, OFFER_FACT_DEFINITIONS } from "./types.js";
import type { OfferFactId, OfferFactState } from "./types.js";
import { isRecord } from "../types.js";

export type OfferFactChanges = Partial<Record<OfferFactId, OfferFactState | "inherit">>;

export function parseOfferFactChanges(value: unknown): OfferFactChanges | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > OFFER_FACT_DEFINITIONS.length) return null;
  const result: OfferFactChanges = {};
  for (const [id, state] of entries) {
    if (!isOfferFactId(id)) return null;
    if (state !== "present" && state !== "absent" && state !== "unknown" && state !== "inherit")
      return null;
    result[id] = state;
  }
  return result;
}
