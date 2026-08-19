import { categorySearchAliases, getCategory } from "../src/catalog/categories.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

const AUDIT_SOURCE = "manual://approved-category-audit/2026-08-19";
const CATEGORY_PROJECTION_TOKEN_PREFIX = "category:manual-audit:";

interface ManualCategoryTargetRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer_id: string;
  model: string;
  current_category_id: string;
  expected_category_id: string;
  catalog_product_id: number;
}

interface ManualCategoryMismatchRow extends ManualCategoryTargetRow {
  entity_id: number | null;
  entity_key: string | null;
  entity_category_id: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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
        kpc.category_id AS expected_category_id,
        kp.id AS catalog_product_id
      FROM products p
      JOIN knowledge_catalog_products kp
        ON kp.manufacturer_id = p.canonical_manufacturer_id
       AND kp.verification_status = 'verified'
      JOIN knowledge_catalog_sources s
        ON s.product_id = kp.id
       AND s.source_type = 'manual_verified'
       AND s.source_url = ?
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
    .bind(AUDIT_SOURCE)
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
       AND s.source_url = ?
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = kp.id AND kpc.is_primary = 1
      LEFT JOIN knowledge_catalog_aliases ka
        ON ka.product_id = kp.id AND ka.alias_type = 'model'
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1
        AND p.model_resolution_status <> 'resolved'
        AND (p.model = kp.canonical_model OR p.model = ka.alias)
        AND (
          p.primary_category_id <> kpc.category_id
          OR p.classification_status <> 'classified'
          OR e.id IS NULL
          OR e.primary_category_id <> kpc.category_id
        )
      ORDER BY p.id
    `)
    .bind(AUDIT_SOURCE)
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
          p.primary_category_id <> 'network_switch'
          OR e.id IS NULL
          OR e.primary_category_id <> 'network_switch'
        )
      ORDER BY p.id
    `)
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

  for (const target of targets) {
    const category = getCategory(target.expected_category_id);
    if (!category?.selectable) {
      throw new Error(
        `manual category target ${target.catalog_product_id} has non-selectable category ${target.expected_category_id}`,
      );
    }

    const projectionToken = `${CATEGORY_PROJECTION_TOKEN_PREFIX}${crypto.randomUUID()}`;
    tokens.set(target.id, projectionToken);
    refreshTargets.push({ id: target.id, shop_key: target.shop_key, source_id: target.source_id });
    statements.push(
      db
        .prepare(`
          UPDATE products
          SET category = ?, primary_category_id = ?, category_ids = ?,
              classification_status = 'classified', search_aliases = ?,
              remediation_projection_required = 1, remediation_projection_token = ?
          WHERE id = ?
        `)
        .bind(
          category.name,
          category.id,
          JSON.stringify([category.id]),
          categorySearchAliases([category.id]),
          projectionToken,
          target.id,
        ),
    );
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(target.id),
    );
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (?, ?)")
        .bind(target.id, category.id),
    );
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
      targetCount: targets.length,
      changedCount: refreshTargets.length,
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
