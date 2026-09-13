import { loadAiJob } from "./ai-catalog-repository.js";
import { loadAiCatalogSnapshot } from "./ai-catalog-snapshot.js";
import {
  aiSnapshotFingerprint,
  parseAiSnapshot,
  validateAiSuggestion,
} from "../ai-suggestions/contract.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type { QueryableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

export interface AiVerificationFence {
  productId: number;
  revision: number;
}

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
  const stored = parseAiSnapshot(JSON.parse(job.snapshot_json));
  if (!stored) throw new Error("catalog_admin_ai_stale");
  const manufacturer = stored.target.manufacturerId;
  // Register before reading any snapshot input. Relevant mutations now advance this clock.
  await db
    .prepare(`INSERT INTO ai_catalog_revisions(manufacturer_id,revision)
    SELECT ?,0 WHERE NOT EXISTS (SELECT 1 FROM ai_catalog_revisions WHERE manufacturer_id=?)`)
    .bind(manufacturer, manufacturer)
    .run();
  const clock = await firstMeasured<{ revision: number }>(
    db
      .prepare("SELECT revision FROM ai_catalog_revisions WHERE manufacturer_id=?")
      .bind(manufacturer),
  );
  if (!clock) throw new Error("catalog_admin_ai_stale");
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
  return { productId: selected.id, revision: clock.revision } satisfies AiVerificationFence;
}
