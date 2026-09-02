/**
 * Change-driven repair for exact-identity search splits.
 *
 * The hourly full scan asks "which of the active listings is in a split identity group?", a question
 * no index can answer: the predicate joins `products` to itself on identity. Its cost is the size of
 * the catalog and is paid whether or not anything drifted. This walks the other way round -- from
 * the identities that actually changed, recorded by the triggers in migration 0074 -- so the cost is
 * the size of the change set.
 *
 * The dirty unit is the identity, which is what makes a group check here cheap enough to be worth
 * doing often: with the identity fixed, deriving the grouping the group *should* have becomes one
 * indexed lookup of its members, with no correlated subquery and no self-join. That also lets this
 * check be the stronger one -- the scan can only find groups that need merging, while a recorded
 * change just as often means a group needs taking apart. See {@link needsResync}.
 *
 * Claim semantics are built for a Worker that can be killed at any point:
 *
 *   * claiming stamps `claimed_at`, which is also the token the clearing delete must match. An
 *     identity re-dirtied mid-repair has its `claimed_at` cleared by the trigger, so the delete
 *     misses and the identity survives into the next pass rather than being dropped as clean.
 *   * a claim that is never cleared -- the isolate died between claim and repair -- is released
 *     again once it is older than the lease, so no identity can be stranded.
 *   * repairing is `syncProductSearchEntities`, which is idempotent, so a redelivered or retried
 *     repair converges on the same rows.
 */

import { syncProductSearchEntities } from "./product-search-entity-repository.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";
import { errorMessage } from "../types.js";

/** Categories that carry no evidence: the classifier's "no answer" and its former sentinel id. */
const UNSPECIFIC_CATEGORY_IDS = new Set(["other", "unclassified"]);

const DEFAULT_IDENTITY_LIMIT = 25;
const MAX_IDENTITY_LIMIT = 200;

/** How long a claimed identity may stay claimed before another pass may take it back. */
export const DIRTY_IDENTITY_LEASE_MS = 10 * 60 * 1000;

interface DirtyIdentityRow {
  canonical_manufacturer_id: string;
  normalized_model: string;
}

interface IdentityMemberRow {
  id: number;
  shop_key: string;
  source_id: string;
  primary_category_id: string | null;
  entity_key: string | null;
}

export interface ExactIdentityDirtyRepairOptions {
  /** Identities to claim in this pass. */
  limit?: number;
  now?: Date;
  /** Overrides {@link DIRTY_IDENTITY_LEASE_MS}; present for tests. */
  leaseMs?: number;
  /** Also report how many identities remain queued. Off by default: it is a table count. */
  countBacklog?: boolean;
}

export interface ExactIdentityDirtyRepairResult {
  claimedIdentities: number;
  /** Claimed identities whose membership disagreed with the derived grouping and were resynced. */
  repairedIdentities: number;
  /** Claimed identities that turned out to need no work -- the common case. */
  cleanIdentities: number;
  /** Claimed identities whose repair threw. Left claimed; the lease releases them. */
  failedIdentities: number;
  /** Claims released because they outlived the lease. */
  releasedStaleClaims: number;
  /** Identities still queued, or `null` when the caller did not ask to pay for the count. */
  backlog: number | null;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_IDENTITY_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_IDENTITY_LIMIT) {
    throw new Error(`Expected an integer in [1, ${MAX_IDENTITY_LIMIT}], got ${value}`);
  }
  return value;
}

/**
 * Returns claims to the queue once they outlive the lease.
 *
 * A claim is only ever cleared by a successful repair, so a Worker killed between claiming and
 * repairing would otherwise take its identities out of circulation permanently.
 */
async function releaseStaleClaims(db: QueryableDatabase, staleBefore: string): Promise<number> {
  const result = await db
    .prepare(`
      UPDATE product_search_exact_identity_dirty
      SET claimed_at = NULL
      WHERE claimed_at IS NOT NULL AND claimed_at < ?
    `)
    .bind(staleBefore)
    .run();
  return Number(result.meta?.changes || 0);
}

