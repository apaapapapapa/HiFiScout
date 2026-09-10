import {
  UNCLASSIFIED_CATEGORY_ID,
  categorySearchAliases,
  getCategory,
} from "../src/catalog/categories.js";
import {
  directCategoryIds,
  listingMembershipCategoryIds,
} from "../src/catalog/listing-components.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

const AUDIT_SOURCES = [
  "manual://approved-category-audit/2026-08-19",
  "manual://approved-product-audit/2026-08-21",
] as const;
const AUDIT_SOURCE_PLACEHOLDERS = AUDIT_SOURCES.map(() => "?").join(",");
const CATEGORY_PROJECTION_TOKEN_PREFIX = "category:manual-audit:";
const LOOKUP_CHUNK_SIZE = 100;
export const USER_CONFIRMED_SWITCH_CATEGORY_ID = "SIG.NETWORK" as const;

interface ManualCategoryCatalogModelRow {
  catalog_product_id: number;
  manufacturer_id: string;
  lookup_model: string;
  expected_category_id: string;
}

interface ManualCategoryTargetRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer_id: string;
  model: string;
  current_category_id: string;
  direct_category_ids: string;
  expected_category_id: string;
  catalog_product_id: number;
}

interface ManualCategoryMismatchRow extends ManualCategoryTargetRow {
  entity_id: number | null;
  entity_key: string | null;
  entity_category_id: string | null;
}

