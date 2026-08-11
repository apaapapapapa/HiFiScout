-- Product category remains one canonical leaf. product_categories is the search closure.
UPDATE products
SET primary_category_id = CASE primary_category_id
      WHEN 'network_transport' THEN 'network_player'
      WHEN 'speaker' THEN 'speaker_other'
      WHEN 'accessory' THEN 'other_accessory'
      ELSE primary_category_id
    END,
    category_ids = json_array(CASE primary_category_id
      WHEN 'network_transport' THEN 'network_player'
      WHEN 'speaker' THEN 'speaker_other'
      WHEN 'accessory' THEN 'other_accessory'
      ELSE primary_category_id
    END),
    category = CASE primary_category_id
      WHEN 'network_transport' THEN 'ネットワークプレーヤー'
      WHEN 'speaker' THEN 'その他スピーカー'
      WHEN 'accessory' THEN 'その他アクセサリー'
      ELSE category
    END;

DELETE FROM product_categories;

INSERT OR IGNORE INTO product_categories(product_id, category_id)
SELECT id, primary_category_id FROM products;

INSERT OR IGNORE INTO product_categories(product_id, category_id)
SELECT id,
  CASE
    WHEN primary_category_id IN ('integrated_amp','pre_amp','power_amp','headphone_amp') THEN 'amplifier'
    WHEN primary_category_id IN ('dac','network_player','cd_sacd_player','dap') THEN 'digital'
    WHEN primary_category_id IN ('turntable','tonearm','cartridge','phono_eq') THEN 'analog'
    WHEN primary_category_id IN ('speaker_bookshelf','speaker_floorstanding','subwoofer','speaker_other') THEN 'speaker'
    WHEN primary_category_id IN ('headphone','earphone') THEN 'headphone_group'
    WHEN primary_category_id IN ('cable','rack','power_accessory','vacuum_tube','other_accessory') THEN 'accessories'
    ELSE NULL
  END
FROM products
WHERE primary_category_id IN (
  'integrated_amp','pre_amp','power_amp','headphone_amp',
  'dac','network_player','cd_sacd_player','dap',
  'turntable','tonearm','cartridge','phono_eq',
  'speaker_bookshelf','speaker_floorstanding','subwoofer','speaker_other',
  'headphone','earphone','cable','rack','power_accessory','vacuum_tube','other_accessory'
);

DELETE FROM product_categories WHERE category_id IS NULL;

CREATE TABLE IF NOT EXISTS product_feature_facts (
  product_id INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('present', 'absent')),
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  verified_at TEXT,
  PRIMARY KEY(product_id, feature_id, source),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_feature_facts_lookup
  ON product_feature_facts(feature_id, state, product_id);
