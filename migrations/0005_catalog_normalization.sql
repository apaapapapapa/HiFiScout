ALTER TABLE products ADD COLUMN raw_manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN manufacturer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN raw_category TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN primary_category_id TEXT NOT NULL DEFAULT 'other';
ALTER TABLE products ADD COLUMN category_ids TEXT NOT NULL DEFAULT '["other"]';
ALTER TABLE products ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (classification_status IN ('classified', 'unclassified'));
ALTER TABLE products ADD COLUMN search_aliases TEXT NOT NULL DEFAULT '';

UPDATE products
SET raw_manufacturer = manufacturer,
    manufacturer_id = lower(replace(replace(trim(manufacturer), ' ', ''), '-', '')),
    raw_category = category,
    primary_category_id = CASE category
      WHEN 'スピーカー' THEN 'speaker'
      WHEN 'プリメインアンプ' THEN 'integrated_amp'
      WHEN 'プリアンプ' THEN 'pre_amp'
      WHEN 'パワーアンプ' THEN 'power_amp'
      WHEN 'DAC' THEN 'dac'
      WHEN 'ネットワーク' THEN 'network_player'
      WHEN 'CD/SACDプレーヤー' THEN 'cd_sacd_player'
      WHEN 'イヤホン' THEN 'earphone'
      WHEN 'ヘッドホン' THEN 'headphone'
      WHEN 'DAP・ヘッドホンアンプ' THEN 'dap'
      WHEN 'DJ機器・DTM' THEN 'dj_dtm'
      WHEN 'ケーブル・アクセサリー' THEN 'accessory'
      ELSE 'other'
    END,
    category_ids = CASE category
      WHEN 'スピーカー' THEN '["speaker"]'
      WHEN 'プリメインアンプ' THEN '["integrated_amp"]'
      WHEN 'プリアンプ' THEN '["pre_amp"]'
      WHEN 'パワーアンプ' THEN '["power_amp"]'
      WHEN 'DAC' THEN '["dac"]'
      WHEN 'ネットワーク' THEN '["network_player"]'
      WHEN 'CD/SACDプレーヤー' THEN '["cd_sacd_player"]'
      WHEN 'イヤホン' THEN '["earphone"]'
      WHEN 'ヘッドホン' THEN '["headphone"]'
      WHEN 'DAP・ヘッドホンアンプ' THEN '["dap","headphone_amp"]'
      WHEN 'DJ機器・DTM' THEN '["dj_dtm"]'
      WHEN 'ケーブル・アクセサリー' THEN '["accessory","cable"]'
      ELSE '["other"]'
    END,
    classification_status = CASE
      WHEN category IN (
        'スピーカー', 'プリメインアンプ', 'プリアンプ', 'パワーアンプ', 'DAC',
        'ネットワーク', 'CD/SACDプレーヤー', 'イヤホン', 'ヘッドホン',
        'DAP・ヘッドホンアンプ', 'DJ機器・DTM', 'ケーブル・アクセサリー'
      ) THEN 'classified'
      ELSE 'unclassified'
    END;

UPDATE products SET category = 'ネットワークプレーヤー' WHERE primary_category_id = 'network_player';
UPDATE products SET category = 'DAP' WHERE primary_category_id = 'dap';
UPDATE products SET category = 'アクセサリー' WHERE primary_category_id = 'accessory';

CREATE INDEX IF NOT EXISTS idx_products_manufacturer_id
  ON products(manufacturer_id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_primary_category
  ON products(primary_category_id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_classification_status
  ON products(classification_status)
  WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS product_categories (
  product_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY(product_id, category_id),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category
  ON product_categories(category_id, product_id);

INSERT OR IGNORE INTO product_categories(product_id, category_id)
SELECT p.id, json_each.value
FROM products p, json_each(p.category_ids);

DROP TRIGGER IF EXISTS products_fts_ai;
DROP TRIGGER IF EXISTS products_fts_ad;
DROP TRIGGER IF EXISTS products_fts_au;
DROP TABLE IF EXISTS products_fts;

CREATE VIRTUAL TABLE products_fts USING fts5(
  title,
  manufacturer,
  model,
  category,
  raw_category,
  raw_manufacturer,
  search_aliases,
  content='products',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(
    rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    new.id, new.title, new.manufacturer, new.model, new.category,
    new.raw_category, new.raw_manufacturer, new.search_aliases
  );
END;

CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(
    products_fts, rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    'delete', old.id, old.title, old.manufacturer, old.model, old.category,
    old.raw_category, old.raw_manufacturer, old.search_aliases
  );
END;

CREATE TRIGGER products_fts_au
AFTER UPDATE OF title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases ON products
WHEN old.title IS NOT new.title
  OR old.manufacturer IS NOT new.manufacturer
  OR old.model IS NOT new.model
  OR old.category IS NOT new.category
  OR old.raw_category IS NOT new.raw_category
  OR old.raw_manufacturer IS NOT new.raw_manufacturer
  OR old.search_aliases IS NOT new.search_aliases
BEGIN
  INSERT INTO products_fts(
    products_fts, rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    'delete', old.id, old.title, old.manufacturer, old.model, old.category,
    old.raw_category, old.raw_manufacturer, old.search_aliases
  );
  INSERT INTO products_fts(
    rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    new.id, new.title, new.manufacturer, new.model, new.category,
    new.raw_category, new.raw_manufacturer, new.search_aliases
  );
END;

INSERT INTO products_fts(products_fts) VALUES ('rebuild');
PRAGMA optimize;
