-- Persist small vocabulary counters. Seller/manufacturer counts use listings; categories/facets
-- use distinct search entities. The legacy full aggregate remains a rollback/reference view.
-- Source unions are nested to respect D1's five-term compound SELECT limit.
CREATE TABLE public_meta_counts (
  kind TEXT NOT NULL,
  group_key TEXT NOT NULL,
  value TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  PRIMARY KEY(kind, group_key, value)
) WITHOUT ROWID;

-- Facets can be repeated by sources and shops. Coalesce changed entities before re-evaluating
-- their presence; do not increment a distinct-entity count for every source fact.
CREATE TABLE public_meta_entity_facets (
  entity_id INTEGER NOT NULL REFERENCES product_search_entities(id) ON DELETE CASCADE,
  facet_id TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  PRIMARY KEY(entity_id, facet_id, facet_value)
) WITHOUT ROWID;
CREATE TABLE public_meta_dirty_entities (entity_id INTEGER PRIMARY KEY);
CREATE TABLE public_meta_audit_dirty (singleton INTEGER PRIMARY KEY CHECK(singleton = 1));

-- Initial data and change capture are installed atomically, before the new reader is deployed.
INSERT INTO public_meta_entity_facets(entity_id, facet_id, facet_value)
SELECT DISTINCT m.entity_id, f.facet_id, f.facet_value
FROM product_facet_facts f
JOIN products p ON p.id = f.product_id AND p.is_active = 1
JOIN product_search_entity_offers m ON m.listing_product_id = p.id;


INSERT INTO public_meta_counts SELECT kind, group_key, value, COUNT(*) FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, p.shop_key AS value FROM products p WHERE p.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, p.manufacturer_id AS group_key, p.manufacturer AS value FROM products p WHERE p.is_active = 1 AND (p.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value FROM products p WHERE p.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value FROM products p WHERE p.is_active = 1 AND (p.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value FROM products p WHERE p.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(p.metadata_json, '')) THEN CAST(json_extract(p.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value FROM products p WHERE p.is_active = 1 AND (p.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value FROM products p WHERE p.is_active = 1 AND (p.primary_category_id = 'other'))) GROUP BY kind, group_key, value;

INSERT INTO public_meta_counts
SELECT 'category', '', category_id, COUNT(*) FROM product_search_entity_categories GROUP BY category_id;
INSERT INTO public_meta_counts
SELECT 'facet', facet_id, facet_value, COUNT(*) FROM public_meta_entity_facets GROUP BY facet_id, facet_value;
INSERT INTO public_meta_counts
SELECT 'taxonomy', '', 'migrated_shift_count', COUNT(DISTINCT entity_id)
FROM taxonomy_v3_migration_audit WHERE entity_type = 'product_primary' AND legacy_category_id <> canonical_category_id;
INSERT OR IGNORE INTO public_meta_counts
SELECT 'taxonomy', '', value, 0 FROM json_each('["active_count","unclassified_count","low_confidence_count","legacy_residue_count","legacy_other_count"]');


CREATE TRIGGER public_meta_prune_empty
AFTER UPDATE OF row_count ON public_meta_counts
WHEN NEW.row_count = 0 AND NEW.kind <> 'taxonomy'
BEGIN
DELETE FROM public_meta_counts WHERE kind = NEW.kind AND group_key = NEW.group_key AND value = NEW.value;
END;

CREATE TRIGGER public_meta_products_insert
AFTER INSERT ON products
BEGIN
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, NEW.shop_key AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, NEW.manufacturer_id AS group_key, NEW.manufacturer AS value WHERE NEW.is_active = 1 AND (NEW.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE NEW.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'other'))) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_products_delete
AFTER DELETE ON products
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, OLD.shop_key AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, OLD.manufacturer_id AS group_key, OLD.manufacturer AS value WHERE OLD.is_active = 1 AND (OLD.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE OLD.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'other')));
END;

