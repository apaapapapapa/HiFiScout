-- Data-quality remediation §5: product naming/model identity.
-- Seller evidence (raw_manufacturer/raw_model) remains immutable; derived fields are replayed.

-- N-1: Hifido's record/CD box-set department is outside HiFiScout's hardware scope.
UPDATE products
SET is_active = 0,
    last_changed_at = CURRENT_TIMESTAMP
WHERE is_active = 1
  AND shop_key = 'hifido'
  AND (
    source_id LIKE '26-20368-%'
    OR title LIKE '%枚セット%'
    OR title LIKE '%枚組%'
  );

-- N-4: remove meaningless seller placeholders from public manufacturer presentation/filtering.
UPDATE products
SET manufacturer = '',
    manufacturer_id = '',
    canonical_manufacturer_id = '',
    normalized_raw_manufacturer = '',
    manufacturer_resolution_status = 'unresolved',
    manufacturer_resolution_method = 'none',
    manufacturer_resolution_confidence = 'none',
    remediation_projection_required = 1
WHERE is_active = 1
  AND (
    TRIM(manufacturer) IN ('不明', 'メーカー不明', 'その他', 'ノーブランド', '不明 フメイ')
    OR TRIM(raw_manufacturer) IN ('不明', 'メーカー不明', 'その他', 'ノーブランド', '不明 フメイ')
    OR TRIM(manufacturer) LIKE '不明 %'
    OR TRIM(raw_manufacturer) LIKE '不明 %'
  );

-- N-2/N-3/N-5: aliases and resolver semantics changed. Re-enter the existing bounded replay path
-- instead of rewriting derived IDs/models in SQL. Manufacturer replay also re-runs Model Resolution.
-- The replay recomputes deterministic public manufacturer_id values while canonical ids remain verified-only.
UPDATE products
SET manufacturer_resolver_version = 0
WHERE is_active = 1;