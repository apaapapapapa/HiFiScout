-- Taxonomy v3 migration leaves pre-existing listings at category-classifier version 15 so the
-- bounded remediation queue can replay the complete typed-facet vocabulary. Migration 0068 only
-- seeds active rows; an inactive listing may therefore still be stale when it later reappears.
--
-- Enqueue the exact same deterministic classify-category work key on that inactive -> active edge.
-- This is deliberately scoped to the v3 migration marker/version pair: once replay advances the
-- listing to the current classifier version, ordinary reactivations do not touch this compatibility
-- trigger. Matching the automatic work key also keeps the normal active stale selector idempotent.
CREATE TRIGGER IF NOT EXISTS products_taxonomy_v3_reactivation_replay_au
AFTER UPDATE OF is_active ON products
WHEN OLD.is_active <> 1
  AND NEW.is_active = 1
  AND json_extract(
        CASE
          WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN NEW.metadata_json
          ELSE '{}'
        END,
        '$.categoryClassification.taxonomyVersion'
      ) = 'v3'
  AND COALESCE(
        CAST(
          json_extract(
            CASE
              WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN NEW.metadata_json
              ELSE '{}'
            END,
            '$.categoryClassification.version'
          ) AS INTEGER
        ),
        0
      ) = 15
BEGIN
  INSERT OR IGNORE INTO data_quality_remediation_queue(
    work_key,
    work_type,
    listing_product_id,
    entity_id,
    reason,
    source,
    status,
    priority,
    max_attempts,
    available_at,
    created_at,
    updated_at
  )
  VALUES (
    'auto:classify_category'
      || ':listing:' || NEW.id
      || ':manufacturer:' || NEW.manufacturer_resolver_version
      || ':model:' || NEW.model_resolver_version
      || ':category:15'
      || ':identity:' || COALESCE(
        (
          SELECT identity_resolver_version
          FROM product_identity_resolutions
          WHERE listing_product_id = NEW.id
        ),
        0
      ),
    'classify_category',
    NEW.id,
    '',
    'taxonomy_v3_reactivation_facet_replay',
    'taxonomy_v3_reactivation',
    'pending',
    100,
    3,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
