-- Seller evidence remains on products; canonical manufacturer knowledge and aliases live in
-- dedicated tables so verified spelling changes do not require a Worker deployment.
CREATE TABLE IF NOT EXISTS knowledge_catalog_manufacturers (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'verified'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  source TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_manufacturers_status
  ON knowledge_catalog_manufacturers(verification_status, id);

CREATE TABLE IF NOT EXISTS knowledge_catalog_manufacturer_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  source TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json)),
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(manufacturer_id, normalized_alias),
  FOREIGN KEY(manufacturer_id) REFERENCES knowledge_catalog_manufacturers(id) ON DELETE CASCADE
);

-- More than one manufacturer may intentionally claim the same spelling. The resolver detects the
-- collision and keeps it as a candidate instead of relying on a uniqueness constraint to hide it.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_manufacturer_alias_lookup
  ON knowledge_catalog_manufacturer_aliases(normalized_alias, verification_status, manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_manufacturer_alias_manufacturer
  ON knowledge_catalog_manufacturer_aliases(manufacturer_id, verification_status, normalized_alias);

-- `manufacturer_id` remains the public/filter id during the rollout. Only the new canonical id is
-- allowed to drive Knowledge Catalog and Product Identity candidate loading.
ALTER TABLE products ADD COLUMN normalized_raw_manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN canonical_manufacturer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN manufacturer_resolution_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (manufacturer_resolution_status IN ('resolved', 'candidate', 'unresolved'));
ALTER TABLE products ADD COLUMN manufacturer_resolution_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE products ADD COLUMN manufacturer_resolution_confidence TEXT NOT NULL DEFAULT 'none'
  CHECK (manufacturer_resolution_confidence IN ('high', 'medium', 'low', 'none'));
ALTER TABLE products ADD COLUMN manufacturer_resolver_version INTEGER NOT NULL DEFAULT 1
  CHECK (manufacturer_resolver_version > 0);

ALTER TABLE products ADD COLUMN raw_model TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN normalized_model TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN model_resolution_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (model_resolution_status IN ('resolved', 'candidate', 'unresolved'));
ALTER TABLE products ADD COLUMN model_resolution_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE products ADD COLUMN model_resolution_confidence TEXT NOT NULL DEFAULT 'none'
  CHECK (model_resolution_confidence IN ('high', 'medium', 'low', 'none'));

-- Preserve every existing listing. The historical metadata distinguishes code-dictionary aliases
-- from synthesized filter ids; unresolved synthesized ids must not become canonical identity.
UPDATE products
SET normalized_raw_manufacturer = lower(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(
        trim(raw_manufacturer), ' ', ''), '-', ''), '_', ''), '&', ''), '/', ''),
        '.', ''), ',', ''), '(', ''), ')', '')
    ),
    canonical_manufacturer_id = CASE
      WHEN COALESCE(json_extract(metadata_json, '$.manufacturerNormalization.matchedAlias'), 0) = 1
      THEN manufacturer_id
      ELSE ''
    END,
    manufacturer_resolution_status = CASE
      WHEN COALESCE(json_extract(metadata_json, '$.manufacturerNormalization.matchedAlias'), 0) = 1
      THEN 'resolved'
      ELSE 'unresolved'
    END,
    manufacturer_resolution_method = CASE
      WHEN COALESCE(json_extract(metadata_json, '$.manufacturerNormalization.matchedAlias'), 0) = 1
      THEN 'bootstrap_alias'
      ELSE 'none'
    END,
    manufacturer_resolution_confidence = CASE
      WHEN COALESCE(json_extract(metadata_json, '$.manufacturerNormalization.matchedAlias'), 0) = 1
      THEN 'high'
      ELSE 'none'
    END,
    raw_model = model,
    normalized_model = lower(
      replace(replace(replace(replace(replace(trim(model), ' ', ''), '-', ''), '_', ''), '.', ''), '/', '')
    ),
    model_resolution_status = CASE WHEN trim(model) <> '' THEN 'resolved' ELSE 'unresolved' END,
    model_resolution_method = CASE WHEN trim(model) <> '' THEN 'legacy_normalization' ELSE 'none' END,
    model_resolution_confidence = CASE WHEN trim(model) <> '' THEN 'medium' ELSE 'none' END;

CREATE INDEX IF NOT EXISTS idx_products_canonical_manufacturer
  ON products(canonical_manufacturer_id, is_active, id)
  WHERE canonical_manufacturer_id <> '';
CREATE INDEX IF NOT EXISTS idx_products_manufacturer_resolution
  ON products(manufacturer_resolution_status, normalized_raw_manufacturer, is_active, id);
CREATE INDEX IF NOT EXISTS idx_products_model_resolution
  ON products(model_resolution_status, is_active, id);
