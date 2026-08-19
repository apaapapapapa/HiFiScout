import {
  listManufacturerAliasEvidence,
  reprocessManufacturerAliasListings,
} from "../src/db/manufacturer-repository.js";
import {
  reprocessVerifiedCatalogProduct,
  type CatalogRemediationResult,
} from "../src/db/knowledge-catalog-remediation-repository.js";
import { reclassifyProductsFromKnowledgeCatalog } from "../src/db/knowledge-catalog-repository.js";
import type { ManufacturerAliasEvidence } from "../src/catalog/types.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

const AUDIT_SOURCE = "manual://approved-category-audit/2026-08-19";
const PAGE_LIMIT = 250;
const AUDITED_MANUFACTURERS = new Set([
  "ch-precision",
  "wattson-audio",
  "pathos",
  "telegartner",
  "sotm",
  "luxury-precision",
  "synergistic-research",
  "ediscreation",
]);

interface CatalogProductRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  category_id: string;
}

interface CategoryMismatchRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer: string;
  model: string;
  primary_category_id: string;
  expected_category_id: string;
  catalog_product_id: number;
}

interface ProjectionMismatchRow extends CategoryMismatchRow {
  entity_id: number;
  entity_key: string;
  entity_category_id: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function replayAlias(
  db: QueryableDatabase,
  alias: ManufacturerAliasEvidence,
  evaluatedAt: string,
): Promise<{ processedCount: number; changedCount: number }> {
  let afterId = 0;
  let processedCount = 0;
  let changedCount = 0;
  for (;;) {
    const replay = await reprocessManufacturerAliasListings(db, alias, {
      afterId,
      limit: PAGE_LIMIT,
      evaluatedAt,
    });
    processedCount += replay.processedCount;
    changedCount += replay.changedCount;
    if (!replay.hasMore || replay.nextAfterId === null) break;
    afterId = replay.nextAfterId;
  }
  return { processedCount, changedCount };
}

async function replayCatalogProduct(
  db: QueryableDatabase,
  product: CatalogProductRow,
  evaluatedAt: string,
): Promise<CatalogRemediationResult> {
  let afterId = 0;
  let processedCount = 0;
  let changedCount = 0;
  let matchedCount = 0;
  for (;;) {
    const result = await reprocessVerifiedCatalogProduct(db, product.id, {
      afterId,
      limit: PAGE_LIMIT,
      evaluatedAt,
    });
    if (!result.target || !result.replay) {
      throw new Error(`audit catalog product ${product.id} is no longer verified`);
    }
    processedCount += result.replay.processedCount;
    changedCount += result.replay.changedCount;
    matchedCount += result.replay.matchedCount;
    if (!result.replay.hasMore || result.replay.nextAfterId === null) {
      return {
        processedCount,
        changedCount,
        matchedCount,
        nextAfterId: null,
        hasMore: false,
      };
    }
    afterId = result.replay.nextAfterId;
  }
}

export async function applyApprovedCategoryAudit(db: QueryableDatabase): Promise<void> {
  const evaluatedAt = new Date().toISOString();
  const aliases = (await listManufacturerAliasEvidence(db)).filter(
    (alias) =>
      AUDITED_MANUFACTURERS.has(alias.manufacturerId) && alias.verificationStatus === "verified",
  );
  const aliasByManufacturer = new Map(aliases.map((alias) => [alias.manufacturerId, alias]));
  const missingAliases = [...AUDITED_MANUFACTURERS].filter((id) => !aliasByManufacturer.has(id));
  if (missingAliases.length) {
    throw new Error(`missing approved manufacturer aliases: ${missingAliases.join(", ")}`);
  }

  let manufacturerProcessed = 0;
  let manufacturerChanged = 0;
  for (const manufacturerId of AUDITED_MANUFACTURERS) {
    const alias = aliasByManufacturer.get(manufacturerId);
    if (!alias) continue;
    const replay = await replayAlias(db, alias, evaluatedAt);
    manufacturerProcessed += replay.processedCount;
    manufacturerChanged += replay.changedCount;
    console.log(
      JSON.stringify({
        event: "approved_category_audit_manufacturer_replay",
        manufacturerId,
        ...replay,
      }),
    );
  }

  const catalog = await db
    .prepare(`
      SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kpc.category_id
      FROM knowledge_catalog_products kp
      JOIN knowledge_catalog_sources s
        ON s.product_id = kp.id
       AND s.source_type = 'manual_verified'
       AND s.source_url = ?
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = kp.id AND kpc.is_primary = 1
      WHERE kp.verification_status = 'verified'
      ORDER BY kp.id
    `)
    .bind(AUDIT_SOURCE)
    .all<CatalogProductRow>();
  const products = catalog.results || [];
  if (!products.length) throw new Error("approved category audit catalog set is empty");

  let catalogProcessed = 0;
  let catalogMatched = 0;
  for (const product of products) {
    const replay = await replayCatalogProduct(db, product, evaluatedAt);
    catalogProcessed += replay.processedCount;
    catalogMatched += replay.matchedCount;
    if (replay.processedCount > 0 && replay.matchedCount !== replay.processedCount) {
      throw new Error(
        `catalog replay did not match every selected listing for ${product.manufacturer_id} ${product.canonical_model}: ${replay.matchedCount}/${replay.processedCount}`,
      );
    }
    console.log(
      JSON.stringify({
        event: "approved_category_audit_catalog_replay",
        catalogProductId: product.id,
        manufacturerId: product.manufacturer_id,
        model: product.canonical_model,
        expectedCategoryId: product.category_id,
        ...replay,
      }),
    );
  }

  const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(db, evaluatedAt);
  const mismatches = await db
    .prepare(`
      SELECT p.id, p.shop_key, p.source_id, p.manufacturer, p.model, p.primary_category_id,
             kpc.category_id AS expected_category_id, r.catalog_product_id
      FROM products p
      JOIN product_identity_resolutions r
        ON r.listing_product_id = p.id AND r.status = 'matched'
      JOIN knowledge_catalog_sources s
        ON s.product_id = r.catalog_product_id
       AND s.source_type = 'manual_verified'
       AND s.source_url = ?
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = r.catalog_product_id AND kpc.is_primary = 1
      WHERE p.is_active = 1
        AND (p.primary_category_id <> kpc.category_id OR p.classification_status <> 'classified')
      ORDER BY p.id
    `)
    .bind(AUDIT_SOURCE)
    .all<CategoryMismatchRow>();
  if ((mismatches.results || []).length) {
    throw new Error(
      `approved category audit mismatches remain: ${JSON.stringify(mismatches.results)}`,
    );
  }

  const projectionMismatches = await db
    .prepare(`
      SELECT p.id, p.shop_key, p.source_id, p.manufacturer, p.model, p.primary_category_id,
             kpc.category_id AS expected_category_id, r.catalog_product_id,
             e.id AS entity_id, e.entity_key, e.primary_category_id AS entity_category_id
      FROM products p
      JOIN product_identity_resolutions r
        ON r.listing_product_id = p.id AND r.status = 'matched'
      JOIN knowledge_catalog_sources s
        ON s.product_id = r.catalog_product_id
       AND s.source_type = 'manual_verified'
       AND s.source_url = ?
       AND s.status = 'active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id = r.catalog_product_id AND kpc.is_primary = 1
      JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1 AND e.primary_category_id <> kpc.category_id
      ORDER BY p.id
    `)
    .bind(AUDIT_SOURCE)
    .all<ProjectionMismatchRow>();
  if ((projectionMismatches.results || []).length) {
    throw new Error(
      `approved category audit search projection mismatches remain: ${JSON.stringify(projectionMismatches.results)}`,
    );
  }

  console.log(
    JSON.stringify({
      event: "approved_category_audit_complete",
      auditedCatalogProducts: products.length,
      manufacturerProcessed,
      manufacturerChanged,
      catalogProcessed,
      catalogMatched,
      reclassifiedProducts,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = createD1RestDatabase({
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnv("D1_DATABASE_ID"),
    apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  });
  await applyApprovedCategoryAudit(database);
}
