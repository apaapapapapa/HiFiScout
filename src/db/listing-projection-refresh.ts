/**
 * The one dependency order every remediation replay must follow after a listing's canonical
 * fields change: search projection, then Product Identity, then the Phase 4 search entity and its
 * offer membership. Rebuilding the search entity first would immediately make it stale.
 */

import { syncProductIdentityResolutions } from "./product-identity-repository.js";
import { syncProductSearchEntities } from "./product-search-entity-repository.js";
import { syncProductSearchProjections } from "./product-search-projection-repository.js";
import type { QueryableDatabase } from "./types.js";
import {
  acknowledgeListingProjections,
  readListingProjectionTokens,
} from "./listing-projection-pending.js";

export interface ReplayedListing {
  /** Optional provenance identifier carried by admin/remediation callers; projection is source-scoped. */
  id?: number;
  shop_key: string;
  source_id: string;
}

type ProjectionStage = "search_projection" | "identity_resolution" | "search_entity";

async function runProjectionStage(
  stage: ProjectionStage,
  shopKey: string,
  listingCount: number,
  operation: () => Promise<unknown>,
): Promise<void> {
  const startedAt = Date.now();
  console.log(
    JSON.stringify({
      event: "data_quality_remediation_projection_stage_start",
      stage,
      shop_key: shopKey,
      listing_count: listingCount,
    }),
  );

  await operation();

  console.log(
    JSON.stringify({
      event: "data_quality_remediation_projection_stage_complete",
      stage,
      shop_key: shopKey,
      listing_count: listingCount,
      duration_ms: Date.now() - startedAt,
    }),
  );
}

/**
 * Keep search projection and search-entity aggregation batched by shop. Only the expensive
 * identity candidate lookup uses indexed manufacturer/model keys, so unrelated catalog entries
 * do not expand a small replay into a whole-manufacturer scan.
 */
export async function refreshListingProjections(
  db: QueryableDatabase,
  listings: readonly ReplayedListing[],
  evaluatedAt: string,
): Promise<void> {
  const byShop = new Map<string, Set<string>>();
  for (const listing of listings) {
    const sourceIds = byShop.get(listing.shop_key) || new Set<string>();
    sourceIds.add(listing.source_id);
    byShop.set(listing.shop_key, sourceIds);
  }

  for (const [shopKey, sourceIdSet] of byShop) {
    const sourceIds = [...sourceIdSet];
    const pending = await readListingProjectionTokens(db, shopKey, sourceIds);
    await runProjectionStage("search_projection", shopKey, sourceIds.length, () =>
      syncProductSearchProjections(db, shopKey, sourceIds),
    );
    await runProjectionStage("identity_resolution", shopKey, sourceIds.length, () =>
      syncProductIdentityResolutions(db, shopKey, sourceIds, evaluatedAt, {
        candidateManufacturerChunkSize: 1,
        traceCandidateScopes: true,
      }),
    );
    // Resolver replay is listing-scoped, and so is the sync: shop-wide inactive membership cleanup
    // belongs to the crawl's own bounded stage, where the observed inventory set is authoritative.
    await runProjectionStage("search_entity", shopKey, sourceIds.length, () =>
      syncProductSearchEntities(db, shopKey, sourceIds),
    );
    await acknowledgeListingProjections(db, pending);
  }
}
