async function runBatches(db, statements, chunkSize = 50) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

export async function selectProductsForHistory(db, shopKey, sourceIds, chunkSize = 50) {
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

export async function deactivateProductsNotSeenInRun(db, shopKey, observedAt) {
  // Every product observed in this completed crawl is written with exactly this timestamp.
  // Comparing timestamps avoids a potentially huge NOT IN (...) list and does not deactivate
  // rows written by a newer concurrent crawl.
  await db.prepare(`
    UPDATE products SET is_active = 0
    WHERE shop_key = ? AND is_active = 1 AND last_seen_at < ?
  `).bind(shopKey, observedAt).run();
}

export async function upsertProducts(db, shopKey, products, observedAt, { deactivateMissing = false } = {}) {
  const existingResult = await db.prepare(
    'SELECT id, source_id, price_yen, stock_status, title FROM products WHERE shop_key = ?'
  ).bind(shopKey).all();
  const existingBySource = new Map((existingResult.results || []).map(row => [row.source_id, row]));
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
          price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).bind(
        shopKey, product.sourceId, product.manufacturer, product.model, product.title,
        product.category, product.conditionText, product.priceYen, product.stockStatus,
        product.sourceUrl, observedAt, observedAt, observedAt
      ));
      changedCount += 1;
      continue;
    }

    const changed = existing.price_yen !== product.priceYen || existing.stock_status !== product.stockStatus || existing.title !== product.title;
    if (existing.price_yen !== product.priceYen && product.priceYen != null) changedPriceSourceIds.push(product.sourceId);
    writes.push(db.prepare(`
      UPDATE products SET manufacturer = ?, model = ?, title = ?, category = ?, condition_text = ?,
        price_yen = ?, stock_status = ?, source_url = ?, last_seen_at = ?,
        last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END, is_active = 1
      WHERE id = ?
    `).bind(
      product.manufacturer, product.model, product.title, product.category, product.conditionText,
      product.priceYen, product.stockStatus, product.sourceUrl, observedAt,
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

export async function listProducts(db, url) {
  const params = url.searchParams;
  const where = ['is_active = 1'];
  const binds = [];
  const q = params.get('q')?.trim();
  if (q) {
    where.push('(title LIKE ? OR manufacturer LIKE ? OR model LIKE ?)');
    const term = `%${q}%`;
    binds.push(term, term, term);
  }
  for (const [key, column] of [['shop', 'shop_key'], ['manufacturer', 'manufacturer'], ['category', 'category']]) {
    const value = params.get(key)?.trim();
    if (value) { where.push(`${column} = ?`); binds.push(value); }
  }
  if (params.get('inStock') === 'true') where.push("stock_status = 'in_stock'");
  const minPrice = Number.parseInt(params.get('minPrice') || '', 10);
  if (Number.isFinite(minPrice)) { where.push('price_yen >= ?'); binds.push(minPrice); }
  const maxPrice = Number.parseInt(params.get('maxPrice') || '', 10);
  if (Number.isFinite(maxPrice)) { where.push('price_yen <= ?'); binds.push(maxPrice); }

  const sort = {
    newest: 'first_seen_at DESC',
    updated: 'last_changed_at DESC',
    priceAsc: 'price_yen ASC',
    priceDesc: 'price_yen DESC'
  }[params.get('sort')] || 'last_changed_at DESC';
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get('limit') || '100', 10)));

  const result = await db.prepare(`
    SELECT p.*,
      (SELECT ph.price_yen FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.observed_at DESC LIMIT 1 OFFSET 1) AS previous_price_yen
    FROM products p
    WHERE ${where.join(' AND ')}
    ORDER BY ${sort}
    LIMIT ?
  `).bind(...binds, limit).all();
  return result.results || [];
}

export async function productHistory(db, id) {
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!product) return null;
  const history = await db.prepare('SELECT price_yen, observed_at FROM price_history WHERE product_id = ? ORDER BY observed_at ASC').bind(id).all();
  return { product, history: history.results || [] };
}
