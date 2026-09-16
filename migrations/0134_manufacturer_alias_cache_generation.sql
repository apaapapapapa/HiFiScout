-- Give each physical database a stable identity so an isolate-local alias snapshot cannot be
-- reused after a test binding or deployment binding changes while the revision number happens to
-- be the same. The existing registry clock already advances for every resolver-visible edit.
ALTER TABLE admin_manufacturer_registry_clock
  ADD COLUMN generation TEXT NOT NULL DEFAULT '';

UPDATE admin_manufacturer_registry_clock
SET generation = lower(hex(randomblob(16)))
WHERE id = 1;

-- rule_version is resolver-visible evidence too. The original administrative clock predates that
-- cache consumer, so include it without adding another write-amplifying revision table/trigger.
DROP TRIGGER admin_registry_knowledge_catalog_manufacturer_aliases_update;
CREATE TRIGGER admin_registry_knowledge_catalog_manufacturer_aliases_update
AFTER UPDATE ON knowledge_catalog_manufacturer_aliases
WHEN OLD.manufacturer_id IS NOT NEW.manufacturer_id
  OR OLD.alias IS NOT NEW.alias
  OR OLD.normalized_alias IS NOT NEW.normalized_alias
  OR OLD.verification_status IS NOT NEW.verification_status
  OR OLD.source IS NOT NEW.source
  OR OLD.rule_version IS NOT NEW.rule_version
BEGIN
  UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1;
END;

DROP TRIGGER admin_registry_knowledge_catalog_shop_manufacturer_aliases_update;
CREATE TRIGGER admin_registry_knowledge_catalog_shop_manufacturer_aliases_update
AFTER UPDATE ON knowledge_catalog_shop_manufacturer_aliases
WHEN OLD.manufacturer_id IS NOT NEW.manufacturer_id
  OR OLD.alias IS NOT NEW.alias
  OR OLD.normalized_alias IS NOT NEW.normalized_alias
  OR OLD.verification_status IS NOT NEW.verification_status
  OR OLD.source IS NOT NEW.source
  OR OLD.rule_version IS NOT NEW.rule_version
  OR OLD.shop_key IS NOT NEW.shop_key
BEGIN
  UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1;
END;
