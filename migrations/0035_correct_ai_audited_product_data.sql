-- Evidence-backed corrections from the exhaustive 2026-08-21 production product audit.
--
-- The audit ran only after Manufacturer / Model / Category / Identity resolver replay and search
-- projection work had fully converged, then inspected every active production listing together with
-- the verified Knowledge Catalog. These corrections are intentionally narrow: only product facts
-- confirmed by manufacturer-official material are promoted to manual authority. Unknown or merely
-- suspicious rows remain unresolved rather than being guessed.

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
  -- Mark Levinson No.534: manufacturer describes it as a dual-monaural power amplifier.
  ('mark-levinson', 'No534', 'NO534', 'No534', 'power_amp'),

  -- DENON products that inherited unrelated turntable navigation from official pages.
  ('denon', 'PMA-900HNE', 'PMA-900HNE', 'PMA-900HNE', 'integrated_amp'),
  ('denon', 'DENON HOME AMP [DENONHOMEAMPK]', 'DENON HOME AMP [DENONHOMEAMPK]', 'DENON HOME AMP [DENONHOMEAMPK]', 'integrated_amp'),
  ('denon', 'HOME AMP', 'HOME AMP', 'HOME AMP', 'integrated_amp'),
  ('denon', 'PerL Pro', 'PERL PRO', 'PerL Pro', 'btw_earphone'),
  ('denon', 'PerL Pro/ブラック', 'PERL PRO/ブラック', 'PerL Pro/ブラック', 'btw_earphone'),
  ('denon', 'PerL Pro/ホワイト', 'PERL PRO/ホワイト', 'PerL Pro/ホワイト', 'btw_earphone'),

  -- Yamaha product pages/manuals identify these as headphones / AV receiver respectively.
  ('yamaha', 'YH-5000SE', 'YH-5000SE', 'YH-5000SE', 'wired_headphone'),
  ('yamaha', 'RX-A3010', 'RX-A3010', 'RX-A3010', 'av_amp'),

  -- STAX earspeakers were contaminated by the site's cable navigation.
  ('stax', 'SR-003', 'SR-003', 'SR-003', 'wired_earphone'),
  ('stax', 'SR-L500 MK2', 'SR-L500 MK2', 'SR-L500 MK2', 'wired_headphone'),
  ('stax', 'SR-L700', 'SR-L700', 'SR-L700', 'wired_headphone'),
  ('stax', 'SR-L700 MK2', 'SR-L700 MK2', 'SR-L700 MK2', 'wired_headphone'),

  -- FOSTEX manufacturer pages identify these product types explicitly.
  ('fostex', 'CW250B', 'CW250B', 'CW250B', 'subwoofer'),
  ('fostex', 'CW250D', 'CW250D', 'CW250D', 'subwoofer'),
  ('fostex', 'ET-RP4.4BL', 'ET-RP4.4BL', 'ET-RP4.4BL', 'cable_other'),
  ('fostex', 'TH1000RP', 'TH1000RP', 'TH1000RP', 'wired_headphone'),
  ('fostex', 'TH1100RP', 'TH1100RP', 'TH1100RP', 'wired_headphone'),
  ('fostex', 'T60RP', 'T60RP', 'T60RP', 'wired_headphone'),
  ('fostex', 'T60RPmk2ai', 'T60RPMK2AI', 'T60RPmk2ai', 'wired_headphone'),
  ('fostex', 'TH909', 'TH909', 'TH909', 'wired_headphone'),
  ('fostex', 'PM0.1e', 'PM0.1E', 'PM0.1e', 'active_speaker'),
  ('fostex', 'HP-A4', 'HP-A4', 'HP-A4', 'headphone_amp'),

  -- audio-technica explicitly labels these as wireless earphone/headphone products.
  ('audio-technica', 'ATH-TWX9', 'ATH-TWX9', 'ATH-TWX9', 'btw_earphone'),
  ('audio-technica', 'ATH-DWL550', 'ATH-DWL550', 'ATH-DWL550', 'btw_headphone'),

  -- LUXMAN's own product archive gives the component type for each of these models.
  ('luxman', 'C-600f', 'C-600F', 'C-600f', 'pre_amp'),
  ('luxman', 'C-900u', 'C-900U', 'C-900u', 'pre_amp'),
  ('luxman', 'P-700u', 'P-700U', 'P-700u', 'headphone_amp'),
  ('luxman', 'MQ68C', 'MQ68C', 'MQ68C', 'power_amp'),
  ('luxman', 'D-380', 'D-380', 'D-380', 'cd_sacd_player'),
  ('luxman', 'D-03R', 'D-03R', 'D-03R', 'cd_sacd_player'),
  ('luxman', 'E-200', 'E-200', 'E-200', 'phono_eq'),
  ('luxman', 'M-7i', 'M-7I', 'M-7i', 'power_amp'),
  ('luxman', 'M300', 'M300', 'M300', 'power_amp'),
  ('luxman', 'PD441+FR-54', 'PD441+FR-54', 'PD441+FR-54', 'turntable');

-- Every correction already exists in production today, but keep the migration idempotent and safe
-- for fresh environments where only a subset of the operational catalog has been discovered.
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
FROM _migration_0035_product_corrections c
WHERE NOT EXISTS (
  SELECT 1
  FROM knowledge_catalog_products kp
  WHERE kp.manufacturer_id = c.manufacturer_id
    AND kp.normalized_model = c.normalized_model
);

UPDATE knowledge_catalog_products
SET canonical_model = (
      SELECT c.canonical_model
      FROM _migration_0035_product_corrections c
      WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
        AND c.normalized_model = knowledge_catalog_products.normalized_model
    ),
    canonical_name = (
      SELECT c.canonical_name
      FROM _migration_0035_product_corrections c
      WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
        AND c.normalized_model = knowledge_catalog_products.normalized_model
    ),
    verification_status = 'verified',
    review_status = 'current',
    last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1
  FROM _migration_0035_product_corrections c
  WHERE c.manufacturer_id = knowledge_catalog_products.manufacturer_id
    AND c.normalized_model = knowledge_catalog_products.normalized_model
);

DELETE FROM knowledge_catalog_product_categories
WHERE product_id IN (
  SELECT kp.id
  FROM knowledge_catalog_products kp
  JOIN _migration_0035_product_corrections c
    ON c.manufacturer_id = kp.manufacturer_id
   AND c.normalized_model = kp.normalized_model
);

INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT kp.id, c.category_id, 1
FROM knowledge_catalog_products kp
JOIN _migration_0035_product_corrections c
  ON c.manufacturer_id = kp.manufacturer_id
 AND c.normalized_model = kp.normalized_model;

-- Existing verified names also contain two repeatable classes of page-chrome corruption: large
-- OneTrust/CSS dumps on DENON pages and inline SVG style text on audio-technica pages. These rows
-- already have verified canonical models, so the model is the safest canonical display fallback.
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

-- Marker consumed by the post-deploy manual-category-authority repair. Product IDs are deliberately
-- not embedded because they differ between environments.
INSERT OR IGNORE INTO knowledge_catalog_sources(
  product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
)
SELECT
  kp.id,
  'manual_verified',
  'manual://approved-product-audit/2026-08-21',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  '',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM knowledge_catalog_products kp
JOIN _migration_0035_product_corrections c
  ON c.manufacturer_id = kp.manufacturer_id
 AND c.normalized_model = kp.normalized_model;

DROP TABLE _migration_0035_product_corrections;