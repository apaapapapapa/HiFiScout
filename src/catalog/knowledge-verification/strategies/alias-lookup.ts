/**
 * Model names to look for when the listing's name is not the manufacturer's own.
 *
 * A used-audio listing writes a model the way the shop's staff typed it — with a retailer suffix,
 * a bundled-accessory note, or a spacing the manufacturer never used. Verification therefore
 * searches under several aliases and, on a match, reports the listing's model back rather than the
 * alias, so the catalog keeps the identity the rest of the system already stores.
 *
 * Shorter aliases are tried first: they are the closest to a bare model number and least likely to
 * miss because of a presentational difference.
 */

import { catalogModelLookupVariants } from "../../knowledge-catalog.js";
import { clean } from "../html.js";
import { candidateModelVariants } from "../model-matching.js";
import type { KnowledgeSourceCandidate, KnowledgeSourceVerification } from "../types.js";

export function lookupAliases(candidate: KnowledgeSourceCandidate = {}): string[] {
  const variants = new Set(candidateModelVariants(candidate));
  for (const model of [candidate.observedModel, candidate.model, candidate.normalizedModel]) {
    for (const alias of catalogModelLookupVariants({
      manufacturerId: candidate.manufacturerId,
      model,
    })) {
      variants.add(alias);
    }
  }
  return [...variants]
    .filter(Boolean)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
}

/** Presents one alias as the candidate's own model so page verification matches on it. */
export function aliasCandidate(
  candidate: KnowledgeSourceCandidate,
  alias: string,
): KnowledgeSourceCandidate {
  return {
    ...candidate,
    observedModel: alias,
    model: alias,
    normalizedModel: alias,
  };
}

/**
 * Restores the listing's own model on a result that was verified through an alias.
 *
 * The message suffix is persisted and read back by operational status, so it is kept verbatim.
 */
export function verifiedForOriginalCandidate(
  result: KnowledgeSourceVerification,
  candidate: KnowledgeSourceCandidate,
): KnowledgeSourceVerification {
  if (result?.status !== "verified") return result;
  return {
    ...result,
    canonicalModel: clean(candidate.observedModel || candidate.model || candidate.normalizedModel),
    message: `${result.message || "verified"}:lookup_alias_v3`,
  };
}
