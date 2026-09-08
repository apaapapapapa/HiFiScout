-- Keep the existing global alias uniqueness and import contract intact.
CREATE TABLE knowledge_catalog_shop_manufacturer_aliases (
  id INTEGER PRIMARY KEY,
  manufacturer_id TEXT NOT NULL REFERENCES knowledge_catalog_manufacturers(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  source TEXT NOT NULL DEFAULT 'admin_alias_control',
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
  rule_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  shop_key TEXT NOT NULL CHECK (length(shop_key)>0),
  UNIQUE (shop_key,manufacturer_id,normalized_alias)
);
CREATE INDEX idx_shop_alias_lookup ON knowledge_catalog_shop_manufacturer_aliases(normalized_alias,verification_status,manufacturer_id,shop_key);
CREATE INDEX idx_shop_alias_manufacturer ON knowledge_catalog_shop_manufacturer_aliases(manufacturer_id,shop_key,normalized_alias);
