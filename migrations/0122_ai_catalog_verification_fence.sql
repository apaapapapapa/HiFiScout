-- Registered only when a manual AI handoff needs a fence. Unwatched manufacturers add no writes.
-- The counter fences snapshot reads; it is intentionally NOT part of the AI result cache key.
CREATE TABLE ai_catalog_revisions (
  manufacturer_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER ai_catalog_product_insert AFTER INSERT ON knowledge_catalog_products
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=NEW.manufacturer_id;
END;

CREATE TRIGGER ai_catalog_product_delete AFTER DELETE ON knowledge_catalog_products
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=OLD.manufacturer_id;
END;

CREATE TRIGGER ai_catalog_product_update AFTER UPDATE ON knowledge_catalog_products
WHEN (OLD.id IS NOT NEW.id
  OR OLD.manufacturer_id IS NOT NEW.manufacturer_id
  OR OLD.canonical_model IS NOT NEW.canonical_model
  OR OLD.normalized_model IS NOT NEW.normalized_model
  OR OLD.verification_status IS NOT NEW.verification_status)
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (OLD.manufacturer_id,NEW.manufacturer_id);
END;

CREATE TRIGGER ai_catalog_category_insert AFTER INSERT ON knowledge_catalog_product_categories
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id =NEW.product_id);
END;

CREATE TRIGGER ai_catalog_category_delete AFTER DELETE ON knowledge_catalog_product_categories
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id =OLD.product_id);
END;

CREATE TRIGGER ai_catalog_category_update AFTER UPDATE ON knowledge_catalog_product_categories
WHEN (OLD.product_id IS NOT NEW.product_id
  OR OLD.category_id IS NOT NEW.category_id
  OR OLD.is_primary IS NOT NEW.is_primary)
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id IN (OLD.product_id,NEW.product_id));
END;

CREATE TRIGGER ai_catalog_alias_insert AFTER INSERT ON knowledge_catalog_aliases
WHEN NEW.alias_type='model'
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id =NEW.product_id);
END;

CREATE TRIGGER ai_catalog_alias_delete AFTER DELETE ON knowledge_catalog_aliases
WHEN OLD.alias_type='model'
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id =OLD.product_id);
END;

CREATE TRIGGER ai_catalog_alias_update AFTER UPDATE ON knowledge_catalog_aliases
WHEN (OLD.alias_type='model' OR NEW.alias_type='model') AND (OLD.product_id IS NOT NEW.product_id
  OR OLD.alias IS NOT NEW.alias
  OR OLD.normalized_alias IS NOT NEW.normalized_alias
  OR OLD.alias_type IS NOT NEW.alias_type)
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (SELECT manufacturer_id FROM knowledge_catalog_products WHERE id IN (OLD.product_id,NEW.product_id));
END;

CREATE TRIGGER ai_catalog_candidate_insert AFTER INSERT ON knowledge_catalog_candidates
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=NEW.manufacturer_id;
END;

CREATE TRIGGER ai_catalog_candidate_delete AFTER DELETE ON knowledge_catalog_candidates
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=OLD.manufacturer_id;
END;

CREATE TRIGGER ai_catalog_candidate_update AFTER UPDATE ON knowledge_catalog_candidates
WHEN (OLD.id IS NOT NEW.id
  OR OLD.manufacturer_id IS NOT NEW.manufacturer_id
  OR OLD.observed_model IS NOT NEW.observed_model
  OR OLD.sample_title IS NOT NEW.sample_title
  OR OLD.raw_model_variants IS NOT NEW.raw_model_variants
  OR OLD.candidate_category_ids IS NOT NEW.candidate_category_ids
  OR OLD.identity_rejection_reason IS NOT NEW.identity_rejection_reason
  OR OLD.review_status IS NOT NEW.review_status
  OR OLD.verification_status IS NOT NEW.verification_status
  OR (OLD.active_listing_count>0) IS NOT (NEW.active_listing_count>0)
  OR (COALESCE(OLD.last_verification_at,'')='') IS NOT (COALESCE(NEW.last_verification_at,'')=''))
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (OLD.manufacturer_id,NEW.manufacturer_id);
END;

CREATE TRIGGER ai_catalog_manufacturer_insert AFTER INSERT ON knowledge_catalog_manufacturers
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=NEW.id;
END;

CREATE TRIGGER ai_catalog_manufacturer_delete AFTER DELETE ON knowledge_catalog_manufacturers
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id=OLD.id;
END;

CREATE TRIGGER ai_catalog_manufacturer_update AFTER UPDATE ON knowledge_catalog_manufacturers
WHEN (OLD.id IS NOT NEW.id
  OR OLD.verification_status IS NOT NEW.verification_status)
BEGIN
  UPDATE ai_catalog_revisions SET revision=revision+1 WHERE manufacturer_id IN (OLD.id,NEW.id);
END;

