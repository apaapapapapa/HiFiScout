-- Evidence-backed corrections from the exhaustive 2026-08-21 production product audit.
-- Unknown/unclassified rows remain unresolved unless deterministic seller or manufacturer evidence exists.

-- Verified manufacturer spellings observed in production. Keep The Chord Company distinct from
-- Chord Electronics: the two manufacturers must never share a canonical manufacturer id.
INSERT INTO knowledge_catalog_manufacturers(
  id, canonical_name, verification_status, source, provenance_json, created_at, updated_at
)
VALUES
  ('jbl', 'JBL', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('focal', 'Focal', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pioneer', 'Pioneer', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('chord-company', 'The Chord Company', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('elac', 'ELAC', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  ('jbl', 'JBL Professional', 'jblprofessional', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('focal', 'FOCAL PROFESSIONAL', 'focalprofessional', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pioneer', 'Pioneer DJ', 'pioneerdj', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('chord-company', 'The Chord Company', 'chordcompany', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('elac', 'ELAC', 'elac', 'verified', 'manual_verified', '{"reason":"ai_product_audit_2026_08_21"}', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(manufacturer_id, normalized_alias) DO UPDATE SET
  alias = excluded.alias,
  verification_status = 'verified',
  source = excluded.source,
  provenance_json = excluded.provenance_json,
  rule_version = excluded.rule_version,
  updated_at = excluded.updated_at;

DROP TABLE IF EXISTS _migration_0035_product_corrections;
CREATE TABLE _migration_0035_product_corrections (
  manufacturer_id TEXT NOT NULL,
  canonical_model TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY(manufacturer_id, normalized_model)
);

INSERT INTO _migration_0035_product_corrections(
  manufacturer_id, canonical_model, normalized_model, canonical_name, category_id
)
VALUES
  ('audio-technica', 'AT-PEQ20', 'AT-PEQ20', 'AT-PEQ20', 'phono_eq'),
  ('audio-technica', 'AT-PEQ3', 'AT-PEQ3', 'AT-PEQ3', 'phono_eq'),
  ('audio-technica', 'AT6302', 'AT6302', 'AT6302', 'other_accessory'),
  ('audio-technica', 'AT6303', 'AT6303', 'AT6303', 'other_accessory'),
  ('audio-technica', 'AT6304', 'AT6304', 'AT6304', 'other_accessory'),
  ('audio-technica', 'ATH-A1000Z', 'ATH-A1000Z', 'ATH-A1000Z', 'wired_headphone'),
  ('audio-technica', 'ATH-A2000Z', 'ATH-A2000Z', 'ATH-A2000Z', 'wired_headphone'),
  ('audio-technica', 'ATH-A900Z', 'ATH-A900Z', 'ATH-A900Z', 'wired_headphone'),
  ('audio-technica', 'ATH-AD500X', 'ATH-AD500X', 'ATH-AD500X', 'wired_headphone'),
  ('audio-technica', 'ATH-ADX5000', 'ATH-ADX5000', 'ATH-ADX5000', 'wired_headphone'),
  ('audio-technica', 'ATH-AWKG', 'ATH-AWKG', 'ATH-AWKG', 'wired_headphone'),
  ('audio-technica', 'ATH-AWKT', 'ATH-AWKT', 'ATH-AWKT', 'wired_headphone'),
  ('audio-technica', 'ATH-CKS1100X', 'ATH-CKS1100X', 'ATH-CKS1100X', 'wired_earphone'),
  ('audio-technica', 'ATH-DWL550', 'ATH-DWL550', 'ATH-DWL550', 'btw_headphone'),
  ('audio-technica', 'ATH-E40', 'ATH-E40', 'ATH-E40', 'wired_earphone'),
  ('audio-technica', 'ATH-ESW950', 'ATH-ESW950', 'ATH-ESW950', 'wired_headphone'),
  ('audio-technica', 'ATH-R70x', 'ATH-R70X', 'ATH-R70x', 'wired_headphone'),
  ('audio-technica', 'ATH-TWX9', 'ATH-TWX9', 'ATH-TWX9', 'btw_earphone'),
  ('audio-technica', 'ATH-WB2022', 'ATH-WB2022', 'ATH-WB2022', 'wired_headphone'),
  ('denon', 'AH-D5200', 'AH-D5200', 'AH-D5200', 'wired_headphone'),
  ('denon', 'DENON HOME AMP [DENONHOMEAMPK]', 'DENON HOME AMP [DENONHOMEAMPK]', 'DENON HOME AMP [DENONHOMEAMPK]', 'integrated_amp'),
  ('denon', 'DHT-S217', 'DHT-S217', 'DHT-S217', 'other'),
  ('denon', 'DHT-S517', 'DHT-S517', 'DHT-S517', 'other'),
  ('denon', 'HOME AMP', 'HOME AMP', 'HOME AMP', 'integrated_amp'),
  ('denon', 'PMA-900HNE', 'PMA-900HNE', 'PMA-900HNE', 'integrated_amp'),
  ('denon', 'PerL Pro', 'PERL PRO', 'PerL Pro', 'btw_earphone'),
  ('denon', 'PerL Pro/ブラック', 'PERL PRO/ブラック', 'PerL Pro/ブラック', 'btw_earphone'),
  ('denon', 'PerL Pro/ホワイト', 'PERL PRO/ホワイト', 'PerL Pro/ホワイト', 'btw_earphone'),
  ('fostex', 'CW200A', 'CW200A', 'CW200A', 'subwoofer'),
  ('fostex', 'CW250B', 'CW250B', 'CW250B', 'subwoofer'),
  ('fostex', 'CW250D', 'CW250D', 'CW250D', 'subwoofer'),
  ('fostex', 'ET-RP4.4BL', 'ET-RP4.4BL', 'ET-RP4.4BL', 'cable_other'),
  ('fostex', 'FE-103', 'FE-103', 'FE-103', 'other'),
  ('fostex', 'FE103', 'FE103', 'FE103', 'other'),
  ('fostex', 'FE108EΣ', 'FE108EΣ', 'FE108EΣ', 'other'),
  ('fostex', 'FX120', 'FX120', 'FX120', 'other'),
  ('fostex', 'GS103A', 'GS103A', 'GS103A', 'other'),
  ('fostex', 'HP-A4', 'HP-A4', 'HP-A4', 'headphone_amp'),
  ('fostex', 'PC200USB', 'PC200USB', 'PC200USB', 'integrated_amp'),
  ('fostex', 'PM0.1e', 'PM0.1E', 'PM0.1e', 'active_speaker'),
  ('fostex', 'T60RP', 'T60RP', 'T60RP', 'wired_headphone'),
  ('fostex', 'T60RP 50TH ANNIVERSARY', 'T60RP 50TH ANNIVERSARY', 'T60RP 50TH ANNIVERSARY', 'wired_headphone'),
  ('fostex', 'T60RPmk2ai', 'T60RPMK2AI', 'T60RPmk2ai', 'wired_headphone'),
  ('fostex', 'T90A', 'T90A', 'T90A', 'other'),
  ('fostex', 'TH1000RP', 'TH1000RP', 'TH1000RP', 'wired_headphone'),
  ('fostex', 'TH1100RP', 'TH1100RP', 'TH1100RP', 'wired_headphone'),
  ('fostex', 'TH900 mk2', 'TH900 MK2', 'TH900 mk2', 'wired_headphone'),
  ('fostex', 'TH909', 'TH909', 'TH909', 'wired_headphone'),
  ('kef', 'LS50 Meta', 'LS50 META', 'LS50 Meta', 'speaker_bookshelf'),
  ('luxman', 'C-600f', 'C-600F', 'C-600f', 'pre_amp'),
  ('luxman', 'C-900u', 'C-900U', 'C-900u', 'pre_amp'),
  ('luxman', 'D-03R', 'D-03R', 'D-03R', 'cd_sacd_player'),
  ('luxman', 'D-380', 'D-380', 'D-380', 'cd_sacd_player'),
  ('luxman', 'E-200', 'E-200', 'E-200', 'phono_eq'),
  ('luxman', 'JPA-17000', 'JPA-17000', 'JPA-17000', 'cable_other'),
  ('luxman', 'JPY-10', 'JPY-10', 'JPY-10', 'cable_other'),
  ('luxman', 'M-7i', 'M-7I', 'M-7i', 'power_amp'),
  ('luxman', 'M300', 'M300', 'M300', 'power_amp'),
  ('luxman', 'MQ68C', 'MQ68C', 'MQ68C', 'power_amp'),
  ('luxman', 'P-700u', 'P-700U', 'P-700u', 'headphone_amp'),
  ('luxman', 'PD441+FR-54', 'PD441+FR-54', 'PD441+FR-54', 'turntable'),
  ('mark-levinson', 'No534', 'NO534', 'No534', 'power_amp'),
  ('mcintosh', 'MC240', 'MC240', 'MC240', 'power_amp'),
  ('sony', 'SS-CS5M2', 'SS-CS5M2', 'SS-CS5M2', 'speaker_bookshelf'),
  ('stax', 'SR-003', 'SR-003', 'SR-003', 'wired_earphone'),
  ('stax', 'SR-L500 MK2', 'SR-L500 MK2', 'SR-L500 MK2', 'wired_headphone'),
  ('stax', 'SR-L700', 'SR-L700', 'SR-L700', 'wired_headphone'),
  ('stax', 'SR-L700 MK2', 'SR-L700 MK2', 'SR-L700 MK2', 'wired_headphone'),
  ('yamaha', 'CD-N500', 'CD-N500', 'CD-N500', 'network_player'),
  ('yamaha', 'NS-B330', 'NS-B330', 'NS-B330', 'speaker_bookshelf'),
  ('yamaha', 'NS-C120', 'NS-C120', 'NS-C120', 'center_speaker'),
  ('yamaha', 'NS-C210', 'NS-C210', 'NS-C210', 'center_speaker'),
  ('yamaha', 'NS-C225', 'NS-C225', 'NS-C225', 'center_speaker'),
  ('yamaha', 'NS-F350', 'NS-F350', 'NS-F350', 'speaker_floorstanding'),
  ('yamaha', 'NS-F500', 'NS-F500', 'NS-F500', 'speaker_floorstanding'),
  ('yamaha', 'RX-A3010', 'RX-A3010', 'RX-A3010', 'av_amp'),
  ('yamaha', 'SR-X40A', 'SR-X40A', 'SR-X40A', 'other'),
  ('yamaha', 'YH-5000SE', 'YH-5000SE', 'YH-5000SE', 'wired_headphone'),
  ('yamaha', 'YSP-2700', 'YSP-2700', 'YSP-2700', 'other'),
  ('yamaha', 'YST-SW90', 'YST-SW90', 'YST-SW90', 'subwoofer');

INSERT INTO knowledge_catalog_products(
  manufacturer_id, canonical_model, normalized_model, canonical_name,
  lifecycle_status, verification_status, review_status,
  first_verified_at, last_verified_at, last_reviewed_at, created_at, updated_at
)
SELECT
  c.manufacturer_id, c.canonical_model, c.normalized_model, c.canonical_name,
  'unknown', 'verified', 'current',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _migration_0035_product_corrections c
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_catalog_products kp
  WHERE kp.manufacturer_id = c.manufacturer_id AND kp.normalized_model = c.normalized_model
);

UPDATE knowledge_catalog_products
SET canonical_model = (
      SELECT c.canonical_model FROM _migration_0035_product_corrections c
      WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
        AND c.normalized_model = knowledge_catalog_products.normalized_model
    ),
    canonical_name = (
      SELECT c.canonical_name FROM _migration_0035_product_corrections c
      WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
        AND c.normalized_model = knowledge_catalog_products.normalized_model
    ),
    verification_status = 'verified', review_status = 'current',
    last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM _migration_0035_product_corrections c
  WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
    AND c.normalized_model = knowledge_catalog_products.normalized_model
);

DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT kp.id FROM knowledge_catalog_products kp
  JOIN _migration_0035_product_corrections c
    ON c.manufacturer_id = kp.manufacturer_id AND c.normalized_model = kp.normalized_model
);

INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT kp.id, c.category_id, 1
FROM knowledge_catalog_products kp
JOIN _migration_0035_product_corrections c
  ON c.manufacturer_id = kp.manufacturer_id AND c.normalized_model = kp.normalized_model;

-- Accuphase's manufacturer home page was accidentally promoted as a product named "Accuphase".
-- Reject it rather than inventing a category for a non-product catalog row.
UPDATE knowledge_catalog_products
SET verification_status = 'rejected', review_status = 'current',
    last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE manufacturer_id = 'accuphase' AND normalized_model = 'ACCUPHASE';
DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT id FROM knowledge_catalog_products
  WHERE manufacturer_id = 'accuphase' AND normalized_model = 'ACCUPHASE'
);

-- Existing verified names contain repeatable page-chrome contamination (OneTrust/CSS/navigation).
-- For a verified product, the verified model is the conservative display fallback.
UPDATE knowledge_catalog_products
SET canonical_name = canonical_model,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE verification_status = 'verified'
  AND (
    length(canonical_name) > 240
    OR canonical_name LIKE '%OptanonWrapper%'
    OR canonical_name LIKE '.st0{fill:%'
    OR canonical_name = 'Accuphase Laboratory, Inc.'
    OR canonical_name = 'AVENTAGE展示店一覧'
    OR canonical_name = 'HiFiコンポーネント展示店一覧'
    OR canonical_name = 'フラッグシップ 5000シリーズ展示店一覧'
  );

-- Marker consumed by the post-deploy approved-audit replay. Product ids are environment-specific.
INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT
  kp.id, 'manual_verified', 'manual://approved-product-audit/2026-08-21',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '', 'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
JOIN _migration_0035_product_corrections c
  ON c.manufacturer_id = kp.manufacturer_id AND c.normalized_model = kp.normalized_model;

DROP TABLE _migration_0035_product_corrections;
