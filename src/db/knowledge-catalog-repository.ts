import { categorySearchAliases, getCategory } from "../catalog/categories.js";
import { catalogModelLookupVariants, knowledgeCatalogKey } from "../catalog/knowledge-catalog.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import type {
  CatalogMatchIndexEntry,
  ProductRow,
  QueryableDatabase,
  ReadableDatabase,
} from "./types.js";

const CHUNK_SIZE = 40;
const PRODUCT_PAGE_SIZE = 500;
const CATEGORY_PROJECTION_TOKEN_PREFIX = "category:";

interface CatalogIndexProduct extends Omit<CatalogMatchIndexEntry, "matchType"> {
  hasPrimaryCategory: boolean;
}

interface CatalogProductCategoryJoin {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  category_id: string | null;
  is_primary: number | null;
}

interface CatalogAliasProjection {
  product_id: number;
  normalized_alias: string;
}

interface CatalogLookupProduct {
  manufacturerId?: string;
  manufacturer_id?: string;
  model?: string;
  normalizedModel?: string;
  normalized_model?: string;
  modelResolutionStatus?: string;
  model_resolution_status?: string;
}

type ReclassificationProductRow = Pick<
  ProductRow,
  | "id"
  | "shop_key"
  | "source_id"
  | "manufacturer_id"
  | "model"
  | "model_resolution_status"
  | "category"
  | "primary_category_id"
  | "category_ids"
  | "classification_status"
  | "remediation_projection_required"
  | "remediation_projection_token"
> & {
  identity_status: string | null;
  identity_catalog_product_id: number | null;
};

interface ReclassificationRefreshTarget {
  id: number;
  shop_key: string;
  source_id: string;
  projectionToken: string;
}

interface ReclassificationPage {
  statements: D1PreparedStatement[];
  reclassifiedProducts: number;
  refreshTargets: ReclassificationRefreshTarget[];
}

export interface KnowledgeCatalogReclassificationDependencies {
  /** Test seam for deterministic downstream failure injection. */
  refreshListings?: typeof refreshListingProjections;
}

function unique(values: readonly unknown[] = []): string[] {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function parseCategoryIds(value: string | readonly string[] | null): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => Boolean(item));
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function pendingCategoryProjectionToken(product: ReclassificationProductRow): string | null {
  if (Number(product.remediation_projection_required) !== 1) return null;
  const token = String(product.remediation_projection_token || "");
  return token.startsWith(CATEGORY_PROJECTION_TOKEN_PREFIX) ? token : null;
}

function setUnambiguous(
  index: Map<string, CatalogMatchIndexEntry | null>,
  key: string,
  value: CatalogMatchIndexEntry,
): void {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, value);
    return;
  }
  const existing = index.get(key);
  if (!existing || existing.id !== value.id) index.set(key, null);
}

