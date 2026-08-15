-- Post-Phase-4 remediation governance.
--
-- Provenance is change-only: the existing event table records the canonical field that moved.
-- These columns add the downstream Product Identity/search-entity state on both sides of that
-- change so an operator can explain the complete transition without reconstructing old read models.
ALTER TABLE data_quality_remediation_events
  ADD COLUMN previous_identity_resolution TEXT NOT NULL DEFAULT '';
ALTER TABLE data_quality_remediation_events
  ADD COLUMN new_identity_resolution TEXT NOT NULL DEFAULT '';
ALTER TABLE data_quality_remediation_events
  ADD COLUMN previous_search_entity_key TEXT NOT NULL DEFAULT '';
ALTER TABLE data_quality_remediation_events
  ADD COLUMN new_search_entity_key TEXT NOT NULL DEFAULT '';
ALTER TABLE data_quality_remediation_events
  ADD COLUMN provenance_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provenance_complete IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_data_quality_remediation_events_incomplete
  ON data_quality_remediation_events(listing_product_id, provenance_complete, id)
  WHERE provenance_complete = 0;

-- An event is inserted after the canonical products row has changed but before Product Identity and
-- Product Search are refreshed. Snapshot the still-old downstream state. Identity-only catalog
-- replay events are inserted after refresh; for those the explicit previous/new identity values are
-- authoritative and the old search membership can be derived from the identity contract.
CREATE TRIGGER IF NOT EXISTS data_quality_remediation_event_snapshot_ai
AFTER INSERT ON data_quality_remediation_events
BEGIN
  UPDATE data_quality_remediation_events
  SET previous_identity_resolution = CASE
        WHEN NEW.field = 'identity' THEN NEW.previous_value
        ELSE COALESCE((
          SELECT r.status || ':' || r.match_method || ':' ||
                 COALESCE(CAST(r.catalog_product_id AS TEXT), '-')
          FROM product_identity_resolutions r
          WHERE r.listing_product_id = NEW.listing_product_id
        ), 'none')
      END,
      previous_search_entity_key = CASE
        WHEN NEW.field = 'identity' AND NEW.previous_value LIKE 'matched:%:%' THEN
          'c-' || substr(
            substr(NEW.previous_value, instr(NEW.previous_value, ':') + 1),
            instr(substr(NEW.previous_value, instr(NEW.previous_value, ':') + 1), ':') + 1
          )
        WHEN NEW.field = 'identity' THEN 'l-' || CAST(NEW.listing_product_id AS TEXT)
        ELSE COALESCE((
          SELECT e.entity_key
          FROM product_search_entity_offers o
          JOIN product_search_entities e ON e.id = o.entity_id
          WHERE o.listing_product_id = NEW.listing_product_id
        ), '')
      END,
      new_identity_resolution = CASE
        WHEN NEW.field = 'identity' THEN NEW.new_value
        ELSE ''
      END,
      new_search_entity_key = CASE
        WHEN NEW.field = 'identity'
         AND NOT EXISTS (
           SELECT 1 FROM data_quality_remediation_queue q
           WHERE q.listing_product_id = NEW.listing_product_id AND q.status = 'processing'
         )
        THEN COALESCE((
          SELECT e.entity_key
          FROM product_search_entity_offers o
          JOIN product_search_entities e ON e.id = o.entity_id
          WHERE o.listing_product_id = NEW.listing_product_id
        ), '')
        ELSE ''
      END,
      resolver_confidence = CASE
        WHEN NEW.field = 'identity' THEN COALESCE((
          SELECT r.confidence
          FROM product_identity_resolutions r
          WHERE r.listing_product_id = NEW.listing_product_id
        ), NEW.resolver_confidence)
        ELSE NEW.resolver_confidence
      END,
      resolver_version = CASE
        WHEN NEW.field = 'identity' THEN COALESCE((
          SELECT r.identity_resolver_version
          FROM product_identity_resolutions r
          WHERE r.listing_product_id = NEW.listing_product_id
        ), NEW.resolver_version)
        ELSE NEW.resolver_version
      END,
      provenance_complete = CASE
        WHEN NEW.field = 'identity'
         AND NOT EXISTS (
           SELECT 1 FROM data_quality_remediation_queue q
           WHERE q.listing_product_id = NEW.listing_product_id AND q.status = 'processing'
         )
        THEN 1
        ELSE 0
      END
  WHERE id = NEW.id;