export interface ManualCategoryAuthorityPlan {
  categoryId: string;
  categoryName: string;
  directCategoryIds: readonly string[];
  membershipCategoryIds: readonly string[];
  searchAliases: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseStoredDirectCategoryIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((categoryId): categoryId is string => typeof categoryId === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Plan one manual authority update without collapsing bundle membership.
 *
 * `unclassified` is taxonomy-v3's internal pending/failure sentinel, not a category a manual
 * authority job can authoritatively assign. Such catalog rows stay deferred for evidence review.
 * Taxonomy roots are filterable browse nodes but are not product types, so every other
 * non-classifiable value remains a hard failure rather than being silently assigned.
 */
export function planManualCategoryAuthority(
  currentCategoryId: string,
  storedDirectCategoryIds: string,
  expectedCategoryId: string,
): ManualCategoryAuthorityPlan | null {
  if (expectedCategoryId === UNCLASSIFIED_CATEGORY_ID) return null;

  const category = getCategory(expectedCategoryId);
  if (!category?.classifiable) {
    throw new Error(`manual category target has non-classifiable category ${expectedCategoryId}`);
  }

  const preserved = parseStoredDirectCategoryIds(storedDirectCategoryIds).filter(
    (categoryId) => categoryId !== currentCategoryId,
  );
  const nextDirectCategoryIds = directCategoryIds([...preserved, category.id]);
  const nextMembershipCategoryIds = listingMembershipCategoryIds(
    category.id,
    nextDirectCategoryIds,
  );

  return {
    categoryId: category.id,
    categoryName: category.name,
    directCategoryIds: nextDirectCategoryIds,
    membershipCategoryIds: nextMembershipCategoryIds,
    searchAliases: categorySearchAliases(nextDirectCategoryIds),
  };
}

async function loadCatalogModels(db: QueryableDatabase): Promise<ManualCategoryCatalogModelRow[]> {
  const result = await db
    .prepare(`
      WITH audited AS MATERIALIZED (
        SELECT DISTINCT
          kp.id AS catalog_product_id,
          kp.manufacturer_id,
          kp.canonical_model,
          kpc.category_id AS expected_category_id
        FROM knowledge_catalog_sources s INDEXED BY idx_knowledge_catalog_sources_manual_audit
        CROSS JOIN knowledge_catalog_products kp ON kp.id = s.product_id
        CROSS JOIN knowledge_catalog_product_categories kpc
          ON kpc.product_id = kp.id AND kpc.is_primary = 1
        WHERE s.source_type = 'manual_verified'
          AND s.source_url IN (${AUDIT_SOURCE_PLACEHOLDERS})
          AND s.status = 'active'
          AND kp.verification_status = 'verified'
      )
      SELECT catalog_product_id, manufacturer_id,
             canonical_model AS lookup_model, expected_category_id
      FROM audited
      UNION
      SELECT audited.catalog_product_id, audited.manufacturer_id,
             ka.alias AS lookup_model, audited.expected_category_id
      FROM audited
      CROSS JOIN knowledge_catalog_aliases ka
        ON ka.product_id = audited.catalog_product_id AND ka.alias_type = 'model'
      ORDER BY catalog_product_id, lookup_model
    `)
    .bind(...AUDIT_SOURCES)
    .all<ManualCategoryCatalogModelRow>();
  return result.results || [];
}

/** Resolve the bounded audited catalog set first, then seek listings by manufacturer. This keeps
 * the maintenance cost proportional to approved models instead of walking every active listing. */
export async function loadManualCategoryAuthorityTargets(
  db: QueryableDatabase,
): Promise<ManualCategoryTargetRow[]> {
  const catalogModels = await loadCatalogModels(db);
  const targets: ManualCategoryTargetRow[] = [];
  for (let i = 0; i < catalogModels.length; i += LOOKUP_CHUNK_SIZE) {
    const wanted = JSON.stringify(
      catalogModels
        .slice(i, i + LOOKUP_CHUNK_SIZE)
        .map((row) => [
          row.catalog_product_id,
          row.manufacturer_id,
          row.lookup_model,
          row.expected_category_id,
        ]),
    );
    const result = await db
      .prepare(`
        SELECT DISTINCT
          p.id,
          p.shop_key,
          p.source_id,
          p.canonical_manufacturer_id AS manufacturer_id,
          p.model,
          p.primary_category_id AS current_category_id,
          p.direct_category_ids,
          json_extract(wanted.value, '$[3]') AS expected_category_id,
          CAST(json_extract(wanted.value, '$[0]') AS INTEGER) AS catalog_product_id
        FROM json_each(?) wanted
        CROSS JOIN products p INDEXED BY idx_products_canonical_manufacturer
        WHERE p.canonical_manufacturer_id <> ''
          AND p.canonical_manufacturer_id = json_extract(wanted.value, '$[1]')
          AND p.is_active = 1
          AND p.model_resolution_status <> 'resolved'
          AND p.model = json_extract(wanted.value, '$[2]')
        ORDER BY p.id
      `)
      .bind(wanted)
      .all<ManualCategoryTargetRow>();
    targets.push(...(result.results || []));
  }
  return [
    ...new Map(
      targets.map((target) => [
        `${target.id}:${target.catalog_product_id}:${target.expected_category_id}`,
        target,
      ]),
    ).values(),
  ].sort((left, right) => left.id - right.id);
}

async function runBatches(
  db: QueryableDatabase,
  statements: D1PreparedStatement[],
  chunkSize = 50,
): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

async function verifyTargets(db: QueryableDatabase): Promise<void> {
  const targets = (await loadManualCategoryAuthorityTargets(db)).filter(
    (target) => target.expected_category_id !== UNCLASSIFIED_CATEGORY_ID,
  );
  const mismatches: ManualCategoryMismatchRow[] = [];
  for (let i = 0; i < targets.length; i += LOOKUP_CHUNK_SIZE) {
    const expected = JSON.stringify(
      targets
        .slice(i, i + LOOKUP_CHUNK_SIZE)
        .map((target) => [target.id, target.catalog_product_id, target.expected_category_id]),
    );
    const result = await db
      .prepare(`
        SELECT DISTINCT
          p.id,
          p.shop_key,
          p.source_id,
          p.canonical_manufacturer_id AS manufacturer_id,
          p.model,
          p.primary_category_id AS current_category_id,
          p.direct_category_ids,
          json_extract(expected.value, '$[2]') AS expected_category_id,
          CAST(json_extract(expected.value, '$[1]') AS INTEGER) AS catalog_product_id,
          e.id AS entity_id,
          e.entity_key,
          e.primary_category_id AS entity_category_id
        FROM json_each(?) expected
        CROSS JOIN products p ON p.id = CAST(json_extract(expected.value, '$[0]') AS INTEGER)
        LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
        LEFT JOIN product_search_entities e ON e.id = o.entity_id
        WHERE p.primary_category_id <> json_extract(expected.value, '$[2]')
          OR p.classification_status <> 'classified'
          OR NOT EXISTS (
            SELECT 1 FROM json_each(p.direct_category_ids) direct
            WHERE direct.value = json_extract(expected.value, '$[2]')
          )
          OR NOT EXISTS (
            SELECT 1 FROM product_categories pc
            WHERE pc.product_id = p.id
              AND pc.category_id = json_extract(expected.value, '$[2]')
              AND pc.is_direct = 1
          )
          OR e.id IS NULL
          OR e.primary_category_id <> json_extract(expected.value, '$[2]')
        ORDER BY p.id
      `)
      .bind(expected)
      .all<ManualCategoryMismatchRow>();
    mismatches.push(...(result.results || []));
  }
  if (mismatches.length) {
    throw new Error(`manual category authority mismatches remain: ${JSON.stringify(mismatches)}`);
  }

  const confirmedSwitches = JSON.stringify([
    ["sotm", "sNH-10G%", "prefix"],
    ["telegartner", "M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本", "exact"],
  ]);
  const switches = await db
    .prepare(`
      SELECT p.id, p.canonical_manufacturer_id, p.model, p.primary_category_id,
             e.entity_key, e.primary_category_id AS entity_category_id
      FROM json_each(?) wanted
      CROSS JOIN products p INDEXED BY idx_products_canonical_manufacturer
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.canonical_manufacturer_id <> ''
        AND p.canonical_manufacturer_id = json_extract(wanted.value, '$[0]')
        AND p.is_active = 1
        AND (
          (json_extract(wanted.value, '$[2]') = 'prefix'
            AND p.model LIKE json_extract(wanted.value, '$[1]'))
          OR (json_extract(wanted.value, '$[2]') = 'exact'
            AND p.model = json_extract(wanted.value, '$[1]'))
        )
        AND (
          p.primary_category_id <> ?
          OR e.id IS NULL
          OR e.primary_category_id <> ?
        )
      ORDER BY p.id
    `)
    .bind(confirmedSwitches, USER_CONFIRMED_SWITCH_CATEGORY_ID, USER_CONFIRMED_SWITCH_CATEGORY_ID)
    .all<ManualCategoryMismatchRow>();
  if ((switches.results || []).length) {
    throw new Error(
      `user-confirmed switching-hub classifications did not converge: ${JSON.stringify(switches.results)}`,
    );
  }
}

export async function applyManualCategoryAuthority(db: QueryableDatabase): Promise<number> {
  const evaluatedAt = new Date().toISOString();
  const targets = await loadManualCategoryAuthorityTargets(db);
  const statements: D1PreparedStatement[] = [];
  const tokens = new Map<number, string>();
  const refreshTargets: Array<{ id: number; shop_key: string; source_id: string }> = [];
  const deferredTargets: Array<{ catalogProductId: number; listingId: number }> = [];

  for (const target of targets) {
    const plan = planManualCategoryAuthority(
      target.current_category_id,
      target.direct_category_ids,
      target.expected_category_id,
    );
    if (!plan) {
      deferredTargets.push({ catalogProductId: target.catalog_product_id, listingId: target.id });
      continue;
    }

    const projectionToken = `${CATEGORY_PROJECTION_TOKEN_PREFIX}${crypto.randomUUID()}`;
    tokens.set(target.id, projectionToken);
    refreshTargets.push({ id: target.id, shop_key: target.shop_key, source_id: target.source_id });
    statements.push(
      db
        .prepare(`
          UPDATE products
          SET category = ?, primary_category_id = ?, category_ids = ?, direct_category_ids = ?,
              classification_status = 'classified', search_aliases = ?,
              remediation_projection_required = 1, remediation_projection_token = ?
          WHERE id = ?
        `)
        .bind(
          plan.categoryName,
          plan.categoryId,
          JSON.stringify([plan.categoryId]),
          JSON.stringify(plan.directCategoryIds),
          plan.searchAliases,
          projectionToken,
          target.id,
        ),
    );
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(target.id),
    );
    for (const membershipCategoryId of plan.membershipCategoryIds) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
          )
          .bind(
            target.id,
            membershipCategoryId,
            plan.directCategoryIds.includes(membershipCategoryId) ? 1 : 0,
          ),
      );
    }
  }

  await runBatches(db, statements);
  if (refreshTargets.length) {
    await refreshListingProjections(db, refreshTargets, evaluatedAt);
    const completed = refreshTargets.map((target) =>
      db
        .prepare(`
          UPDATE products
          SET remediation_projection_required = 0, remediation_projection_token = ''
          WHERE id = ? AND remediation_projection_token = ?
        `)
        .bind(target.id, tokens.get(target.id) || ""),
    );
    await runBatches(db, completed);
  }

  await verifyTargets(db);
  console.log(
    JSON.stringify({
      event: "manual_category_authority_complete",
      auditSources: AUDIT_SOURCES,
      targetCount: targets.length,
      changedCount: refreshTargets.length,
      deferredUnclassifiedCount: deferredTargets.length,
      deferredUnclassifiedTargets: deferredTargets,
    }),
  );
  return refreshTargets.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = createD1RestDatabase({
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnv("D1_DATABASE_ID"),
    apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  });
  await applyManualCategoryAuthority(database);
}
