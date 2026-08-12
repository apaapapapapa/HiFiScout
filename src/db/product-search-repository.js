import { categoryIdForFilter } from '../catalog/categories.js';
import { normalizeIdentityModel } from '../catalog/product-identity.js';
import { manufacturerIdForFilter, splitKnownManufacturerModel } from '../catalog/manufacturers.js';
import { parseFtsSearchQuery } from '../search/fts-query.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

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
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.id) || typeof parsed.sort !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sortDefinition(sortKey) {
  return (
    {
      newest: { key: 'newest', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' },
      oldest: { key: 'oldest', column: 'last_activity_at', direction: 'ASC', idDirection: 'ASC' },
      updated: { key: 'updated', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' },
      priceAsc: { key: 'priceAsc', column: 'price_yen', direction: 'ASC', idDirection: 'ASC', price: true },
      priceDesc: { key: 'priceDesc', column: 'price_yen', direction: 'DESC', idDirection: 'DESC', price: true },
    }[sortKey] || { key: 'newest', column: 'last_activity_at', direction: 'DESC', idDirection: 'DESC' }
  );
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
  where.push(
    `(p.price_yen IS NULL OR p.price_yen ${priceOp} ? OR (p.price_yen = ? AND p.id ${idOp} ?))`,
  );
  binds.push(cursor.value, cursor.value, cursor.id);
}

function cursorFor(row, sort) {
  return encodeCursor({
    sort: sort.key,
    id: row.id,
    value: row[sort.column],
    isNull: sort.price ? row.price_yen == null : false,
  });
}

function requestedFeatures(params) {
  return [
    ...new Set(
      params
        .getAll('feature')
        .flatMap(value => value.split(','))
        .map(value => value.trim())
        .filter(Boolean),
    ),
  ];
}

function addSearchPlan(q, where, binds) {
  if (!q) return { join: '', plan: null };
  const plan = parseFtsSearchQuery(q);
  let join = 'JOIN product_search_projection sp ON sp.product_id = p.id';
  if (plan.ftsQuery) {
    join += ' JOIN product_search_fts ON product_search_fts.rowid = sp.product_id';
    where.push('product_search_fts MATCH ?');
    binds.push(plan.ftsQuery);
  }
  for (const value of plan.shortTerms) {
    const term = `%${value}%`;
    where.push(`(
      sp.manufacturer_terms LIKE ? OR sp.normalized_model LIKE ? OR sp.model_terms LIKE ?
      OR sp.title LIKE ? OR sp.category_terms LIKE ?
    )`);
    binds.push(term, term, term, term, term);
  }
  return { join, plan };
}

function relevanceOrder(q, plan, rankBinds) {
  const known = splitKnownManufacturerModel(q);
  const queryModel = known?.model || q;
  const normalizedModel = normalizeIdentityModel(queryModel);
  const cases = [];
  if (known?.id && normalizedModel) {
    cases.push('WHEN sp.manufacturer_id = ? AND sp.normalized_model = ? THEN 0');
    rankBinds.push(known.id, normalizedModel);
  }
  if (normalizedModel) {
    cases.push('WHEN sp.normalized_model = ? THEN 1');
    rankBinds.push(normalizedModel);
  }
  cases.push('WHEN LOWER(sp.title) = LOWER(?) THEN 2');
  rankBinds.push(q);
  const caseSql = `CASE ${cases.join(' ')} ELSE 3 END ASC`;
  const ftsRank = plan?.ftsQuery
    ? ', bm25(product_search_fts, 8.0, 7.0, 6.0, 4.0, 1.0) ASC'
    : '';
  return `${caseSql}${ftsRank}, p.last_activity_at DESC, p.id DESC`;
}

export async function listProducts(db, url) {
  const startedAt = Date.now();
  const params = url.searchParams;
  const where = ['p.is_active = 1'];
  const binds = [];
  const q = params.get('q')?.trim() || '';
  const search = addSearchPlan(q, where, binds);

  const shop = params.get('shop')?.trim();
  if (shop) {
    where.push('p.shop_key = ?');
    binds.push(shop);
  }
  const manufacturer = params.get('manufacturer')?.trim();
  if (manufacturer) {
    where.push('(p.manufacturer_id = ? OR p.manufacturer = ?)');
    binds.push(manufacturerIdForFilter(manufacturer), manufacturer);
  }
  const category = params.get('category')?.trim();
  if (category) {
    const categoryId = categoryIdForFilter(category);
    if (categoryId) {
      where.push(
        'EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)',
      );
      binds.push(categoryId);
    } else {
      where.push('p.category = ?');
      binds.push(category);
    }
  }
  for (const feature of requestedFeatures(params)) {
    where.push(
      "EXISTS (SELECT 1 FROM product_feature_facts pff WHERE pff.product_id = p.id AND pff.feature_id = ? AND pff.state = 'present')",
    );
    binds.push(feature);
  }
  if (params.get('inStock') === 'true') where.push("p.stock_status = 'in_stock'");
  if (params.get('newOnly') === 'true') {
    where.push(
      "COALESCE(p.source_published_at, p.first_seen_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')",
    );
  }
  if (params.get('priceDropped') === 'true') {
    where.push(
      '(p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL AND p.price_yen < p.previous_price_yen)',
    );
  }
  const minPrice = Number.parseInt(params.get('minPrice') || '', 10);
  if (Number.isFinite(minPrice)) {
    where.push('p.price_yen >= ?');
    binds.push(minPrice);
  }
  const maxPrice = Number.parseInt(params.get('maxPrice') || '', 10);
  if (Number.isFinite(maxPrice)) {
    where.push('p.price_yen <= ?');
    binds.push(maxPrice);
  }

  const countWhere = [...where];
  const countBinds = [...binds];
  const explicitSort = params.has('sort');
  const relevance = Boolean(q && !explicitSort);
  const sort = sortDefinition(params.get('sort'));
  if (!relevance) addCursorPredicate(where, binds, sort, decodeCursor(params.get('cursor')));

  const requestedLimit = Number.parseInt(params.get('limit') || String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_SIZE),
  );
  const requestedOffset = Number.parseInt(params.get('offset') || '0', 10);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const includeTotal = params.get('includeTotal') === 'true';
  const rankBinds = [];
  const orderBy = relevance
    ? relevanceOrder(q, search.plan, rankBinds)
    : sort.price
      ? `p.price_yen ${sort.direction} NULLS LAST, p.id ${sort.idDirection}`
      : `p.${sort.column} ${sort.direction}, p.id ${sort.idDirection}`;

  let totalCount = null;
  if (includeTotal) {
    const countResult = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM products p ${search.join} WHERE ${countWhere.join(' AND ')}`,
      )
      .bind(...countBinds)
      .all();
    totalCount = Number(countResult.results?.[0]?.total || 0);
  }

  const paginationSql = offset > 0 ? 'LIMIT ? OFFSET ?' : 'LIMIT ?';
  const paginationBinds = offset > 0 ? [limit + 1, offset] : [limit + 1];
  const result = await db
    .prepare(
      `SELECT p.* FROM products p ${search.join} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} ${paginationSql}`,
    )
    .bind(...binds, ...rankBinds, ...paginationBinds)
    .all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(productRow);
  const last = items.at(-1);

  if (q) {
    console.log(
      JSON.stringify({
        event: 'product_search',
        search_latency_ms: Date.now() - startedAt,
        search_result_count: items.length,
        search_term_count: search.plan?.terms.length || 0,
        search_fts_term_count: search.plan?.ftsTerms.length || 0,
      }),
    );
  }

  return {
    items,
    hasMore,
    nextCursor: !relevance && hasMore && last ? cursorFor(last, sort) : null,
    ...(includeTotal ? { totalCount, totalPages: Math.ceil(totalCount / limit) } : {}),
  };
}
