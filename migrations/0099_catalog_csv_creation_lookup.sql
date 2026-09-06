-- Bound CSV duplicate checks and their transactional snapshot to one identity bucket.
-- Rejected catalog rows participate too; a CSV insertion must not silently revive them.
CREATE INDEX idx_catalog_products_identity_bucket
  ON knowledge_catalog_products(manufacturer_id, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(normalized_model), ' ', ''), '-', ''), '_', ''), '.', ''), '/', ''), 'MARKIII', 'MK3'), 'MARKIV', 'MK4'), 'MARKII', 'MK2'), 'MARKI', 'MK1'), 'MKIII', 'MK3'), 'MKIV', 'MK4'), 'MKII', 'MK2'), 'MKI', 'MK1'));
