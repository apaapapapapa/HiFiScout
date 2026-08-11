import { categoryIdForFilter, categorySearchAliases } from '../catalog/categories.js';
import { manufacturerIdForFilter } from '../catalog/manufacturers.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const LOOKUP_CHUNK_SIZE = 50;

async function runBatches(db, statements, chunkSize = 50) {
  let changes = 0;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const results = await db.batch(statements.slice(i, i + chunkSize));
    for (const result of results || []) changes += Number(result?.meta?.changes || 0);
  }
  return changes;
}

function catalogFields(product) {
  const primaryCategoryId = product.primaryCategoryId || categoryIdForFilter(product.category) || 'other';
  const categoryIds = Array.isArray(product.categoryIds)
    ? [...new Set(product.categoryIds)]
    : [primaryCategoryId];
  return {
    rawManufacturer: product.rawManufacturer ?? product.manufacturer ?? '',
    manufacturerId: product.manufacturerId || manufacturerIdForFilter(product.manufacturer),
    rawCategory: product.rawCategory ?? product.category ?? '',
    primaryCategoryId,
    categoryIds,
    categoryIdsJson: JSON.stringify(categoryIds),
    classificationStatus: product.classificationStatus || (categoryIds.length ? 'classified' : 'unclassified'),
    searchAliases: product.searchAliases ?? categorySearchAliases(categoryIds)
  };
}

function existingCatalogFields(existing) {
  const primaryCategoryId = existing.primary_category_id || categoryIdForFilter(existing.category) || 'other';
  return {
    rawManufacturer: existing.raw_manufacturer ?? existing.manufacturer ?? '',
    manufacturerId: existing.manufacturer_id || manufacturerIdForFilter(existing.manufacturer),
    rawCategory: existing.raw_category ?? existing.category ?? '',
    primaryCategoryId,
    categoryIdsJson: existing.category_ids || JSON.stringify([primaryCategoryId]),
    classificationStatus: existing.classification_status || (primaryCategoryId === 'other' ? 'unclassified' : 'classified'),
    searchAliases: existing.search_aliases ?? categorySearchAliases([primaryCategoryId])
  };
}

function productRow(row) {
  if (!row) return row;
  let categoryIds = [];
  try {
    categoryIds = JSON.parse(row.category_ids || '[]');
  } catch {
    categoryIds = row.primary_category_id ? [row.primary_category_id] : [];
  }
  return { ...row, category_ids: categoryIds };
}

export async function selectProductsForHistory(db, shopKey, sourceIds, chunkSize = LOOKUP_CHUNK_SIZE) {
  const uniqueIds = [...new Set(sourceIds)];
  const rows = [];

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id, source_id, price_yen FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`
    ).bind(shopKey, ...chunk).all();
    rows.push(...(result.results || []));
  }

  return rows;
}

export async function selectExistingProducts(db, shopKey, sourceIds, chunkSize = LOOKUP_CHUNK_SIZE) {
  const uniqueIds = [...new Set(sourceIds)];
  const rows = [];

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id, source_id, manufacturer, raw_manufacturer, manufacturer_id, model, title,
              category, raw_category, primary_category_id, category_ids, classification_status, search_aliases,
              condition_text, price_yen, stock_status, source_url, metadata_json, last_seen_at, is_active
       FROM products
       WHERE shop_key = ? AND source_id IN (${placeholders})`
    ).bind(shopKey, ...chunk).all();
    rows.push(...(result.results || []));
  }

  return rows;
}

export async function selectActiveProductSourceIds(db, shopKey) {
  const result = await db.prepare(
    'SELECT source_id FROM products WHERE shop_key = ? AND is_active = 1'
  ).bind(shopKey).all();
  return (result.results || []).map(row => row.source_id);
}

export async function deactivateProductsBySourceIds(db, shopKey, sourceIds, chunkSize = LOOKUP_CHUNK_SIZE) {
  const uniqueIds = [...new Set(sourceIds)];
  const statements = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(db.prepare(
      `UPDATE products SET is_active = 0 WHERE shop_key = ? AND is_active = 1 AND source_id IN (${placeholders})`
    ).bind(shopKey, ...chunk));
  }
  return runBatches(db, statements, chunkSize);
}

function listingChanged(existing, product) {
  const current = catalogFields(product);
  const previous = existingCatalogFields(existing);
  return existing.manufacturer !== product.manufacturer ||
    previous.rawManufacturer !== current.rawManufacturer ||
    previous.manufacturerId !== current.manufacturerId ||
    existing.model !== product.model ||
    existing.title !== product.title ||
    existing.category !== product.category ||
    previous.rawCategory !== current.rawCategory ||
    previous.primaryCategoryId !== current.primaryCategoryId ||
    previous.categoryIdsJson !== current.categoryIdsJson ||
    previous.classificationStatus !== current.classificationStatus ||
    previous.searchAliases !== current.searchAliases ||
    existing.condition_text !== product.conditionText ||
    existing.price_yen !== product.priceYen ||
    existing.stock_status !== product.stockStatus ||
    existing.source_url !== product.sourceUrl ||
    Number(existing.is_active) !== 1;
}

