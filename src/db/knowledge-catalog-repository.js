import { categorySearchAliases, getCategory } from '../catalog/categories.js';
import { knowledgeCatalogKey } from '../catalog/knowledge-catalog.js';

const CHUNK_SIZE = 40;

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function parseCategoryIds(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function setUnambiguous(index, key, value) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, value);
    return;
  }
  const existing = index.get(key);
  if (!existing || existing.id !== value.id) index.set(key, null);
}

async function loadVerifiedCatalogIndex(db, manufacturerIds) {
  const ids = unique(manufacturerIds.map(value => String(value || '').trim().toLowerCase()));
  if (!ids.length) return new Map();

  const byId = new Map();
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(`
      SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model, kp.canonical_name,
             kpc.category_id, kpc.is_primary
      FROM knowledge_catalog_products kp
      LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
      WHERE kp.verification_status = 'verified'
        AND kp.manufacturer_id IN (${placeholders})
      ORDER BY kp.id, kpc.is_primary DESC, kpc.category_id
    `).bind(...chunk).all();

    for (const row of result.results || []) {
      let product = byId.get(row.id);
      if (!product) {
        product = {
          id: row.id,
          manufacturerId: row.manufacturer_id,
          canonicalModel: row.canonical_model,
          normalizedModel: row.normalized_model,
          canonicalName: row.canonical_name,
          categoryIds: []
        };
        byId.set(row.id, product);
      }
      if (row.category_id && !product.categoryIds.includes(row.category_id)) product.categoryIds.push(row.category_id);
    }
  }

  const aliasesByProduct = new Map();
  const productIds = [...byId.keys()];
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(`
      SELECT product_id, normalized_alias
      FROM knowledge_catalog_aliases
      WHERE alias_type = 'model' AND product_id IN (${placeholders})
    `).bind(...chunk).all();
    for (const row of result.results || []) {
      if (!aliasesByProduct.has(row.product_id)) aliasesByProduct.set(row.product_id, []);
      aliasesByProduct.get(row.product_id).push(row.normalized_alias);
    }
  }

  const index = new Map();
  for (const product of byId.values()) {
    if (!product.categoryIds.length) continue;
    setUnambiguous(index, knowledgeCatalogKey(product.manufacturerId, product.normalizedModel), {
      ...product,
      matchType: 'exact'
    });
    for (const alias of aliasesByProduct.get(product.id) || []) {
      setUnambiguous(index, knowledgeCatalogKey(product.manufacturerId, alias), {
        ...product,
        matchType: 'alias'
      });
    }
  }
  return index;
}

export async function findVerifiedCatalogMatches(db, products = []) {
  if (!db?.prepare) return new Map();
  const manufacturerIds = unique(products.map(product => product?.manufacturerId || product?.manufacturer_id));
  const index = await loadVerifiedCatalogIndex(db, manufacturerIds);
  const matches = new Map();
  for (const product of products) {
    const manufacturerId = product?.manufacturerId || product?.manufacturer_id;
    const model = product?.model || product?.normalizedModel || product?.normalized_model;
    const key = knowledgeCatalogKey(manufacturerId, model);
    const match = key ? index.get(key) : null;
    if (match) matches.set(key, match);
  }
  return matches;
}

async function runBatches(db, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

export async function reclassifyProductsFromKnowledgeCatalog(db) {
  const observed = await db.prepare(`
    SELECT id, manufacturer_id, model, category, primary_category_id, category_ids, classification_status
    FROM products
    WHERE is_active = 1 AND manufacturer_id <> '' AND model <> ''
  `).all();
  const products = observed.results || [];
  const matches = await findVerifiedCatalogMatches(db, products);
  const statements = [];
  let reclassifiedProducts = 0;

  for (const product of products) {
    const match = matches.get(knowledgeCatalogKey(product.manufacturer_id, product.model));
    if (!match) continue;
    const categoryIds = match.categoryIds.filter(categoryId => getCategory(categoryId)?.selectable);
    if (!categoryIds.length) continue;
    const primary = getCategory(categoryIds[0]);
    if (!primary) continue;
    const currentIds = parseCategoryIds(product.category_ids);
    const unchanged = product.classification_status === 'classified' &&
      product.primary_category_id === primary.id &&
      JSON.stringify(currentIds) === JSON.stringify(categoryIds) &&
      product.category === primary.name;
    if (unchanged) continue;

    statements.push(db.prepare(`
      UPDATE products
      SET category = ?, primary_category_id = ?, category_ids = ?, classification_status = 'classified', search_aliases = ?
      WHERE id = ?
    `).bind(primary.name, primary.id, JSON.stringify(categoryIds), categorySearchAliases(categoryIds), product.id));
    statements.push(db.prepare('DELETE FROM product_categories WHERE product_id = ?').bind(product.id));
    for (const categoryId of categoryIds) {
      statements.push(db.prepare(
        'INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (?, ?)'
      ).bind(product.id, categoryId));
    }
    reclassifiedProducts += 1;
  }

  await runBatches(db, statements);
  return reclassifiedProducts;
}
