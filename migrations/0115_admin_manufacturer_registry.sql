ALTER TABLE knowledge_catalog_manufacturers ADD COLUMN name_ja TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_catalog_manufacturers ADD COLUMN name_en TEXT NOT NULL DEFAULT '';
CREATE TABLE admin_manufacturer_registry_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0);
INSERT INTO admin_manufacturer_registry_clock(id,version) VALUES(1,0);
CREATE TABLE admin_manufacturer_changes (
  operation_id TEXT PRIMARY KEY,
  manufacturer_id TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  matcher_json TEXT NOT NULL CHECK(json_valid(matcher_json)),
  max_product_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applying','applied')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_admin_manufacturer_changes ON admin_manufacturer_changes(manufacturer_id,created_at DESC,operation_id DESC);
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturers_insert AFTER INSERT ON knowledge_catalog_manufacturers
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturers_update AFTER UPDATE ON knowledge_catalog_manufacturers WHEN OLD.canonical_name IS NOT NEW.canonical_name OR OLD.name_ja IS NOT NEW.name_ja OR OLD.name_en IS NOT NEW.name_en OR OLD.verification_status IS NOT NEW.verification_status
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturers_delete AFTER DELETE ON knowledge_catalog_manufacturers
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturer_aliases_insert AFTER INSERT ON knowledge_catalog_manufacturer_aliases
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturer_aliases_update AFTER UPDATE ON knowledge_catalog_manufacturer_aliases WHEN OLD.manufacturer_id IS NOT NEW.manufacturer_id OR OLD.alias IS NOT NEW.alias OR OLD.normalized_alias IS NOT NEW.normalized_alias OR OLD.verification_status IS NOT NEW.verification_status OR OLD.source IS NOT NEW.source
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturer_aliases_delete AFTER DELETE ON knowledge_catalog_manufacturer_aliases
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_shop_manufacturer_aliases_insert AFTER INSERT ON knowledge_catalog_shop_manufacturer_aliases
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_shop_manufacturer_aliases_update AFTER UPDATE ON knowledge_catalog_shop_manufacturer_aliases WHEN OLD.manufacturer_id IS NOT NEW.manufacturer_id OR OLD.alias IS NOT NEW.alias OR OLD.normalized_alias IS NOT NEW.normalized_alias OR OLD.verification_status IS NOT NEW.verification_status OR OLD.source IS NOT NEW.source OR OLD.shop_key IS NOT NEW.shop_key
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER admin_registry_knowledge_catalog_shop_manufacturer_aliases_delete AFTER DELETE ON knowledge_catalog_shop_manufacturer_aliases
BEGIN UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1; END;