function activityChanged(existing, product) {
  const current = catalogFields(product);
  const previous = existingCatalogFields(existing);

  // Only seller-observed listing changes should move an item back to the top of the
  // user-facing feed. Derived catalog normalization changes are persisted, but must
  // not create artificial "new" activity when classification rules are improved.
  return previous.rawManufacturer !== current.rawManufacturer ||
    existing.model !== product.model ||
    existing.title !== product.title ||
    previous.rawCategory !== current.rawCategory ||
    existing.condition_text !== product.conditionText ||
    existing.price_yen !== product.priceYen ||
    existing.stock_status !== product.stockStatus ||
    existing.source_url !== product.sourceUrl ||
    Number(existing.is_active) !== 1;
}

function categoriesChanged(existing, product) {
  const current = catalogFields(product);
  const previous = existingCatalogFields(existing);
  return previous.primaryCategoryId !== current.primaryCategoryId || previous.categoryIdsJson !== current.categoryIdsJson;
}

function shouldTouch(existing, observedAt, touchIntervalMinutes) {
  if (!existing.last_seen_at) return true;
  const observedMs = new Date(observedAt).getTime();
  const lastSeenMs = new Date(existing.last_seen_at).getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(lastSeenMs)) return true;
  return observedMs - lastSeenMs >= touchIntervalMinutes * 60_000;
}

