-- Composite category keys are the physical keys; preserve all indexes, constraints and guards.

-- One atomic migration: the aggregate view is restored before either Worker can observe the schema.

DROP VIEW public_meta_aggregate;

CREATE TABLE product_categories_replacement (
  product_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  is_direct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(product_id, category_id),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO product_categories_replacement SELECT * FROM product_categories;

DROP TABLE product_categories;

ALTER TABLE product_categories_replacement RENAME TO product_categories;

CREATE INDEX idx_product_categories_category
  ON product_categories(category_id, product_id);

CREATE INDEX idx_product_categories_direct
  ON product_categories(category_id, product_id)
  WHERE is_direct = 1;

CREATE TRIGGER product_admin_overrides_categories_bd
BEFORE DELETE ON product_categories
WHEN EXISTS (
  SELECT 1 FROM product_admin_overrides o
  WHERE o.listing_product_id = OLD.product_id AND o.primary_category_id IS NOT NULL
)
-- Preserve manual category protection while allowing the parent's ON DELETE CASCADE.
-- Child cascade order can change after a table rebuild; it must not depend on the override
-- row having been deleted first. SQLite removes the parent before applying child actions.
AND EXISTS (SELECT 1 FROM products WHERE id = OLD.product_id)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER product_admin_overrides_categories_bi
BEFORE INSERT ON product_categories
WHEN EXISTS (
  SELECT 1
  FROM product_admin_overrides o
  WHERE o.listing_product_id = NEW.product_id
    AND o.primary_category_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM json_each(o.category_ids) WHERE value = NEW.category_id
    )
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TABLE product_search_entity_categories_replacement (
  entity_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  is_direct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(entity_id, category_id),
  FOREIGN KEY(entity_id) REFERENCES product_search_entities(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO product_search_entity_categories_replacement SELECT * FROM product_search_entity_categories;

DROP TABLE product_search_entity_categories;

ALTER TABLE product_search_entity_categories_replacement RENAME TO product_search_entity_categories;

CREATE INDEX idx_product_search_entity_categories_category
  ON product_search_entity_categories(category_id, entity_id);

CREATE TABLE knowledge_catalog_product_categories_replacement (
  product_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY(product_id, category_id),
  FOREIGN KEY(product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO knowledge_catalog_product_categories_replacement SELECT * FROM knowledge_catalog_product_categories;

DROP TABLE knowledge_catalog_product_categories;

ALTER TABLE knowledge_catalog_product_categories_replacement RENAME TO knowledge_catalog_product_categories;

CREATE INDEX idx_knowledge_catalog_categories_category
  ON knowledge_catalog_product_categories(category_id, product_id);

CREATE INDEX idx_knowledge_catalog_export_categories_order
  ON knowledge_catalog_product_categories(product_id, is_primary DESC, category_id);

CREATE UNIQUE INDEX idx_knowledge_catalog_primary_category
  ON knowledge_catalog_product_categories(product_id)
  WHERE is_primary = 1;

CREATE VIEW public_meta_aggregate AS
WITH vocabulary AS (
SELECT
        'manufacturer' AS facet_kind,
        manufacturer_id,
        MIN(manufacturer) AS value,
        COUNT(*) AS active_product_count
      FROM products
      WHERE is_active = 1 AND manufacturer <> ''
      GROUP BY manufacturer_id
      UNION ALL
      SELECT
        'shop' AS facet_kind,
        NULL AS manufacturer_id,
        shop_key AS value,
        COUNT(*) AS active_product_count
      FROM products
      WHERE is_active = 1
      GROUP BY shop_key
),
categories AS (
SELECT ec.category_id AS value, COUNT(DISTINCT ec.entity_id) AS active_product_count
      FROM product_search_entity_categories ec
      GROUP BY ec.category_id
),
facets AS (
SELECT f.facet_id, f.facet_value,
             COUNT(DISTINCT membership.entity_id) AS active_product_count
      FROM product_facet_facts f
      JOIN products p ON p.id = f.product_id AND p.is_active = 1
      JOIN product_search_entity_offers membership ON membership.listing_product_id = p.id
      GROUP BY f.facet_id, f.facet_value
),
taxonomy AS (
SELECT
        COUNT(*) AS active_count,
        SUM(CASE WHEN p.primary_category_id = 'unclassified' THEN 1 ELSE 0 END) AS unclassified_count,
        SUM(CASE
          WHEN json_valid(COALESCE(p.metadata_json, ''))
           AND CAST(json_extract(p.metadata_json, '$.categoryClassification.confidence') AS REAL)
               BETWEEN 0.000001 AND 0.649999
          THEN 1 ELSE 0 END
        ) AS low_confidence_count,
        SUM(CASE WHEN p.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory') THEN 1 ELSE 0 END)
          AS legacy_residue_count,
        SUM(CASE WHEN p.primary_category_id = 'other' THEN 1 ELSE 0 END) AS legacy_other_count,
        (SELECT COUNT(DISTINCT a.entity_id)
         FROM taxonomy_v3_migration_audit a
         WHERE a.entity_type = 'product_primary'
           AND a.legacy_category_id <> a.canonical_category_id) AS migrated_shift_count
      FROM products p
      WHERE p.is_active = 1
)
SELECT json_array(
  json_object('results', (SELECT json_group_array(json_object('facet_kind', facet_kind, 'manufacturer_id', manufacturer_id, 'value', value, 'active_product_count', active_product_count)) FROM vocabulary)),
  json_object('results', (SELECT json_group_array(json_object('value', value, 'active_product_count', active_product_count)) FROM categories)),
  json_object('results', (SELECT json_group_array(json_object('facet_id', facet_id, 'facet_value', facet_value, 'active_product_count', active_product_count)) FROM facets)),
  json_object('results', (SELECT json_group_array(json_object('active_count', active_count, 'unclassified_count', unclassified_count, 'low_confidence_count', low_confidence_count, 'legacy_residue_count', legacy_residue_count, 'legacy_other_count', legacy_other_count, 'migrated_shift_count', migrated_shift_count)) FROM taxonomy))
) AS payload_json;
