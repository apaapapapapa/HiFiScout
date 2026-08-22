-- Corrections verified in the 2026-08-19 production digital-category audit.
-- Product-specific category facts live in the verified Knowledge Catalog so seller bucket changes
-- cannot silently undo them on a later crawl. The deployment repair step replays these exact
-- catalog entries immediately after this migration and refreshes the Phase 4 read model.

-- Canonical manufacturer evidence for audited products that were previously unresolved.
INSERT INTO knowledge_catalog_manufacturers(
  id, canonical_name, verification_status, source, provenance_json, created_at, updated_at
)
VALUES
  ('ch-precision', 'CH PRECISION', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('wattson-audio', 'Wattson Audio', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pathos', 'PATHOS', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('telegartner', 'Telegartner', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sotm', 'SOtM', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('luxury-precision', 'LUXURY&PRECISION', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('synergistic-research', 'Synergistic Research', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ediscreation', 'EDISCREATION', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(id) DO UPDATE SET
  canonical_name = excluded.canonical_name,
  verification_status = 'verified',
  source = excluded.source,
  provenance_json = excluded.provenance_json,
  updated_at = excluded.updated_at;

INSERT INTO knowledge_catalog_manufacturer_aliases(
  manufacturer_id, alias, normalized_alias, verification_status, source,
  provenance_json, rule_version, created_at, updated_at
)
VALUES
  ('ch-precision', 'CH PRECISION', 'chprecision', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('wattson-audio', 'Wattson Audio', 'wattsonaudio', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pathos', 'PATHOS', 'pathos', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('telegartner', 'Telegartner', 'telegartner', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sotm', 'SOtM', 'sotm', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('luxury-precision', 'LUXURY&PRECISION', 'luxuryprecision', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('synergistic-research', 'Synergistic Research', 'synergisticresearch', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ediscreation', 'EDISCREATION', 'ediscreation', 'verified', 'manual_verified', '{"reason":"approved_category_audit_2026_08_19"}', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(manufacturer_id, normalized_alias) DO UPDATE SET
  alias = excluded.alias,
  verification_status = 'verified',
  source = excluded.source,
  provenance_json = excluded.provenance_json,
  rule_version = excluded.rule_version,
  updated_at = excluded.updated_at;

DROP TABLE IF EXISTS _migration_0031_category_corrections;
CREATE TABLE _migration_0031_category_corrections (
  manufacturer_id TEXT NOT NULL,
  canonical_model TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY(manufacturer_id, normalized_model)
);

INSERT INTO _migration_0031_category_corrections(
  manufacturer_id, canonical_model, normalized_model, canonical_name, category_id
)
VALUES
  ('esoteric', 'Grandioso T1', 'GRANDIOSO T1', 'Grandioso T1', 'turntable'),
  ('ch-precision', 'D1.5 SACD/CD Transport', 'D1.5 SACD/CD TRANSPORT', 'D1.5 SACD/CD Transport', 'transport'),
  ('dcs', 'Rossini Transport', 'ROSSINI TRANSPORT', 'Rossini Transport', 'transport'),
  ('esoteric', 'Grandioso-P1X', 'GRANDIOSO-P1X', 'Grandioso P1X', 'transport'),
  ('dcs', 'Lina Network DAC', 'LINA NETWORK DAC', 'Lina Network DAC', 'network_player'),
  ('esoteric', 'Grandioso G1', 'GRANDIOSO G1', 'Grandioso G1', 'master_clock'),
  ('wattson-audio', 'Madison STREAMER', 'MADISON STREAMER', 'Madison STREAMER', 'network_player'),
  ('esoteric', 'S-05 B', 'S-05 B', 'S-05 B', 'power_amp'),
  ('esoteric', 'S-05', 'S-05', 'S-05', 'power_amp'),
  ('luxman', 'D-07X', 'D-07X', 'D-07X', 'cd_sacd_player'),
  ('pathos', 'InPol EAR with DAC WH', 'INPOL EAR WITH DAC WH', 'InPol EAR with DAC WH', 'headphone_amp'),
  ('telegartner', 'M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本', 'M12 SWITCH IE GOLD + 専用オプションケーブル2.0M ×3本', 'M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本', 'network_switch'),
  ('luxman', 'NT-07', 'NT-07', 'NT-07', 'transport'),
  ('sotm', 'sNH-10G (クロック機能及びマスタークロック入力機能モデル、50Ω、12V)', 'SNH-10G (クロック機能及びマスタークロック入力機能モデル、50Ω、12V)', 'sNH-10G 50Ω', 'network_switch'),
  ('sotm', 'sNH-10G (クロック機能及びマスタークロック入力機能モデル、75Ω、12V)', 'SNH-10G (クロック機能及びマスタークロック入力機能モデル、75Ω、12V)', 'sNH-10G 75Ω', 'network_switch'),
  ('sotm', 'sNH-10G/masterclock (12Vdc) スペシャルエディション(銀線仕様)', 'SNH-10G/MASTERCLOCK (12VDC) スペシャルエディション(銀線仕様)', 'sNH-10G masterclock 12Vdc スペシャルエディション', 'network_switch'),
  ('esoteric', 'DV-50S', 'DV-50S', 'DV-50S', 'cd_sacd_player'),
  ('luxury-precision', 'PCM1792A DACカード E7専用', 'PCM1792A DACカード E7専用', 'PCM1792A DACカード E7専用', 'other_accessory'),
  ('marantz', 'NR1200', 'NR1200', 'NR1200', 'integrated_amp'),
  ('sony', 'MDS-JE700', 'MDS-JE700', 'MDS-JE700', 'other'),
  ('denon', 'DN-S1000', 'DN-S1000', 'DN-S1000', 'dj_dtm'),
  ('synergistic-research', 'Network Router UEF', 'NETWORK ROUTER UEF', 'Network Router UEF', 'router'),
  ('ediscreation', 'SILENT SWITCH OCXO “JAPAN EXCLUSIVE MODEL”', 'SILENT SWITCH OCXO “JAPAN EXCLUSIVE MODEL”', 'SILENT SWITCH OCXO JAPAN EXCLUSIVE MODEL', 'network_switch'),
  ('ediscreation', 'Silent Switch OCXO JPEM', 'SILENT SWITCH OCXO JPEM', 'Silent Switch OCXO JPEM', 'network_switch'),
  ('ediscreation', 'SILENT SWITCH OCXO JPSM', 'SILENT SWITCH OCXO JPSM', 'SILENT SWITCH OCXO JPSM', 'network_switch'),
  ('ediscreation', 'SilentSwitch OCXO JPN STD [SILENT SWITCH OCXO JPSM]', 'SILENTSWITCH OCXO JPN STD [SILENT SWITCH OCXO JPSM]', 'SilentSwitch OCXO JPN STD', 'network_switch'),
  ('ediscreation', 'SILENT SWITCH OCXO 2 JPSM', 'SILENT SWITCH OCXO 2 JPSM', 'SILENT SWITCH OCXO 2 JPSM', 'network_switch'),
  ('ediscreation', 'FIBER BOX 2 “JAPAN EXCLUSIVE MODEL”', 'FIBER BOX 2 “JAPAN EXCLUSIVE MODEL”', 'FIBER BOX 2 JAPAN EXCLUSIVE MODEL', 'optical_isolator'),
  ('ediscreation', 'Fiber Box 2 JPSM', 'FIBER BOX 2 JPSM', 'Fiber Box 2 JPSM', 'optical_isolator');

-- Insert missing verified products, then make the correction authoritative for rows that already
-- existed in the catalog with an incorrect category.
INSERT INTO knowledge_catalog_products(
  manufacturer_id, canonical_model, normalized_model, canonical_name,
  lifecycle_status, verification_status, review_status,
  first_verified_at, last_verified_at, last_reviewed_at, created_at, updated_at
)
SELECT
  c.manufacturer_id,
  c.canonical_model,
  c.normalized_model,
  c.canonical_name,
  'unknown',
  'verified',
  'current',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _migration_0031_category_corrections c
WHERE NOT EXISTS (
  SELECT 1
  FROM knowledge_catalog_products kp
  WHERE kp.manufacturer_id = c.manufacturer_id
    AND kp.normalized_model = c.normalized_model
);

UPDATE knowledge_catalog_products
SET verification_status = 'verified',
    review_status = 'current',
    last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1
  FROM _migration_0031_category_corrections c
  WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
    AND c.normalized_model = knowledge_catalog_products.normalized_model
);

DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT kp.id
  FROM knowledge_catalog_products kp
  JOIN _migration_0031_category_corrections c
    ON c.manufacturer_id = kp.manufacturer_id
   AND c.normalized_model = kp.normalized_model
);

INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT kp.id, c.category_id, 1
FROM knowledge_catalog_products kp
JOIN _migration_0031_category_corrections c
  ON c.manufacturer_id = kp.manufacturer_id
 AND c.normalized_model = kp.normalized_model;

-- The FOR MUSIC listing misspells Grandioso as "Granodioso". Preserve the seller evidence but
-- attach that exact presentation as a verified model alias to the correctly named catalog product.
INSERT OR IGNORE INTO knowledge_catalog_aliases(
  product_id, alias, normalized_alias, alias_type, created_at
)
SELECT
  kp.id,
  'Granodioso G1',
  'GRANODIOSO G1',
  'model',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
WHERE kp.manufacturer_id = 'esoteric'
  AND kp.normalized_model = 'GRANDIOSO G1';

-- One marker lets the deploy repair step select exactly this approved audit set without embedding
-- product IDs (which differ between environments) in operational code.
INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT
  kp.id,
  'manual_verified',
  'manual://approved-category-audit/2026-08-19',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  '',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
JOIN _migration_0031_category_corrections c
  ON c.manufacturer_id = kp.manufacturer_id
 AND c.normalized_model = kp.normalized_model;

DROP TABLE _migration_0031_category_corrections;