async function loadVerifiedCatalogIndex(
  db: ReadableDatabase,
  manufacturerIds: readonly string[],
): Promise<Map<string, CatalogMatchIndexEntry | null>> {
  const ids = unique(
    manufacturerIds.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (!ids.length) return new Map<string, CatalogMatchIndexEntry | null>();

  const byId = new Map<number, CatalogIndexProduct>();
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
      SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model, kp.canonical_name,
             kpc.category_id, kpc.is_primary
      FROM knowledge_catalog_products kp
      LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
      WHERE kp.verification_status = 'verified'
        AND kp.manufacturer_id IN (${placeholders})
      ORDER BY kp.id, kpc.is_primary DESC, kpc.category_id
    `)
      .bind(...chunk)
      .all<CatalogProductCategoryJoin>();

    for (const row of result.results || []) {
      let product = byId.get(row.id);
      if (!product) {
        product = {
          id: row.id,
          manufacturerId: row.manufacturer_id,
          canonicalModel: row.canonical_model,
          normalizedModel: row.normalized_model,
          canonicalName: row.canonical_name,
          categoryIds: [],
          hasPrimaryCategory: false,
        };
        byId.set(row.id, product);
      }
      if (row.category_id && !product.categoryIds.includes(row.category_id))
        product.categoryIds.push(row.category_id);
      if (row.category_id && Number(row.is_primary) === 1) product.hasPrimaryCategory = true;
    }
  }

  const aliasesByProduct = new Map<number, string[]>();
  const productIds = [...byId.keys()];
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
      SELECT product_id, normalized_alias
      FROM knowledge_catalog_aliases
      WHERE alias_type = 'model' AND product_id IN (${placeholders})
    `)
      .bind(...chunk)
      .all<CatalogAliasProjection>();
    for (const row of result.results || []) {
      const aliases = aliasesByProduct.get(row.product_id) ?? [];
      aliases.push(row.normalized_alias);
      aliasesByProduct.set(row.product_id, aliases);
    }
  }

  const index = new Map<string, CatalogMatchIndexEntry | null>();
  for (const product of byId.values()) {
    if (!product.categoryIds.length || !product.hasPrimaryCategory) continue;
    const match = {
      id: product.id,
      manufacturerId: product.manufacturerId,
      canonicalModel: product.canonicalModel,
      normalizedModel: product.normalizedModel,
      canonicalName: product.canonicalName,
      categoryIds: product.categoryIds,
    };
    const exactKey = knowledgeCatalogKey(product.manufacturerId, product.normalizedModel);
    setUnambiguous(index, exactKey, {
      ...match,
      matchType: "exact",
    });

    // Generate the same conservative lookup aliases for verified catalog rows that are used during
    // official-source verification. This lets retailer presentation variants resolve to one catalog
    // entry without weakening the stored identity or requiring broad fuzzy matching.
    for (const alias of catalogModelLookupVariants({
      manufacturerId: product.manufacturerId,
      model: product.canonicalModel,
    })) {
      const aliasKey = knowledgeCatalogKey(product.manufacturerId, alias);
      if (!aliasKey || aliasKey === exactKey) continue;
      setUnambiguous(index, aliasKey, {
        ...match,
        matchType: "derived_alias",
      });
    }

    for (const alias of aliasesByProduct.get(product.id) || []) {
      setUnambiguous(index, knowledgeCatalogKey(product.manufacturerId, alias), {
        ...match,
        matchType: "alias",
      });
    }
  }
  return index;
}

export async function findVerifiedCatalogMatches(
  db: ReadableDatabase,
  products: readonly CatalogLookupProduct[] = [],
): Promise<Map<string, CatalogMatchIndexEntry>> {
  const manufacturerIds = unique(
    products.map((product) => product?.manufacturerId || product?.manufacturer_id),
  );
  const index = await loadVerifiedCatalogIndex(db, manufacturerIds);
  const matches = new Map<string, CatalogMatchIndexEntry>();
  for (const product of products) {
    // A Knowledge Catalog row is authoritative only after Model Resolution has produced a usable
    // identity input. Candidate/unresolved models must not borrow verified category evidence merely
    // because their presentation happens to equal a catalog spelling.
    const modelResolutionStatus =
      product?.modelResolutionStatus || product?.model_resolution_status || "";
    if (modelResolutionStatus && modelResolutionStatus !== "resolved") continue;

    const manufacturerId = product?.manufacturerId || product?.manufacturer_id;
    const model = product?.model || product?.normalizedModel || product?.normalized_model;
    const key = knowledgeCatalogKey(manufacturerId, model);
    if (!key) continue;

    let match = index.get(key) || null;
    let matchedKey = key;
    if (!match) {
      for (const alias of catalogModelLookupVariants({ manufacturerId, model })) {
        const aliasKey = knowledgeCatalogKey(manufacturerId, alias);
        const candidate = aliasKey ? index.get(aliasKey) : null;
        if (!candidate) continue;
        match = candidate;
        matchedKey = aliasKey;
        break;
      }
    }
    if (match) {
      matches.set(key, matchedKey === key ? match : { ...match, matchType: "derived_alias" });
    }
  }
  return matches;
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

function buildReclassificationStatements(
  db: QueryableDatabase,
  products: readonly ReclassificationProductRow[],
  matches: ReadonlyMap<string, CatalogMatchIndexEntry>,
): ReclassificationPage {
  const statements: D1PreparedStatement[] = [];
  const refreshTargets: ReclassificationRefreshTarget[] = [];
  let reclassifiedProducts = 0;

  for (const product of products) {
    const pendingProjectionToken = pendingCategoryProjectionToken(product);
    const match = matches.get(knowledgeCatalogKey(product.manufacturer_id, product.model));

    // A previous category write may already have committed before its Phase 4 refresh failed. That
    // durable token remains authoritative retry work even if the current catalog/identity lookup no
    // longer qualifies: the downstream projections must re-read the row's current truth once.
    if (pendingProjectionToken) {
      refreshTargets.push({
        id: Number(product.id),
        shop_key: product.shop_key,
        source_id: product.source_id,
        projectionToken: pendingProjectionToken,
      });
    }

    if (!match) continue;
    // Historical reclassification is allowed only when the existing conservative Product Identity
    // resolver has attached this listing to the same verified canonical product. Candidate catalog
    // IDs and unresolved identities never become category authority.
    if (
      product.identity_status !== "matched" ||
      product.identity_catalog_product_id === null ||
      Number(product.identity_catalog_product_id) !== Number(match.id)
    ) {
      continue;
    }

    const categoryIds = match.categoryIds.filter(
      (categoryId) => getCategory(categoryId)?.selectable,
    );
    if (!categoryIds.length) continue;
    const primary = getCategory(categoryIds[0]);
    if (!primary) continue;
    const currentIds = parseCategoryIds(product.category_ids);
    const unchanged =
      product.classification_status === "classified" &&
      product.primary_category_id === primary.id &&
      JSON.stringify(currentIds) === JSON.stringify(categoryIds) &&
      product.category === primary.name;
    if (unchanged) continue;

    const projectionToken = `${CATEGORY_PROJECTION_TOKEN_PREFIX}${crypto.randomUUID()}`;
    statements.push(
      db
        .prepare(`
      UPDATE products
      SET category = ?, primary_category_id = ?, category_ids = ?, direct_category_ids = ?,
          classification_status = 'classified',
          search_aliases = ?, remediation_projection_required = 1, remediation_projection_token = ?
      WHERE id = ?
    `)
        .bind(
          primary.name,
          primary.id,
          JSON.stringify(categoryIds),
          // The catalog answered for one product, so the listing is directly in that one category.
          JSON.stringify([primary.id]),
          categorySearchAliases(categoryIds),
          projectionToken,
          product.id,
        ),
    );
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(product.id),
    );
    for (const categoryId of categoryIds) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
          )
          .bind(product.id, categoryId, categoryId === primary.id ? 1 : 0),
      );
    }

    const existingTarget = refreshTargets.find((target) => target.id === Number(product.id));
    if (existingTarget) {
      existingTarget.projectionToken = projectionToken;
    } else {
      refreshTargets.push({
        id: Number(product.id),
        shop_key: product.shop_key,
        source_id: product.source_id,
        projectionToken,
      });
    }
    reclassifiedProducts += 1;
  }

  return { statements, reclassifiedProducts, refreshTargets };
}

