import { loadAiJob } from "./ai-catalog-repository.js";
import { loadAiCatalogSnapshot } from "./ai-catalog-snapshot.js";
import { aiSnapshotFingerprint, validateAiSuggestion } from "../ai-suggestions/contract.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type { QueryableDatabase } from "./types.js";

/** Called by the existing manual Verify operation, never by inference or usefulness review. */
export async function assertAiCatalogVerification(
  db: QueryableDatabase,
  candidateId: number,
  input: {
    aiSuggestionId?: string;
    manufacturerId: string;
    canonicalModel: string;
    primaryCategoryId: string;
    sourceUrl: string;
  },
) {
  if (!input.aiSuggestionId || !/^[a-f0-9]{64}$/u.test(input.aiSuggestionId))
    throw new Error("catalog_admin_ai_review_required");
  const job = await loadAiJob(db, input.aiSuggestionId);
  if (
    !job ||
    job.candidate_id !== candidateId ||
    job.status !== "reviewed" ||
    job.review_outcome !== "useful" ||
    !job.result_json ||
    !input.sourceUrl.trim()
  )
    throw new Error("catalog_admin_ai_review_required");
  const current = await loadAiCatalogSnapshot(db, candidateId);
  if (!current || (await aiSnapshotFingerprint(current)) !== job.id)
    throw new Error("catalog_admin_ai_stale");
  const result = validateAiSuggestion(current, job.result_json);
  const selected = current.candidates.find((c) => c.id === result.catalogProductId);
  if (
    !selected ||
    selected.manufacturerId !== input.manufacturerId ||
    !selected.categoryIds.includes(input.primaryCategoryId) ||
    normalizeIdentityModel(selected.model) !== normalizeIdentityModel(input.canonicalModel)
  )
    throw new Error("catalog_admin_ai_selection_changed");
  return selected.id;
}