async function claimDirtyIdentities(
  db: QueryableDatabase,
  limit: number,
  claimedAt: string,
): Promise<DirtyIdentityRow[]> {
  const selected = await db
    .prepare(`
      SELECT canonical_manufacturer_id, normalized_model
      FROM product_search_exact_identity_dirty
      WHERE claimed_at IS NULL
      ORDER BY marked_at, canonical_manufacturer_id, normalized_model
      LIMIT ?
    `)
    .bind(limit)
    .all<DirtyIdentityRow>();
  const rows = selected.results || [];
  if (!rows.length) return [];

  // Claim in one statement rather than per row: the point of the pass is to stop paying per-row
  // costs, and a partial claim would leave the rest of the batch visible to a concurrent pass.
  const placeholders = rows.map(() => "(?, ?)").join(", ");
  const binds = rows.flatMap((row) => [row.canonical_manufacturer_id, row.normalized_model]);
  await db
    .prepare(`
      UPDATE product_search_exact_identity_dirty
      SET claimed_at = ?
      WHERE claimed_at IS NULL
        AND (canonical_manufacturer_id, normalized_model) IN (VALUES ${placeholders})
    `)
    .bind(claimedAt, ...binds)
    .run();
  return rows;
}

/**
 * The members of one identity group that are eligible for fallback grouping, with the search entity
 * each currently belongs to.
 *
 * This is the whole reason the dirty unit is the identity: with both identity columns bound, the
 * index added in 0074 answers the membership question directly. The eligibility predicate is the
 * same one `product-search-exact-identity.ts` expresses for the scan, minus the identity self-join
 * that only exists there to find the group in the first place.
 */
async function identityMembers(
  db: QueryableDatabase,
  manufacturerId: string,
  normalizedModel: string,
): Promise<IdentityMemberRow[]> {
  const result = await db
    .prepare(`
      SELECT p.id, p.shop_key, p.source_id, p.primary_category_id, e.entity_key
      FROM products p
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.canonical_manufacturer_id = ?
        AND p.normalized_model = ?
        AND p.is_active = 1
        AND p.model_resolution_status = 'resolved'
        AND NOT EXISTS (
          SELECT 1
          FROM product_identity_resolutions r
          JOIN knowledge_catalog_products kp
            ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
          WHERE r.listing_product_id = p.id AND r.status = 'matched'
        )
      ORDER BY p.id
    `)
    .bind(manufacturerId, normalizedModel)
    .all<IdentityMemberRow>();
  return result.results || [];
}

/**
 * Whether this group's current membership disagrees with the one grouping would derive.
 *
 * Asking only "is this group split across entities?" -- the shape of `EXACT_IDENTITY_SPLIT_COUNT_SQL`
 * and of the scan predicate -- covers merges and nothing else, while several of the transitions the
 * triggers record need the opposite. Two grouped listings that acquire conflicting specific
 * categories are no longer groupable but stay consolidated under one entity; a representative that
 * is deactivated leaves its peers pointing at an entity keyed for a listing that is no longer in the
 * group. Both are one entity, so a split test calls them clean -- and here that would delete the
 * only signal that they changed, because neither the coverage phase nor the split scan looks for a
 * membership that exists and is wrong.
 *
 * So compare against what `syncProductSearchEntities` would actually produce. `upsertFallbackOffers`
 * puts every listing in `l-<own id>` and `upsertExactIdentityGroupOffers` then moves the groupable
 * ones to `l-<representative>`, so the expected key is fully determined by the group:
 *
 *   * categories compatible -> every member belongs to `l-<lowest member id>`
 *   * categories in conflict -> every member belongs to its own `l-<id>`
 *
 * A member with no membership row at all is a coverage gap, which is the five-minute sweep's phase,
 * so it is not counted as drift here.
 */
function needsResync(members: readonly IdentityMemberRow[]): boolean {
  if (!members.length) return false;

  const specificCategories = new Set(
    members
      .map((member) => member.primary_category_id || "")
      .filter((categoryId) => categoryId && !UNSPECIFIC_CATEGORY_IDS.has(categoryId)),
  );
  const groupable = specificCategories.size <= 1;
  // Members arrive ordered by id, so the representative is the first of them.
  const representativeId = members[0]?.id;

  return members.some((member) => {
    if (member.entity_key === null || member.entity_key === undefined) return false;
    const expected = groupable ? `l-${representativeId}` : `l-${member.id}`;
    return member.entity_key !== expected;
  });
}