export async function reclassifyProductsFromKnowledgeCatalog(
  db: QueryableDatabase,
  evaluatedAt = new Date().toISOString(),
  dependencies: KnowledgeCatalogReclassificationDependencies = {},
): Promise<number> {
  const refreshListings = dependencies.refreshListings || refreshListingProjections;
  let lastId = 0;
  let reclassifiedProducts = 0;

  for (;;) {
    const observed = await db
      .prepare(`
      SELECT p.id, p.shop_key, p.source_id,
             p.canonical_manufacturer_id AS manufacturer_id, p.model, p.model_resolution_status,
             p.category, p.primary_category_id, p.category_ids, p.classification_status,
             p.remediation_projection_required, p.remediation_projection_token,
             pir.status AS identity_status,
             pir.catalog_product_id AS identity_catalog_product_id
      FROM products p
      LEFT JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
      WHERE p.is_active = 1 AND p.canonical_manufacturer_id <> '' AND p.model <> '' AND p.id > ?
      ORDER BY p.id
      LIMIT ?
    `)
      .bind(lastId, PRODUCT_PAGE_SIZE)
      .all<ReclassificationProductRow>();
    const products = observed.results || [];
    if (!products.length) break;

    const matches = await findVerifiedCatalogMatches(db, products);
    const page = buildReclassificationStatements(db, products, matches);
    await runBatches(db, page.statements);
    if (page.refreshTargets.length) {
      // Category/search aliases are part of the product-level read model. The pending bit/token are
      // committed with the category write, and cleared only after the dependency-ordered refresh
      // succeeds. A thrown refresh therefore leaves durable work for the next invocation.
      await refreshListings(db, page.refreshTargets, evaluatedAt);
      const completed = page.refreshTargets.map((target) =>
        db
          .prepare(`
            UPDATE products
            SET remediation_projection_required = 0, remediation_projection_token = ''
            WHERE id = ? AND remediation_projection_token = ?
          `)
          .bind(target.id, target.projectionToken),
      );
      await runBatches(db, completed);
    }
    reclassifiedProducts += page.reclassifiedProducts;

    lastId = Number(products[products.length - 1].id);
    if (products.length < PRODUCT_PAGE_SIZE) break;
  }

  return reclassifiedProducts;
}
