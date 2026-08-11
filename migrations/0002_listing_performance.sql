ALTER TABLE products ADD COLUMN previous_price_yen INTEGER;

UPDATE products
SET previous_price_yen = (
  SELECT ph.price_yen
  FROM price_history ph
  WHERE ph.product_id = products.id
  ORDER BY ph.observed_at DESC
  LIMIT 1 OFFSET 1
);

DROP INDEX IF EXISTS idx_products_active_price;
DROP INDEX IF EXISTS idx_products_manufacturer;
DROP INDEX IF EXISTS idx_products_category;

CREATE INDEX IF NOT EXISTS idx_products_active_updated
  ON products(last_changed_at DESC, id DESC)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_active_newest
  ON products(first_seen_at DESC, id DESC)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_active_price
  ON products(price_yen, id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_manufacturer
  ON products(manufacturer)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_category
  ON products(category)
  WHERE is_active = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  title,
  manufacturer,
  model,
  content='products',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, title, manufacturer, model)
  VALUES (new.id, new.title, new.manufacturer, new.model);
END;

CREATE TRIGGER IF NOT EXISTS products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, manufacturer, model)
  VALUES ('delete', old.id, old.title, old.manufacturer, old.model);
END;

CREATE TRIGGER IF NOT EXISTS products_fts_au AFTER UPDATE OF title, manufacturer, model ON products
WHEN old.title IS NOT new.title OR old.manufacturer IS NOT new.manufacturer OR old.model IS NOT new.model
BEGIN
  INSERT INTO products_fts(products_fts, rowid, title, manufacturer, model)
  VALUES ('delete', old.id, old.title, old.manufacturer, old.model);
  INSERT INTO products_fts(rowid, title, manufacturer, model)
  VALUES (new.id, new.title, new.manufacturer, new.model);
END;

INSERT INTO products_fts(products_fts) VALUES ('rebuild');
PRAGMA optimize;
