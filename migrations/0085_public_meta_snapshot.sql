-- Only the scheduled refresher reads this catalog-wide aggregate. HTTP reads the singleton
-- snapshot below. Counts retain their existing units: shop/manufacturer count listings;
-- category/facet count distinct search entities. Keep taxonomy changes in this view too.
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

CREATE TABLE public_meta_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  generated_at TEXT NOT NULL
);

-- One initial aggregation makes rollout safe before the new cron runs. The previous Worker can
-- continue writing products during deployment; later refreshes read the live tables atomically.
INSERT INTO public_meta_snapshot (singleton, payload_json, generated_at)
SELECT 1, payload_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM public_meta_aggregate;