/**
 * Clears a claim this pass owns.
 *
 * Matching `claimed_at` is what makes the clear safe: a trigger that re-dirtied the identity while
 * the repair was running set it back to NULL, so this deletes nothing and the identity is repaired
 * again with the newer state.
 */
async function clearClaim(
  db: QueryableDatabase,
  identity: DirtyIdentityRow,
  claimedAt: string,
): Promise<void> {
  await db
    .prepare(`
      DELETE FROM product_search_exact_identity_dirty
      WHERE canonical_manufacturer_id = ?
        AND normalized_model = ?
        AND claimed_at = ?
    `)
    .bind(identity.canonical_manufacturer_id, identity.normalized_model, claimedAt)
    .run();
}

/**
 * Identities still waiting to be repaired.
 *
 * Exported because the hourly safety-net scan cannot interpret its own result without it: a repair
 * there means a trigger did not fire only when there was nothing left in the queue to explain it.
 */
export async function countDirtyExactIdentityBacklog(db: QueryableDatabase): Promise<number> {
  const row = await firstMeasured<{ backlog: number }>(
    db.prepare("SELECT COUNT(*) AS backlog FROM product_search_exact_identity_dirty"),
  );
  return Number(row?.backlog || 0);
}

/**
 * Repairs the identities recorded as changed since the last pass.
 *
 * Cheap enough to run on the ordinary five-minute tick: the claim is bounded, and each claimed
 * identity costs one indexed lookup of its own members plus, only when that lookup shows a genuine
 * split, one `syncProductSearchEntities` over the group.
 */
export async function repairDirtyExactIdentities(
  db: QueryableDatabase,
  {
    limit: requestedLimit,
    now = new Date(),
    leaseMs = DIRTY_IDENTITY_LEASE_MS,
    countBacklog = false,
  }: ExactIdentityDirtyRepairOptions = {},
): Promise<ExactIdentityDirtyRepairResult> {
  const limit = boundedLimit(requestedLimit);
  const claimedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - leaseMs).toISOString();

  const releasedStaleClaims = await releaseStaleClaims(db, staleBefore);
  const identities = await claimDirtyIdentities(db, limit, claimedAt);

  let repairedIdentities = 0;
  let cleanIdentities = 0;
  let failedIdentities = 0;

  for (const identity of identities) {
    try {
      const members = await identityMembers(
        db,
        identity.canonical_manufacturer_id,
        identity.normalized_model,
      );
      if (needsResync(members)) {
        // Every member is a seed, not just one. Entity sync does expand a seed to its exact-identity
        // peers, but that expansion applies `categoryCompatible` -- so in exactly the case that
        // needs the group taken apart, the members that must be separated are not peers any more and
        // would never be revisited. Seeding them all re-derives each membership directly. Grouped by
        // shop only because the incremental API is shop/source scoped, and run sequentially so a
        // repair never becomes a D1 burst.
        const sourceIdsByShop = new Map<string, string[]>();
        for (const member of members) {
          const sourceIds = sourceIdsByShop.get(member.shop_key) || [];
          sourceIds.push(member.source_id);
          sourceIdsByShop.set(member.shop_key, sourceIds);
        }
        for (const [shopKey, sourceIds] of sourceIdsByShop) {
          await syncProductSearchEntities(db, shopKey, sourceIds);
        }
        repairedIdentities += 1;
      } else {
        cleanIdentities += 1;
      }
      await clearClaim(db, identity, claimedAt);
    } catch (error) {
      // Leave the claim in place. The lease returns it to the queue, which is the same recovery path
      // an isolate death takes, so there is one behaviour to reason about rather than two.
      failedIdentities += 1;
      console.warn(
        JSON.stringify({
          event: "exact_identity_dirty_repair_failed",
          canonicalManufacturerId: identity.canonical_manufacturer_id,
          normalizedModel: identity.normalized_model,
          message: errorMessage(error),
        }),
      );
    }
  }

  return {
    claimedIdentities: identities.length,
    repairedIdentities,
    cleanIdentities,
    failedIdentities,
    releasedStaleClaims,
    backlog: countBacklog ? await countDirtyExactIdentityBacklog(db) : null,
  };
}