END;

-- Product Search membership is the last stage of refreshListingProjections(). Its upsert therefore
-- provides the commit point at which both Product Identity and entity membership represent the new
-- state. Incomplete events also survive a failed refresh and are completed by the next successful
-- retry/crawl instead of losing their original before-state.
CREATE TRIGGER IF NOT EXISTS data_quality_remediation_offer_insert_ai
AFTER INSERT ON product_search_entity_offers
BEGIN
  UPDATE data_quality_remediation_events
  SET new_identity_resolution = COALESCE((
        SELECT r.status || ':' || r.match_method || ':' ||
               COALESCE(CAST(r.catalog_product_id AS TEXT), '-')
        FROM product_identity_resolutions r
        WHERE r.listing_product_id = NEW.listing_product_id
      ), 'none'),
      new_search_entity_key = COALESCE((
        SELECT e.entity_key FROM product_search_entities e WHERE e.id = NEW.entity_id
      ), ''),
      provenance_complete = 1
  WHERE listing_product_id = NEW.listing_product_id AND provenance_complete = 0;
END;

CREATE TRIGGER IF NOT EXISTS data_quality_remediation_offer_update_au
AFTER UPDATE OF entity_id, shop_key ON product_search_entity_offers
BEGIN
  UPDATE data_quality_remediation_events
  SET new_identity_resolution = COALESCE((
        SELECT r.status || ':' || r.match_method || ':' ||
               COALESCE(CAST(r.catalog_product_id AS TEXT), '-')
        FROM product_identity_resolutions r
        WHERE r.listing_product_id = NEW.listing_product_id
      ), 'none'),
      new_search_entity_key = COALESCE((
        SELECT e.entity_key FROM product_search_entities e WHERE e.id = NEW.entity_id
      ), ''),
      provenance_complete = 1
  WHERE listing_product_id = NEW.listing_product_id AND provenance_complete = 0;
END;

-- The generic Phase 7-9 queue updates products in one statement. Record the canonical fields that
-- actually moved. Direct manufacturer/model/catalog replay paths already write their own events and
-- use non-dq replay tokens, so this trigger does not duplicate them.
CREATE TRIGGER IF NOT EXISTS data_quality_remediation_queue_product_change_au
AFTER UPDATE OF canonical_manufacturer_id, manufacturer_resolution_status,
                manufacturer_resolution_method, manufacturer_resolution_confidence,
                model, normalized_model, model_resolution_status, model_resolution_method,
                model_resolution_confidence, category, primary_category_id, classification_status
ON products
WHEN NEW.remediation_projection_required = 1
 AND NEW.remediation_projection_token LIKE 'dq-replay:%'