-- Account for the attempted transition before AFTER triggers may restore manual authority.
-- The nested restoring UPDATE then reverses that delta, regardless of AFTER trigger order.
CREATE TRIGGER public_meta_products_update
BEFORE UPDATE OF shop_key, manufacturer_id, manufacturer, is_active, primary_category_id, metadata_json ON products
WHEN OLD.is_active IS NOT NEW.is_active OR (OLD.is_active = 1 AND (OLD.shop_key IS NOT NEW.shop_key OR OLD.manufacturer_id IS NOT NEW.manufacturer_id OR OLD.manufacturer IS NOT NEW.manufacturer OR OLD.primary_category_id IS NOT NEW.primary_category_id OR (CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END) IS NOT (CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END)))
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT * FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, OLD.shop_key AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, OLD.manufacturer_id AS group_key, OLD.manufacturer AS value WHERE OLD.is_active = 1 AND (OLD.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE OLD.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'other'))) EXCEPT SELECT * FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, NEW.shop_key AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, NEW.manufacturer_id AS group_key, NEW.manufacturer AS value WHERE NEW.is_active = 1 AND (NEW.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE NEW.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'other'))));
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT * FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, NEW.shop_key AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, NEW.manufacturer_id AS group_key, NEW.manufacturer AS value WHERE NEW.is_active = 1 AND (NEW.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE NEW.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE NEW.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE NEW.is_active = 1 AND (NEW.primary_category_id = 'other'))) EXCEPT SELECT * FROM (SELECT * FROM (SELECT 'shop' AS kind, '' AS group_key, OLD.shop_key AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'manufacturer' AS kind, OLD.manufacturer_id AS group_key, OLD.manufacturer AS value WHERE OLD.is_active = 1 AND (OLD.manufacturer <> '')
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'active_count' AS value WHERE OLD.is_active = 1 AND (1)
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'unclassified_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'unclassified')) UNION ALL SELECT * FROM (SELECT 'taxonomy' AS kind, '' AS group_key, 'low_confidence_count' AS value WHERE OLD.is_active = 1 AND ((CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_residue_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
UNION ALL
SELECT 'taxonomy' AS kind, '' AS group_key, 'legacy_other_count' AS value WHERE OLD.is_active = 1 AND (OLD.primary_category_id = 'other')))) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_categories_insert
AFTER INSERT ON product_search_entity_categories
BEGIN
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT 'category' AS kind, '' AS group_key, NEW.category_id AS value) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_categories_delete
AFTER DELETE ON product_search_entity_categories
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT 'category' AS kind, '' AS group_key, OLD.category_id AS value);
END;

CREATE TRIGGER public_meta_categories_update
AFTER UPDATE OF category_id ON product_search_entity_categories
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT 'category' AS kind, '' AS group_key, OLD.category_id AS value EXCEPT SELECT 'category' AS kind, '' AS group_key, NEW.category_id AS value);
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT 'category' AS kind, '' AS group_key, NEW.category_id AS value EXCEPT SELECT 'category' AS kind, '' AS group_key, OLD.category_id AS value) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_facets_insert
AFTER INSERT ON public_meta_entity_facets
BEGIN
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT 'facet' AS kind, NEW.facet_id AS group_key, NEW.facet_value AS value) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_facets_delete
AFTER DELETE ON public_meta_entity_facets
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT 'facet' AS kind, OLD.facet_id AS group_key, OLD.facet_value AS value);
END;

CREATE TRIGGER public_meta_facets_update
AFTER UPDATE OF facet_id, facet_value ON public_meta_entity_facets
BEGIN
UPDATE public_meta_counts SET row_count = row_count - 1
WHERE (kind, group_key, value) IN (SELECT 'facet' AS kind, OLD.facet_id AS group_key, OLD.facet_value AS value EXCEPT SELECT 'facet' AS kind, NEW.facet_id AS group_key, NEW.facet_value AS value);
INSERT INTO public_meta_counts(kind, group_key, value, row_count)
SELECT kind, group_key, value, 1 FROM (SELECT 'facet' AS kind, NEW.facet_id AS group_key, NEW.facet_value AS value EXCEPT SELECT 'facet' AS kind, OLD.facet_id AS group_key, OLD.facet_value AS value) WHERE 1
ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;

