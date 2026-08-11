const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const LOOKUP_CHUNK_SIZE = 50;

async function runBatches(db, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
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
      `SELECT id, source_id, price_yen, stock_status, title
       FROM products
       WHERE shop_key = ? AND source_id IN (${placeholders})`
    ).bind(shopKey, ...chunk).all();
    rows.push(...(result.results || []));
  }

  return rows;
}

export async function deactivateProductsNotSeenInRun(db, shopKey, observedAt) {
  await db.prepare(`
    UPDATE products SET is_active = 0
    WHERE shop_key = ? AND is_active = 1 AND last_seen_at < ?
  `).bind(shopKey, observedAt).run();
}

export async function upsertProducts(db, shopKey, products, observedAt, { deactivateMissing = false } = {}) {
  const existingRows = await selectExistingProducts(db, shopKey, products.map(product => product.sourceId));
  const existingBySource = new Map(existingRows.map(row => [row.source_id, row]));
  const newSourceIds = [];
  const changedPriceSourceIds = [];
  const writes = [];
  let changedCount = 0;

  for (const product of products) {
    const existing = existingBySource.get(product.sourceId);
    if (!existing) {
      newSourceIds.push(product.sourceId);
      writes.push(db.prepare(`
        INSERT INTO products (
          shop_key, source_id, manufacturer, model, title, category, condition_text,
          price_yen, previous_price_yen, stock_status, source_url,
          first_seen_at, last_seen_at, last_changed_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1)
      `).bind(
        shopKey, product.sourceId, product.manufacturer, product.model, product.title,
        product.category, product.conditionText, product.priceYen, product.stockStatus,
        product.sourceUrl, observedAt, observedAt, observedAt
      ));
      changedCount += 1;
      continue;
    }

    const priceChanged = existing.price_yen !== product.priceYen && product.priceYen != null;
    const changed = existing.price_yen !== product.priceYen || existing.stock_status !== product.stockStatus || existing.title !== product.title;
    if (priceChanged) changedPriceSourceIds.push(product.sourceId);
    writes.push(db.prepare(`
      UPDATE products SET manufacturer = ?, model = ?, title = ?, category = ?, condition_text = ?,
        previous_price_yen = CASE WHEN ? THEN price_yen ELSE previous_price_yen END,
        price_yen = ?, stock_status = ?, source_url = ?, last_seen_at = ?,
        last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END, is_active = 1
      WHERE id = ?
    `).bind(
      product.manufacturer, product.model, product.title, product.category, product.conditionText,
      priceChanged ? 1 : 0, product.priceYen, product.stockStatus, product.sourceUrl, observedAt,
      changed ? 1 : 0, observedAt, existing.id
    ));
    if (changed) changedCount += 1;
  }

  await runBatches(db, writes);

  const historySourceIds = [...new Set([...newSourceIds, ...changedPriceSourceIds])];
  if (historySourceIds.length) {
    const rows = await selectProductsForHistory(db, shopKey, historySourceIds);
    const historyWrites = rows
      .filter(row => row.price_yen != null)
      .map(row => db.prepare('INSERT INTO price_history (product_id, price_yen, observed_at) VALUES (?, ?, ?)').bind(row.id, row.price_yen, observedAt));
    await runBatches(db, historyWrites);
  }

  if (deactivateMissing && products.length) {
    await deactivateProductsNotSeenInRun(db, shopKey, observedAt);
  }

  return { changedCount };
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
    newest: { key: 'newest', column: 'first_seen_at', direction: 'DESC', idDirection: 'DESC' },
    updated: { key: 'updated', column: 'last_changed_at', direction: 'DESC', idDirection: 'DESC' },
    priceAsc: { key: 'priceAsc', column: 'price_yen', direction: 'ASC', idDirection: 'ASC', price: true },
    priceDesc: { key: 'priceDesc', column: 'price_yen', direction: 'DESC', idDirection: 'DESC', price: true }
  }[sortKey] || { key: 'updated', column: 'last_changed_at', direction: 'DESC', idDirection: 'DESC' };
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

export async function listProducts(db, url) {
  const params = url.searchParams;
  const where = ['p.is_active = 1'];
  const binds = [];
  const q = params.get('q')?.trim();
  let join = '';
  if (q) {
    if ([...q].length >= 3) {
      join = 'JOIN products_fts ON products_fts.rowid = p.id';
      where.push('products_fts MATCH ?');
      binds.push(ftsPhrase(q));
    } else {
      where.push('(p.title LIKE ? OR p.manufacturer LIKE ? OR p.model LIKE ?)');
      const term = `%${q}%`;
      binds.push(term, term, term);
    }
  }
  for (const [key, column] of [['shop', 'shop_key'], ['manufacturer', 'manufacturer'], ['category', 'category']]) {
    const value = params.get(key)?.trim();
    if (value) { where.push(`p.${column} = ?`); binds.push(value); }
  }
  if (params.get('inStock') === 'true') where.push("p.stock_status = 'in_stock'");
  const minPrice = Number.parseInt(params.get('minPrice') || '', 10);
  if (Number.isFinite(minPrice)) { where.push('p.price_yen >= ?'); binds.push(minPrice); }
  const maxPrice = Number.parseInt(params.get('maxPrice') || '', 10);
  if (Number.isFinite(maxPrice)) { where.push('p.price_yen <= ?'); binds.push(maxPrice); }

  const sort = sortDefinition(params.get('sort'));
  const cursor = decodeCursor(params.get('cursor'));
  addCursorPredicate(where, binds, sort, cursor);

  const requestedLimit = Number.parseInt(params.get('limit') || String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_SIZE));
  const orderBy = sort.price
    ? `p.price_yen ${sort.direction} NULLS LAST, p.id ${sort.idDirection}`
    : `p.${sort.column} ${sort.direction}, p.id ${sort.idDirection}`;

  const result = await db.prepare(`
    SELECT p.*
    FROM products p
    ${join}
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?
  `).bind(...binds, limit + 1).all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? cursorFor(last, sort) : null
  };
}

export async function productHistory(db, id) {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!product) return null;
  const history = await db.prepare('SELECT price_yen, observed_at FROM price_history WHERE product_id = ? ORDER BY observed_at ASC').bind(id).all();
  return { product, history: history.results || [] };
}