async function syncProductCategories(db, shopKey, products, sourceIds) {
  if (!sourceIds.length) return;
  const wanted = new Set(sourceIds);
  const selected = products.filter(product => wanted.has(product.sourceId));
  const rows = [];

  for (let i = 0; i < sourceIds.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = sourceIds.slice(i, i + LOOKUP_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(
      `SELECT id, source_id FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`
    ).bind(shopKey, ...chunk).all();
    rows.push(...(result.results || []));
  }

  const idBySource = new Map(rows.map(row => [row.source_id, row.id]));
  const statements = [];
  for (const product of selected) {
    const productId = idBySource.get(product.sourceId);
    if (!productId) continue;
    const fields = catalogFields(product);
    statements.push(db.prepare('DELETE FROM product_categories WHERE product_id = ?').bind(productId));
    for (const categoryId of fields.categoryIds) {
      statements.push(
        db.prepare('INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (?, ?)')
          .bind(productId, categoryId)
      );
    }
  }
  await runBatches(db, statements);
}

export async function upsertProducts(
  db,
  shopKey,
  products,
  observedAt,
  { deactivateMissing = false, touchIntervalMinutes = 1440 } = {}
) {
  const existingRows = await selectExistingProducts(db, shopKey, products.map(product => product.sourceId));
  const existingBySource = new Map(existingRows.map(row => [row.source_id, row]));
  const observedSourceIds = new Set(products.map(product => product.sourceId));
  const missingSourceIds = deactivateMissing
    ? (await selectActiveProductSourceIds(db, shopKey)).filter(sourceId => !observedSourceIds.has(sourceId))
    : [];
  const newSourceIds = [];
  const changedPriceSourceIds = [];
  const categorySyncSourceIds = [];
  const writes = [];
  let changedCount = 0;
  let activityCount = 0;
  let touchedCount = 0;

  for (const product of products) {
    const fields = catalogFields(product);
    const existing = existingBySource.get(product.sourceId);
    if (!existing) {
      newSourceIds.push(product.sourceId);
      categorySyncSourceIds.push(product.sourceId);
      writes.push(db.prepare(`
        INSERT INTO products (
          shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id, model, title,
          category, raw_category, primary_category_id, category_ids, classification_status, search_aliases,
          condition_text, price_yen, previous_price_yen, stock_status, source_url,
          first_seen_at, last_seen_at, last_changed_at, last_activity_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)
      `).bind(
        shopKey, product.sourceId, product.manufacturer, fields.rawManufacturer, fields.manufacturerId,
        product.model, product.title, product.category, fields.rawCategory, fields.primaryCategoryId,
        fields.categoryIdsJson, fields.classificationStatus, fields.searchAliases, product.conditionText,
        product.priceYen, product.stockStatus, product.sourceUrl, observedAt, observedAt, observedAt, observedAt
      ));
      changedCount += 1;
      activityCount += 1;
      continue;
    }

    const priceChanged = existing.price_yen !== product.priceYen && product.priceYen != null;
    const changed = listingChanged(existing, product);
    const hasActivity = activityChanged(existing, product);
    if (priceChanged) changedPriceSourceIds.push(product.sourceId);
    if (categoriesChanged(existing, product)) categorySyncSourceIds.push(product.sourceId);

    if (changed) {
      writes.push(db.prepare(`
        UPDATE products SET
          manufacturer = ?, raw_manufacturer = ?, manufacturer_id = ?, model = ?, title = ?,
          category = ?, raw_category = ?, primary_category_id = ?, category_ids = ?,
          classification_status = ?, search_aliases = ?, condition_text = ?,
          previous_price_yen = CASE WHEN ? THEN price_yen ELSE previous_price_yen END,
          price_yen = ?, stock_status = ?, source_url = ?, last_seen_at = ?,
          last_changed_at = ?,
          last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END,
          is_active = 1
        WHERE id = ?
      `).bind(
        product.manufacturer, fields.rawManufacturer, fields.manufacturerId, product.model, product.title,
        product.category, fields.rawCategory, fields.primaryCategoryId, fields.categoryIdsJson,
        fields.classificationStatus, fields.searchAliases, product.conditionText,
        priceChanged ? 1 : 0, product.priceYen, product.stockStatus, product.sourceUrl, observedAt,
        observedAt, hasActivity ? 1 : 0, observedAt, existing.id
      ));
      changedCount += 1;
      if (hasActivity) activityCount += 1;
    } else if (shouldTouch(existing, observedAt, touchIntervalMinutes)) {
      writes.push(db.prepare('UPDATE products SET last_seen_at = ? WHERE id = ?').bind(observedAt, existing.id));
      touchedCount += 1;
    }
  }

  await runBatches(db, writes);
  await syncProductCategories(db, shopKey, products, [...new Set(categorySyncSourceIds)]);

  const historySourceIds = [...new Set([...newSourceIds, ...changedPriceSourceIds])];
  if (historySourceIds.length) {
    const rows = await selectProductsForHistory(db, shopKey, historySourceIds);
    const historyWrites = rows
      .filter(row => row.price_yen != null)
      .map(row => db.prepare('INSERT INTO price_history (product_id, price_yen, observed_at) VALUES (?, ?, ?)').bind(row.id, row.price_yen, observedAt));
    await runBatches(db, historyWrites);
  }

  const deactivatedCount = missingSourceIds.length
    ? await deactivateProductsBySourceIds(db, shopKey, missingSourceIds)
    : 0;

  return { changedCount, activityCount, touchedCount, deactivatedCount };
}

function encodeCursor(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.id) || typeof parsed.sort !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function ftsPhrase(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sortDefinition(sortKey) {
  return {
    newest: { key: 'newest', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' },
    oldest: { key: 'oldest', column: 'last_activity_at', direction: 'ASC', idDirection: 'ASC' },
    // Backward-compatible API alias. The UI exposes only the unified activity feed.
    updated: { key: 'updated', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' },
    priceAsc: { key: 'priceAsc', column: 'price_yen', direction: 'ASC', idDirection: 'ASC', price: true },
    priceDesc: { key: 'priceDesc', column: 'price_yen', direction: 'DESC', idDirection: 'DESC', price: true }
  }[sortKey] || { key: 'newest', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' };
}

function addCursorPredicate(where, binds, sort, cursor) {
  if (!cursor || cursor.sort !== sort.key) return;

  if (!sort.price) {
    if (typeof cursor.value !== 'string') return;
    const op = sort.direction === 'DESC' ? '<' : '>';
    const idOp = sort.idDirection === 'DESC' ? '<' : '>';
    where.push(`(p.${sort.column} ${op} ? OR (p.${sort.column} = ? AND p.id ${idOp} ?))`);
    binds.push(cursor.value, cursor.value, cursor.id);
    return;
  }

  const idOp = sort.idDirection === 'DESC' ? '<' : '>';
  if (cursor.isNull) {
    where.push(`(p.price_yen IS NULL AND p.id ${idOp} ?)`);
    binds.push(cursor.id);
    return;
  }
  if (typeof cursor.value !== 'number') return;

  const priceOp = sort.direction === 'DESC' ? '<' : '>';
  where.push(`(p.price_yen IS NULL OR p.price_yen ${priceOp} ? OR (p.price_yen = ? AND p.id ${idOp} ?))`);
  binds.push(cursor.value, cursor.value, cursor.id);
}

function cursorFor(row, sort) {
  return encodeCursor({
    sort: sort.key,
    id: row.id,
    value: row[sort.column],
    isNull: sort.price ? row.price_yen == null : false
  });
}

export function validateProductQuery(url) {
  const params = url.searchParams;
  const limits = { q: 100, shop: 80, manufacturer: 100, category: 100, cursor: 1024 };
  for (const [key, maxLength] of Object.entries(limits)) {
    const value = params.get(key);
    if (value != null && [...value].length > maxLength) return `${key}_too_long`;
  }
  for (const key of ['minPrice', 'maxPrice', 'limit', 'offset']) {
    const value = params.get(key);
    if (value != null && !/^\d{1,12}$/.test(value)) return `${key}_invalid`;
  }
  for (const key of ['inStock', 'newOnly', 'priceDropped', 'includeTotal']) {
    const value = params.get(key);
    if (value != null && value !== 'true' && value !== 'false') return `${key}_invalid`;
  }
  const sort = params.get('sort');
  if (sort && !['newest', 'oldest', 'updated', 'priceAsc', 'priceDesc'].includes(sort)) return 'sort_invalid';
  return null;
}

export async function listProducts(db, url) {
  const params = url.searchParams;
  const where = ['p.is_active = 1'];
  const binds = [];
  const q = params.get('q')?.trim();
  let join = '';
  if (q) {
    const terms = q.split(/\s+/u).filter(Boolean);
    if (terms.length === 1 && [...q].length >= 3) {
      join = 'JOIN products_fts ON products_fts.rowid = p.id';
      where.push('products_fts MATCH ?');
      binds.push(ftsPhrase(q));
    } else {
      for (const value of terms) {
        where.push(`(
          p.title LIKE ? OR p.manufacturer LIKE ? OR p.raw_manufacturer LIKE ? OR p.model LIKE ?
          OR p.category LIKE ? OR p.raw_category LIKE ? OR p.search_aliases LIKE ?
        )`);
        const term = `%${value}%`;
        binds.push(term, term, term, term, term, term, term);
      }
    }
  }

  const shop = params.get('shop')?.trim();
  if (shop) { where.push('p.shop_key = ?'); binds.push(shop); }

  const manufacturer = params.get('manufacturer')?.trim();
  if (manufacturer) {
    where.push('(p.manufacturer_id = ? OR p.manufacturer = ?)');
    binds.push(manufacturerIdForFilter(manufacturer), manufacturer);
  }

  const category = params.get('category')?.trim();
  if (category) {
    const categoryId = categoryIdForFilter(category);
    if (categoryId) {
      where.push('EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)');
      binds.push(categoryId);
    } else {
      where.push('p.category = ?');
      binds.push(category);
    }
  }

  if (params.get('inStock') === 'true') where.push("p.stock_status = 'in_stock'");
  if (params.get('newOnly') === 'true') {
    where.push("p.first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')");
  }
  if (params.get('priceDropped') === 'true') {
    where.push('(p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL AND p.price_yen < p.previous_price_yen)');
  }
  const minPrice = Number.parseInt(params.get('minPrice') || '', 10);
  if (Number.isFinite(minPrice)) { where.push('p.price_yen >= ?'); binds.push(minPrice); }
  const maxPrice = Number.parseInt(params.get('maxPrice') || '', 10);
  if (Number.isFinite(maxPrice)) { where.push('p.price_yen <= ?'); binds.push(maxPrice); }

  const countWhere = [...where];
  const countBinds = [...binds];
  const sort = sortDefinition(params.get('sort'));
  const cursor = decodeCursor(params.get('cursor'));
  addCursorPredicate(where, binds, sort, cursor);

  const requestedLimit = Number.parseInt(params.get('limit') || String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_SIZE));
  const requestedOffset = Number.parseInt(params.get('offset') || '0', 10);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const includeTotal = params.get('includeTotal') === 'true';
  const orderBy = sort.price
    ? `p.price_yen ${sort.direction} NULLS LAST, p.id ${sort.idDirection}`
    : `p.${sort.column} ${sort.direction}, p.id ${sort.idDirection}`;

  let totalCount = null;
  if (includeTotal) {
    const countResult = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM products p
      ${join}
      WHERE ${countWhere.join(' AND ')}
    `).bind(...countBinds).all();
    totalCount = Number(countResult.results?.[0]?.total || 0);
  }

  const paginationSql = offset > 0 ? 'LIMIT ? OFFSET ?' : 'LIMIT ?';
  const paginationBinds = offset > 0 ? [limit + 1, offset] : [limit + 1];
  const result = await db.prepare(`
    SELECT p.*
    FROM products p
    ${join}
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    ${paginationSql}
  `).bind(...binds, ...paginationBinds).all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(productRow);
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? cursorFor(last, sort) : null,
    ...(includeTotal ? { totalCount, totalPages: Math.ceil(totalCount / limit) } : {})
  };
}

export async function productHistory(db, id) {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!product) return null;
  const history = await db.prepare('SELECT price_yen, observed_at FROM price_history WHERE product_id = ? ORDER BY observed_at ASC').bind(id).all();
  return { product: productRow(product), history: history.results || [] };
}