BEGIN
  INSERT INTO data_quality_remediation_events(
    listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
    resolver_method, resolver_confidence, resolver_version, processed_at
  )
  SELECT NEW.id, NEW.shop_key, NEW.source_id, 'manufacturer',
         COALESCE(OLD.canonical_manufacturer_id, '') || ' (' || OLD.manufacturer_resolution_status || ')',
         COALESCE(NEW.canonical_manufacturer_id, '') || ' (' || NEW.manufacturer_resolution_status || ')',
         'manufacturer_resolver_queue_replay', NEW.manufacturer_resolution_method,
         NEW.manufacturer_resolution_confidence, NEW.manufacturer_resolver_version,
         substr(NEW.remediation_projection_token, 11, 24)
  WHERE OLD.canonical_manufacturer_id IS NOT NEW.canonical_manufacturer_id
     OR OLD.manufacturer_resolution_status IS NOT NEW.manufacturer_resolution_status
     OR OLD.manufacturer_resolution_method IS NOT NEW.manufacturer_resolution_method
     OR OLD.manufacturer_resolution_confidence IS NOT NEW.manufacturer_resolution_confidence;

  INSERT INTO data_quality_remediation_events(
    listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
    resolver_method, resolver_confidence, resolver_version, processed_at
  )
  SELECT NEW.id, NEW.shop_key, NEW.source_id, 'model',
         COALESCE(OLD.model, '') || ' (' || COALESCE(OLD.normalized_model, '') || '/' || OLD.model_resolution_status || ')',
         COALESCE(NEW.model, '') || ' (' || COALESCE(NEW.normalized_model, '') || '/' || NEW.model_resolution_status || ')',
         'model_resolver_queue_replay', NEW.model_resolution_method,
         NEW.model_resolution_confidence, NEW.model_resolver_version,
         substr(NEW.remediation_projection_token, 11, 24)
  WHERE OLD.model IS NOT NEW.model
     OR OLD.normalized_model IS NOT NEW.normalized_model
     OR OLD.model_resolution_status IS NOT NEW.model_resolution_status
     OR OLD.model_resolution_method IS NOT NEW.model_resolution_method
     OR OLD.model_resolution_confidence IS NOT NEW.model_resolution_confidence;

  INSERT INTO data_quality_remediation_events(
    listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
    resolver_method, resolver_confidence, resolver_version, processed_at
  )
  SELECT NEW.id, NEW.shop_key, NEW.source_id, 'category',
         COALESCE(OLD.category, '') || ' (' || COALESCE(OLD.primary_category_id, '') || '/' || OLD.classification_status || ')',
         COALESCE(NEW.category, '') || ' (' || COALESCE(NEW.primary_category_id, '') || '/' || NEW.classification_status || ')',
         'category_classifier_queue_replay', 'category_evidence', '',
         CASE
           WHEN json_valid(NEW.metadata_json) THEN COALESCE(
             CAST(json_extract(NEW.metadata_json, '$.categoryClassification.version') AS INTEGER),
             0
           )
           ELSE 0
         END,
         substr(NEW.remediation_projection_token, 11, 24)
  WHERE OLD.category IS NOT NEW.category
     OR OLD.primary_category_id IS NOT NEW.primary_category_id
     OR OLD.classification_status IS NOT NEW.classification_status;
END;

-- Identity-only queue work has no products-row change to hang provenance from. Record only actual
-- identity transitions while the listing has a claimed remediation job. The subsequent search
-- membership upsert completes the entity side of the event.
CREATE TRIGGER IF NOT EXISTS data_quality_remediation_queue_identity_insert_ai
AFTER INSERT ON product_identity_resolutions
WHEN EXISTS (
  SELECT 1 FROM data_quality_remediation_queue q
  WHERE q.listing_product_id = NEW.listing_product_id AND q.status = 'processing'
)
BEGIN
  INSERT INTO data_quality_remediation_events(
    listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
    resolver_method, resolver_confidence, resolver_version, processed_at
  )
  SELECT p.id, p.shop_key, p.source_id, 'identity', 'none',
         NEW.status || ':' || NEW.match_method || ':' || COALESCE(CAST(NEW.catalog_product_id AS TEXT), '-'),
         'identity_resolver_queue_replay', NEW.match_method, NEW.confidence,
         NEW.identity_resolver_version, NEW.evaluated_at
  FROM products p WHERE p.id = NEW.listing_product_id;
END;

CREATE TRIGGER IF NOT EXISTS data_quality_remediation_queue_identity_update_au
AFTER UPDATE OF catalog_product_id, status, match_method, confidence ON product_identity_resolutions
WHEN EXISTS (
  SELECT 1 FROM data_quality_remediation_queue q
  WHERE q.listing_product_id = NEW.listing_product_id AND q.status = 'processing'
)
AND (
  OLD.catalog_product_id IS NOT NEW.catalog_product_id
  OR OLD.status IS NOT NEW.status
  OR OLD.match_method IS NOT NEW.match_method
  OR OLD.confidence IS NOT NEW.confidence
)
BEGIN
  INSERT INTO data_quality_remediation_events(
    listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
    resolver_method, resolver_confidence, resolver_version, processed_at
  )
  SELECT p.id, p.shop_key, p.source_id, 'identity',
         OLD.status || ':' || OLD.match_method || ':' || COALESCE(CAST(OLD.catalog_product_id AS TEXT), '-'),
         NEW.status || ':' || NEW.match_method || ':' || COALESCE(CAST(NEW.catalog_product_id AS TEXT), '-'),
         'identity_resolver_queue_replay', NEW.match_method, NEW.confidence,
         NEW.identity_resolver_version, NEW.evaluated_at
  FROM products p WHERE p.id = NEW.listing_product_id;
END;
