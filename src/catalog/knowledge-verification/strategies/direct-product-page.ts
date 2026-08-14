/**
 * Verifies a model from a manufacturer's predictable per-product URL.
 *
 * Where a site derives its product URL from the model name, guessing it costs one request and
 * skips index crawling entirely. Only manufacturers whose URL scheme has been confirmed by hand
 * are listed — a wrong guess is harmless (the page 404s) but a broad guess wastes the candidate's
 * request budget.
 */

import { clean } from "../html.js";
import { verifyOfficialProductPage } from "../page-verification.js";
import { StrategyAttempts } from "../pipeline.js";
import { aliasCandidate, lookupAliases, verifiedForOriginalCandidate } from "./alias-lookup.js";
import type { VerificationStrategy } from "../pipeline.js";
import type {
  FetchTextResult,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
} from "../../types.js";

function directOfficialUrls(candidate: KnowledgeSourceCandidate, alias: string): string[] {
  const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
  const normalized = clean(alias).toLowerCase();
  if (!normalized) return [];
  if (manufacturerId === "accuphase") {
    return [`https://www.accuphase.com/model/${encodeURIComponent(normalized)}.html`];
  }
  if (manufacturerId === "luxman") {
    return [`https://www.luxman.co.jp/product/${encodeURIComponent(normalized)}/`];
  }
  if (manufacturerId === "esoteric") {
    // Esoteric's flagship line is branded "Grandioso K1" but filed under the bare model slug.
    const compact = normalized.replace(/^grandioso[-\s]*/i, "").replace(/[^a-z0-9]/g, "");
    const generic = normalized.replace(/[^a-z0-9]/g, "");
    return [
      ...new Set(
        [compact, generic]
          .filter(Boolean)
          .map((slug) => `https://www.esoteric.jp/jp/product/${slug}/top`),
      ),
    ];
  }
  return [];
}

export interface DirectProductPageStrategyOptions {
  fetchPage: (url: string) => Promise<FetchTextResult>;
}

export function createDirectProductPageStrategy({
  fetchPage,
}: DirectProductPageStrategyOptions): VerificationStrategy {
  return {
    name: "direct_product_page",
    async verify(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification | null> {
      const attempts = new StrategyAttempts();
      for (const alias of lookupAliases(candidate)) {
        for (const url of directOfficialUrls(candidate, alias)) {
          const page = await fetchPage(url);
          if (!page.ok) continue;
          const result = await verifyOfficialProductPage({
            candidate: aliasCandidate(candidate, alias),
            html: page.text,
            sourceUrl: page.url,
            sourceType: "manufacturer_official",
            httpStatus: page.status,
          });
          const verified = attempts.record(verifiedForOriginalCandidate(result, candidate));
          if (verified) return verified;
        }
      }
      return attempts.best();
    },
  };
}
