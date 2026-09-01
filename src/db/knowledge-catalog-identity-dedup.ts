/**
 * Converging Catalog rows that name one product.
 *
 * Fixing the writers stops new logical duplicates, but rows created before the identity rule
 * reached every writer are still in the catalog, and `UNIQUE(manufacturer_id, normalized_model)`
 * cannot remove them: each spelling is a legitimate value of that key. They are removed by merging
 * every member of a duplicate set onto the survivor the identity rule names.
 *
 * Detection is the admin duplicates query and the reference move is the admin merge, so an
 * automatic convergence can never disagree with what an operator is shown or move dependent rows
 * differently from a manual merge.
 */

import { mergeKnowledgeCatalogProductReferences } from "./knowledge-catalog-admin-operations.js";
import { listKnowledgeCatalogDuplicates } from "./knowledge-catalog-duplicate-repository.js";
import type { QueryableDatabase } from "./types.js";

/** Duplicate sets one convergence pass may merge. Bounded so a review run stays predictable. */
const DEFAULT_GROUP_LIMIT = 5;
const MAX_GROUP_LIMIT = 25;

export interface CatalogIdentityConvergenceOptions {
  /** Duplicate sets to converge in one pass. */
  limit?: number;
  mergedAt?: string;
}

export interface CatalogIdentityConvergenceResult {
  /** Duplicate sets collapsed onto one survivor. */
  convergedGroups: number;
  /** Catalog rows removed as duplicates of a survivor. */
  removedProducts: number;
  /**
   * Duplicate sets left for an admin because the survivor is not a complete Catalog record. A
   * verified promotion always writes a primary category, so this stays zero unless a row predates
   * that rule.
   */
  incompleteGroups: number;
  /** Whether logical duplicates remain after this pass. */
  hasMore: boolean;
}

function boundedGroupLimit(limit: number | undefined): number {
  const requested = Number(limit ?? DEFAULT_GROUP_LIMIT);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_GROUP_LIMIT;
  return Math.min(Math.trunc(requested), MAX_GROUP_LIMIT);
}

/**
 * Collapse the logical duplicate sets the duplicates screen reports onto their survivors.
 *
 * The survivor is the record that screen already suggests, which is a deterministic function of the
 * set rather than of row order, so repeating a pass never picks a different survivor. It is then
 * marked as owed a remediation replay: the review run drains that backlog in the same pass, which
 * is what re-resolves the moved listings and refreshes the search projections.
 *
 * Running this again on a converged catalog finds no duplicate sets and changes nothing, so a pass
 * that fails part way through simply repeats the remaining merges on the next one.
 */
export async function convergeKnowledgeCatalogIdentityDuplicates(
  db: QueryableDatabase,
  options: CatalogIdentityConvergenceOptions = {},
): Promise<CatalogIdentityConvergenceResult> {
  const limit = boundedGroupLimit(options.limit);
  const mergedAt = options.mergedAt || new Date().toISOString();
  const duplicates = await listKnowledgeCatalogDuplicates(db, {
    manufacturerId: "",
    afterKey: "",
    limit,
  });
  const result: CatalogIdentityConvergenceResult = {
    convergedGroups: 0,
    removedProducts: 0,
    incompleteGroups: 0,
    hasMore: duplicates.hasMore,
  };

  for (const group of duplicates.items) {
    const survivor = group.products.find((product) => product.id === group.suggestedTargetId);
    const duplicateProducts = group.products.filter(
      (product) => product.id !== group.suggestedTargetId,
    );
    if (!survivor || !duplicateProducts.length) continue;
    // Merging onto a record with no primary category would leave a verified Catalog product that
    // cannot classify anything. That is an admin decision, not an automatic one.
    if (!survivor.primaryCategoryId) {
      result.incompleteGroups += 1;
      result.hasMore = true;
      continue;
    }

    for (const duplicate of duplicateProducts) {
      await mergeKnowledgeCatalogProductReferences(
        db,
        survivor.id,
        {
          id: duplicate.id,
          canonicalModel: duplicate.canonicalModel,
          canonicalName: duplicate.canonicalName,
        },
        mergedAt,
      );
      result.removedProducts += 1;
    }
    // The survivor now owns listings it has never been replayed against. The review run drains the
    // remediation backlog right after this, so the replay happens in the same pass.
    await db
      .prepare(`
        UPDATE knowledge_catalog_products
        SET last_remediated_at = NULL, remediation_after_listing_id = 0, updated_at = ?
        WHERE id = ? AND verification_status = 'verified'
      `)
      .bind(mergedAt, survivor.id)
      .run();
    result.convergedGroups += 1;
  }

  return result;
}
