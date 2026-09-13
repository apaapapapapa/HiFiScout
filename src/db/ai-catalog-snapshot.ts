import type { AiCatalogOption, AiCatalogSnapshot } from "../api/admin-ai-contracts.js";
import { parseAiSnapshot } from "../ai-suggestions/contract.js";
import { getCategory } from "../catalog/categories.js";
import {
  loadCatalogLookupCandidates,
  loadFuzzyCatalogCandidates,
} from "./catalog-lookup-candidates.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";

interface CandidateRow {
  id: number;
  manufacturer_id: string;
  observed_model: string;
  sample_title: string;
  raw_model_variants: string;
  candidate_category_ids: string;
  identity_rejection_reason: string;
  review_status: string;
  verification_status: string;
  last_verification_at: string | null;
  active_listing_count: number;
  manufacturer_verified: string;
}
function stringArray(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
  } catch {
    return null;
  }
}

/** Point lookup plus existing indexed discovery. No catalog or listing sweep is introduced. */
export async function loadAiCatalogSnapshot(
  db: QueryableDatabase,
  candidateId: number,
): Promise<AiCatalogSnapshot | null> {
  const target = await firstMeasured<CandidateRow>(
    db
      .prepare(`SELECT c.id,c.manufacturer_id,
    c.observed_model,c.sample_title,c.raw_model_variants,c.candidate_category_ids,
    c.identity_rejection_reason,c.review_status,c.verification_status,c.last_verification_at,
    c.active_listing_count,m.verification_status AS manufacturer_verified
    FROM knowledge_catalog_candidates c
    JOIN knowledge_catalog_manufacturers m ON m.id = c.manufacturer_id WHERE c.id = ?`)
      .bind(candidateId),
  );
  if (
    !target ||
    target.review_status !== "pending" ||
    target.active_listing_count < 1 ||
    target.manufacturer_verified !== "verified" ||
    !target.last_verification_at ||
    !["not_found", "ambiguous", "unsupported"].includes(target.verification_status)
  )
    return null;
  const rawModels = stringArray(target.raw_model_variants);
  const rawCategories = stringArray(target.candidate_category_ids);
  if (!rawModels || !rawCategories || rawModels.length > 4 || rawCategories.length > 4) return null;
  const categoryIds = rawCategories.filter((c) => c !== "unclassified");
  if (categoryIds.some((c) => !getCategory(c)?.classifiable)) return null;
  const input = { manufacturerId: target.manufacturer_id, model: target.observed_model };
  let found = await loadCatalogLookupCandidates(db, [input], "identity");
  if (!found.rows.length) found = await loadFuzzyCatalogCandidates(db, input);
  const candidates = new Map<number, AiCatalogOption>();
  for (const row of found.rows) {
    const option = candidates.get(row.id) || {
      id: row.id,
      manufacturerId: row.manufacturer_id,
      model: row.canonical_model,
      categoryIds: [],
      revision: "content-v1",
    };
    if (row.category_id) option.categoryIds.push(row.category_id);
    candidates.set(row.id, option);
  }
  // Do not truncate away alternatives: an overfull candidate set is not suitable for this canary.
  return parseAiSnapshot({
    kind: "catalog_model_lead",
    target: {
      candidateId,
      manufacturerId: target.manufacturer_id,
      model: target.observed_model,
      title: target.sample_title,
      rawModels: [...new Set(rawModels)].sort(),
      categoryIds: categoryIds.sort(),
      rejectedBy: target.identity_rejection_reason ? [target.identity_rejection_reason] : [],
      // Evidence itself is fingerprinted. Crawl last-seen/updated timestamps must not trigger new AI.
      revision: target.verification_status,
    },
    candidates: [...candidates.values()].map((c) => ({ ...c, categoryIds: c.categoryIds.sort() })),
  });
}