CREATE TRIGGER public_meta_offer_insert
AFTER INSERT ON product_search_entity_offers
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT NEW.entity_id WHERE 1 ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_offer_delete
AFTER DELETE ON product_search_entity_offers
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT OLD.entity_id WHERE 1 ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_offer_move
AFTER UPDATE OF entity_id, listing_product_id ON product_search_entity_offers
WHEN OLD.entity_id IS NOT NEW.entity_id OR OLD.listing_product_id IS NOT NEW.listing_product_id
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT OLD.entity_id UNION SELECT NEW.entity_id WHERE 1 ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_fact_insert
AFTER INSERT ON product_facet_facts
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT entity_id FROM product_search_entity_offers WHERE listing_product_id = NEW.product_id ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_fact_delete
AFTER DELETE ON product_facet_facts
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT entity_id FROM product_search_entity_offers WHERE listing_product_id = OLD.product_id ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_fact_move
AFTER UPDATE OF product_id, facet_id, facet_value ON product_facet_facts
WHEN OLD.product_id IS NOT NEW.product_id OR OLD.facet_id IS NOT NEW.facet_id OR OLD.facet_value IS NOT NEW.facet_value
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT entity_id FROM product_search_entity_offers WHERE listing_product_id IN (OLD.product_id, NEW.product_id) ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_listing_activity
AFTER UPDATE OF is_active ON products
WHEN OLD.is_active IS NOT NEW.is_active
BEGIN
INSERT INTO public_meta_dirty_entities(entity_id) SELECT entity_id FROM product_search_entity_offers WHERE listing_product_id = NEW.id ON CONFLICT(entity_id) DO NOTHING;
END;

CREATE TRIGGER public_meta_audit_insert
AFTER INSERT ON taxonomy_v3_migration_audit
BEGIN
INSERT INTO public_meta_audit_dirty(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING;
END;

CREATE TRIGGER public_meta_audit_delete
AFTER DELETE ON taxonomy_v3_migration_audit
BEGIN
INSERT INTO public_meta_audit_dirty(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING;
END;

CREATE TRIGGER public_meta_audit_update
AFTER UPDATE OF entity_type, entity_id, legacy_category_id, canonical_category_id ON taxonomy_v3_migration_audit
BEGIN
INSERT INTO public_meta_audit_dirty(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING;
END;

-- New Workers use only this bounded vocabulary view. Keep the old full aggregate available
-- for old-Worker rollback and differential verification; it is not the normal refresh path.
CREATE VIEW public_meta_incremental_aggregate AS
WITH vocabulary AS (
  SELECT kind AS facet_kind, group_key AS manufacturer_id, MIN(value) AS value, SUM(row_count) AS active_product_count
  FROM public_meta_counts WHERE kind = 'manufacturer' AND row_count > 0 GROUP BY group_key
  UNION ALL
  SELECT kind, NULL, value, row_count FROM public_meta_counts WHERE kind = 'shop' AND row_count > 0
), categories AS (
  SELECT value, row_count AS active_product_count FROM public_meta_counts WHERE kind = 'category' AND row_count > 0
), facets AS (
  SELECT group_key AS facet_id, value AS facet_value, row_count AS active_product_count
  FROM public_meta_counts WHERE kind = 'facet' AND row_count > 0
), taxonomy AS (
  SELECT MAX(CASE WHEN value = 'active_count' THEN row_count ELSE 0 END) AS active_count,
MAX(CASE WHEN value = 'unclassified_count' THEN row_count ELSE 0 END) AS unclassified_count,
MAX(CASE WHEN value = 'low_confidence_count' THEN row_count ELSE 0 END) AS low_confidence_count,
MAX(CASE WHEN value = 'legacy_residue_count' THEN row_count ELSE 0 END) AS legacy_residue_count,
MAX(CASE WHEN value = 'legacy_other_count' THEN row_count ELSE 0 END) AS legacy_other_count,
MAX(CASE WHEN value = 'migrated_shift_count' THEN row_count ELSE 0 END) AS migrated_shift_count
  FROM public_meta_counts WHERE kind = 'taxonomy'
)
SELECT json_array(
  json_object('results', (SELECT json_group_array(json_object('facet_kind', facet_kind, 'manufacturer_id', manufacturer_id, 'value', value, 'active_product_count', active_product_count)) FROM vocabulary)),
  json_object('results', (SELECT json_group_array(json_object('value', value, 'active_product_count', active_product_count)) FROM categories)),
  json_object('results', (SELECT json_group_array(json_object('facet_id', facet_id, 'facet_value', facet_value, 'active_product_count', active_product_count)) FROM facets)),
  json_object('results', (SELECT json_group_array(json_object('active_count', active_count, 'unclassified_count', CASE WHEN active_count > 0 THEN unclassified_count END, 'low_confidence_count', CASE WHEN active_count > 0 THEN low_confidence_count END, 'legacy_residue_count', CASE WHEN active_count > 0 THEN legacy_residue_count END, 'legacy_other_count', CASE WHEN active_count > 0 THEN legacy_other_count END, 'migrated_shift_count', migrated_shift_count)) FROM taxonomy))
) AS payload_json;
