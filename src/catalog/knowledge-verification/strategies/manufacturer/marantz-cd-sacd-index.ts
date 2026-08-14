/**
 * Verifies Marantz disc players from the manufacturer's own CD/SACD category index.
 *
 * Marantz disc players describe their USB-DAC input prominently enough that generic text
 * classification reads a model such as SACD 10 as a DAC. This index is manufacturer-owned and
 * category-specific, so once the model identity is confirmed on the page the page's own category is
 * authoritative and no further evidence is weighed.
 *
 * It carries its own source rather than a registry entry, so it runs before the registry's
 * supported-manufacturer check.
 */

import { catalogModelLookupVariants } from "../../../knowledge-catalog.js";
import { sha256Hex } from "../../http.js";
import { containsFlexibleCatalogModelIdentity } from "../../model-matching.js";
import type { VerificationStrategy } from "../../pipeline.js";
import type { KnowledgeSourceCandidate, KnowledgeSourceVerification } from "../../../types.js";

const MARANTZ_CD_SACD_INDEX = "https://www.marantz.com/ja-jp/category/cd-sacd-players/";

const MAX_INDEX_BYTES = 1_500_000;

/** Only aliases that name a disc-player line; other Marantz models must not read this index. */
const DISC_PLAYER_ALIAS = /^(?:SACD|CD)(?:\s|\d)/i;

function candidateModel(candidate: KnowledgeSourceCandidate = {}): string {
  return String(
    candidate.observedModel ||
      candidate.model ||
      candidate.canonicalModel ||
      candidate.normalizedModel ||
      "",
  ).trim();
}

export interface MarantzCdSacdIndexStrategyOptions {
  fetchImpl: typeof fetch;
}

export function createMarantzCdSacdIndexStrategy({
  fetchImpl,
}: MarantzCdSacdIndexStrategyOptions): VerificationStrategy {
  return {
    name: "marantz_cd_sacd_index",
    async verify(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification | null> {
      const manufacturerId = String(candidate?.manufacturerId || "")
        .trim()
        .toLowerCase();
      if (manufacturerId !== "marantz" || typeof fetchImpl !== "function") return null;

      const originalModel = candidateModel(candidate);
      if (!originalModel) return null;
      const aliases = catalogModelLookupVariants({ manufacturerId, model: originalModel }).filter(
        (alias) => DISC_PLAYER_ALIAS.test(alias),
      );
      if (!aliases.length) return null;

      try {
        const response = await fetchImpl(MARANTZ_CD_SACD_INDEX, {
          redirect: "follow",
          headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        });
        if (!response?.ok) return null;
        const html = (await response.text()).slice(0, MAX_INDEX_BYTES);
        const matchedAlias = aliases.find((alias) =>
          containsFlexibleCatalogModelIdentity(html, alias),
        );
        if (!matchedAlias) return null;

        return {
          status: "verified",
          sourceUrl: response.url || MARANTZ_CD_SACD_INDEX,
          sourceType: "manufacturer_official",
          httpStatus: response.status || 200,
          canonicalModel: originalModel,
          canonicalName: `Marantz ${matchedAlias}`,
          categoryIds: ["cd_sacd_player"],
          primaryCategoryId: "cd_sacd_player",
          contentHash: await sha256Hex(html),
          message: "verified_from_marantz_cd_sacd_index_v5",
        };
      } catch {
        // A failure here is not evidence about the model, so the remaining strategies still run.
        return null;
      }
    },
  };
}
