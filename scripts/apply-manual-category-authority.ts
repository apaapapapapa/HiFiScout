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
export const USER_CONFIRMED_SWITCH_CATEGORY_ID = "SIG.NETWORK" as const;

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
 * Other non-selectable values remain hard failures so malformed roots cannot be silently skipped.
 */
export function planManualCategoryAuthority(
  currentCategoryId: string,
  storedDirectCategoryIds: string,
  expectedCategoryId: string,
): ManualCategoryAuthorityPlan | null {
  if (expectedCategoryId === UNCLASSIFIED_CATEGORY_ID) return null;

  const category = getCategory(expectedCategoryId);
  if (!category?.selectable) {
    throw new Error(`manual category target has non-selectable category ${expectedCategoryId}`);
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

async function loadTargets(db: QueryableDatabase): Promise<ManualCategoryTargetRow[]> {
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
        kpc.category_id AS expected_category_id,
        kp.id AS catalog_product_id
      FROM products p
      JOIN knowledge_catalog_products kp
        ON kp.manufacturer_id = p.canonical_manufacturer_id
       AND kp.verification_status = 'verified'
      JOIN knowledge_catalog_sources s
        ON s.product_id = kp.id
       AND s.source_type = 'manual_verified'
       AND s.source_url IN (${AUDIT_SOURCE_PLACEHOLDERS})
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = kp.id AND kpc.is_primary = 1
      LEFT JOIN knowledge_catalog_aliases ka
        ON ka.product_id = kp.id AND ka.alias_type = 'model'
      WHERE p.is_active = 1
        AND p.model_resolution_status <> 'resolved'
        AND (p.model = kp.canonical_model OR p.model = ka.alias)
      ORDER BY p.id
    `)
    .bind(...AUDIT_SOURCES)
    .all<ManualCategoryTargetRow>();
  return result.results || [];
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
        kpc.category_id AS expected_category_id,
        kp.id AS catalog_product_id,
        e.id AS entity_id,
        e.entity_key,
        e.primary_category_id AS entity_category_id
      FROM products p
      JOIN knowledge_catalog_products kp
        ON kp.manufacturer_id = p.canonical_manufacturer_id
       AND kp.verification_status = 'verified'
      JOIN knowledge_catalog_sources s
        ON s.product_id = kp.id
       AND s.source_type = 'manual_verified'
       AND s.source_url IN (${AUDIT_SOURCE_PLACEHOLDERS})
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = kp.id AND kpc.is_primary = 1
      LEFT JOIN knowledge_catalog_aliases ka
        ON ka.product_id = kp.id AND ka.alias_type = 'model'
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1
        AND p.model_resolution_status <> 'resolved'
        AND kpc.category_id <> ?
        AND (p.model = kp.canonical_model OR p.model = ka.alias)
        AND (
          p.primary_category_id <> kpc.category_id
          OR p.classification_status <> 'classified'
          OR NOT EXISTS (
            SELECT 1 FROM json_each(p.direct_category_ids) direct
            WHERE direct.value = kpc.category_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM product_categories pc
            WHERE pc.product_id = p.id
              AND pc.category_id = kpc.category_id
              AND pc.is_direct = 1
          )
          OR e.id IS NULL
          OR e.primary_category_id <> kpc.category_id
        )
      ORDER BY p.id
    `)
    .bind(...AUDIT_SOURCES, UNCLASSIFIED_CATEGORY_ID)
    .all<ManualCategoryMismatchRow>();
  if ((result.results || []).length) {
    throw new Error(
      `manual category authority mismatches remain: ${JSON.stringify(result.results)}`,
    );
  }

  const switches = await db
    .prepare(`
      SELECT p.id, p.canonical_manufacturer_id, p.model, p.primary_category_id,
             e.entity_key, e.primary_category_id AS entity_category_id
      FROM products p
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1
        AND (
          (p.canonical_manufacturer_id = 'sotm' AND p.model LIKE 'sNH-10G%')
          OR (
            p.canonical_manufacturer_id = 'telegartner'
            AND p.model = 'M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本'
          )
        )
        AND (
          p.primary_category_id <> ?
          OR e.id IS NULL
          OR e.primary_category_id <> ?
        )
      ORDER BY p.id
    `)
    .bind(USER_CONFIRMED_SWITCH_CATEGORY_ID, USER_CONFIRMED_SWITCH_CATEGORY_ID)
    .all<ManualCategoryMismatchRow>();
  if ((switches.results || []).length) {
    throw new Error(
      `user-confirmed switching-hub classifications did not converge: ${JSON.stringify(switches.results)}`,
    );
  }
}

export async function applyManualCategoryAuthority(db: QueryableDatabase): Promise<number> {
  const evaluatedAt = new Date().toISOString();
  const targets = await loadTargets(db);
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
