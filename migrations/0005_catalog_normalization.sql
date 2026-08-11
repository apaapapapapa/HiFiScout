ALTER TABLE products ADD COLUMN raw_manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN manufacturer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN raw_category TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN primary_category_id TEXT NOT NULL DEFAULT 'other';
ALTER TABLE products ADD COLUMN category_ids TEXT NOT NULL DEFAULT '["other"]';
ALTER TABLE products ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (classification_status IN ('classified', 'unclassified'));
ALTER TABLE products ADD COLUMN search_aliases TEXT NOT NULL DEFAULT '';

UPDATE products
SET raw_manufacturer = manufacturer,
    manufacturer_id = CASE lower(trim(manufacturer))
      WHEN 'luxman' THEN 'luxman'
      WHEN 'ラックスマン' THEN 'luxman'
      WHEN 'accuphase' THEN 'accuphase'
      WHEN 'アキュフェーズ' THEN 'accuphase'
      WHEN 'tad' THEN 'tad'
      WHEN 'technical audio devices' THEN 'tad'
      WHEN 'b&w' THEN 'bowers-wilkins'
      WHEN 'bowers & wilkins' THEN 'bowers-wilkins'
      WHEN 'bowers and wilkins' THEN 'bowers-wilkins'
      WHEN 'bowers wilkins' THEN 'bowers-wilkins'
      WHEN 'denon' THEN 'denon'
      WHEN 'marantz' THEN 'marantz'
      WHEN 'esoteric' THEN 'esoteric'
      WHEN 'yamaha' THEN 'yamaha'
      WHEN 'technics' THEN 'technics'
      WHEN 'sony' THEN 'sony'
      WHEN 'pioneer' THEN 'pioneer'
      WHEN 'mcintosh' THEN 'mcintosh'
      WHEN 'kef' THEN 'kef'
      WHEN 'jbl' THEN 'jbl'
      WHEN 'tannoy' THEN 'tannoy'
      WHEN 'focal' THEN 'focal'
      WHEN 'dali' THEN 'dali'
      WHEN 'sonus faber' THEN 'sonus-faber'
      WHEN 'dynaudio' THEN 'dynaudio'
      WHEN 'monitor audio' THEN 'monitor-audio'
      WHEN 'audio-technica' THEN 'audio-technica'
      WHEN 'audio technica' THEN 'audio-technica'
      WHEN 'ortofon' THEN 'ortofon'
      WHEN 'stax' THEN 'stax'
      WHEN 'final' THEN 'final'
      WHEN 'final audio' THEN 'final'
      WHEN 'sennheiser' THEN 'sennheiser'
      WHEN 'fostex' THEN 'fostex'
      WHEN 'ifi' THEN 'ifi-audio'
      WHEN 'ifi audio' THEN 'ifi-audio'
      WHEN 'ifi audio japan' THEN 'ifi-audio'
      WHEN 'dcs' THEN 'dcs'
      WHEN 'lumin' THEN 'lumin'
      WHEN 'aurender' THEN 'aurender'
      WHEN 'soulnote' THEN 'soulnote'
      WHEN 'gustard' THEN 'gustard'
      WHEN 'bricasti' THEN 'bricasti'
      WHEN 'bricasti design' THEN 'bricasti'
      WHEN 'mola mola' THEN 'mola-mola'
      WHEN 'linn' THEN 'linn'
      WHEN 'naim' THEN 'naim'
      WHEN 'chord' THEN 'chord'
      WHEN 'chord electronics' THEN 'chord'
      WHEN 'ibasso' THEN 'ibasso-audio'
      WHEN 'ibasso audio' THEN 'ibasso-audio'
      WHEN 'moondrop' THEN 'moondrop'
      ELSE lower(
        replace(replace(replace(replace(replace(replace(replace(replace(
          trim(manufacturer), ' ', ''), '-', ''), '&', ''), '/', ''), '.', ''), ',', ''), '(', ''), ')', '')
      )
    END,
    raw_category = category,
    primary_category_id = CASE category
      WHEN 'スピーカー' THEN 'speaker'
      WHEN 'プリメインアンプ' THEN 'integrated_amp'
      WHEN 'プリアンプ' THEN 'pre_amp'
      WHEN 'コントロールアンプ' THEN 'pre_amp'
      WHEN 'パワーアンプ' THEN 'power_amp'
      WHEN 'ヘッドホンアンプ' THEN 'headphone_amp'
      WHEN 'DAC' THEN 'dac'
      WHEN 'D/Aコンバーター' THEN 'dac'
      WHEN 'D/Aコンバータ' THEN 'dac'
      WHEN 'DAコンバーター' THEN 'dac'
      WHEN 'DAコンバータ' THEN 'dac'
      WHEN 'ネットワーク' THEN 'network_player'
      WHEN 'ネットワークプレーヤー' THEN 'network_player'
      WHEN 'ネットワークプレイヤー' THEN 'network_player'
      WHEN 'ネットワークトランスポート' THEN 'network_transport'
      WHEN 'CD/SACDプレーヤー' THEN 'cd_sacd_player'
      WHEN 'CDプレーヤー' THEN 'cd_sacd_player'
      WHEN 'SACDプレーヤー' THEN 'cd_sacd_player'
      WHEN 'SACD/CDプレーヤー' THEN 'cd_sacd_player'
      WHEN 'レコードプレーヤー' THEN 'turntable'
      WHEN 'ターンテーブル' THEN 'turntable'
      WHEN 'トーンアーム' THEN 'tonearm'
      WHEN 'カートリッジ' THEN 'cartridge'
      WHEN 'フォノイコライザー' THEN 'phono_eq'
      WHEN 'イヤホン' THEN 'earphone'
      WHEN 'ヘッドホン' THEN 'headphone'
      WHEN 'DAP' THEN 'dap'
      WHEN 'DAP・ヘッドホンアンプ' THEN 'dap'
      WHEN 'DJ機器・DTM' THEN 'dj_dtm'
      WHEN 'ケーブル' THEN 'cable'
      WHEN 'ケーブル・アクセサリー' THEN 'accessory'
      WHEN 'スピーカーアクセサリー' THEN 'accessory'
      WHEN 'アクセサリー' THEN 'accessory'
      WHEN 'ラック' THEN 'rack'
      WHEN 'オーディオラック' THEN 'rack'
      WHEN '真空管' THEN 'vacuum_tube'
      WHEN 'その他' THEN 'other'
      WHEN 'その他オーディオ機器' THEN 'other'
      ELSE 'other'
    END,
    category_ids = CASE category
      WHEN 'スピーカー' THEN '["speaker"]'
      WHEN 'プリメインアンプ' THEN '["integrated_amp"]'
      WHEN 'プリアンプ' THEN '["pre_amp"]'
      WHEN 'コントロールアンプ' THEN '["pre_amp"]'
      WHEN 'パワーアンプ' THEN '["power_amp"]'
      WHEN 'ヘッドホンアンプ' THEN '["headphone_amp"]'
      WHEN 'DAC' THEN '["dac"]'
      WHEN 'D/Aコンバーター' THEN '["dac"]'
      WHEN 'D/Aコンバータ' THEN '["dac"]'
      WHEN 'DAコンバーター' THEN '["dac"]'
      WHEN 'DAコンバータ' THEN '["dac"]'
      WHEN 'ネットワーク' THEN '["network_player"]'
      WHEN 'ネットワークプレーヤー' THEN '["network_player"]'
      WHEN 'ネットワークプレイヤー' THEN '["network_player"]'
      WHEN 'ネットワークトランスポート' THEN '["network_transport"]'
      WHEN 'CD/SACDプレーヤー' THEN '["cd_sacd_player"]'
      WHEN 'CDプレーヤー' THEN '["cd_sacd_player"]'
      WHEN 'SACDプレーヤー' THEN '["cd_sacd_player"]'
      WHEN 'SACD/CDプレーヤー' THEN '["cd_sacd_player"]'
      WHEN 'レコードプレーヤー' THEN '["turntable"]'
      WHEN 'ターンテーブル' THEN '["turntable"]'
      WHEN 'トーンアーム' THEN '["tonearm"]'
      WHEN 'カートリッジ' THEN '["cartridge"]'
      WHEN 'フォノイコライザー' THEN '["phono_eq"]'
      WHEN 'イヤホン' THEN '["earphone"]'
      WHEN 'ヘッドホン' THEN '["headphone"]'
      WHEN 'DAP' THEN '["dap"]'
      WHEN 'DAP・ヘッドホンアンプ' THEN '["dap","headphone_amp"]'
      WHEN 'DJ機器・DTM' THEN '["dj_dtm"]'
      WHEN 'ケーブル' THEN '["cable"]'
      WHEN 'ケーブル・アクセサリー' THEN '["accessory","cable"]'
      WHEN 'スピーカーアクセサリー' THEN '["accessory"]'
      WHEN 'アクセサリー' THEN '["accessory"]'
      WHEN 'ラック' THEN '["rack"]'
      WHEN 'オーディオラック' THEN '["rack"]'
      WHEN '真空管' THEN '["vacuum_tube"]'
      WHEN 'その他' THEN '["other"]'
      WHEN 'その他オーディオ機器' THEN '["other"]'
      ELSE '["other"]'
    END,
    classification_status = CASE
      WHEN category IN (
        'スピーカー', 'プリメインアンプ', 'プリアンプ', 'コントロールアンプ', 'パワーアンプ',
        'ヘッドホンアンプ', 'DAC', 'D/Aコンバーター', 'D/Aコンバータ', 'DAコンバーター', 'DAコンバータ',
        'ネットワーク', 'ネットワークプレーヤー', 'ネットワークプレイヤー', 'ネットワークトランスポート',
        'CD/SACDプレーヤー', 'CDプレーヤー', 'SACDプレーヤー', 'SACD/CDプレーヤー',
        'レコードプレーヤー', 'ターンテーブル', 'トーンアーム', 'カートリッジ', 'フォノイコライザー',
        'イヤホン', 'ヘッドホン', 'DAP', 'DAP・ヘッドホンアンプ', 'DJ機器・DTM',
        'ケーブル', 'ケーブル・アクセサリー', 'スピーカーアクセサリー', 'アクセサリー',
        'ラック', 'オーディオラック', '真空管', 'その他', 'その他オーディオ機器'
      ) THEN 'classified'
      ELSE 'unclassified'
    END;

UPDATE products
SET category = CASE primary_category_id
      WHEN 'speaker' THEN 'スピーカー'
      WHEN 'integrated_amp' THEN 'プリメインアンプ'
      WHEN 'pre_amp' THEN 'プリアンプ'
      WHEN 'power_amp' THEN 'パワーアンプ'
      WHEN 'headphone_amp' THEN 'ヘッドホンアンプ'
      WHEN 'dac' THEN 'DAC'
      WHEN 'network_player' THEN 'ネットワークプレーヤー'
      WHEN 'network_transport' THEN 'ネットワークトランスポート'
      WHEN 'cd_sacd_player' THEN 'CD/SACDプレーヤー'
      WHEN 'turntable' THEN 'レコードプレーヤー'
      WHEN 'tonearm' THEN 'トーンアーム'
      WHEN 'cartridge' THEN 'カートリッジ'
      WHEN 'phono_eq' THEN 'フォノイコライザー'
      WHEN 'earphone' THEN 'イヤホン'
      WHEN 'headphone' THEN 'ヘッドホン'
      WHEN 'dap' THEN 'DAP'
      WHEN 'dj_dtm' THEN 'DJ機器・DTM'
      WHEN 'cable' THEN 'ケーブル'
      WHEN 'accessory' THEN 'アクセサリー'
      WHEN 'rack' THEN 'オーディオラック'
      WHEN 'vacuum_tube' THEN '真空管'
      ELSE 'その他'
    END,
    search_aliases = CASE primary_category_id
      WHEN 'speaker' THEN 'スピーカー speaker speakers speaker system'
      WHEN 'integrated_amp' THEN 'プリメインアンプ integrated amp integrated amplifier'
      WHEN 'pre_amp' THEN 'プリアンプ コントロールアンプ preamp pre amplifier control amplifier control amp'
      WHEN 'power_amp' THEN 'パワーアンプ power amp power amplifier'
      WHEN 'headphone_amp' THEN 'ヘッドホンアンプ headphone amp headphone amplifier'
      WHEN 'dac' THEN 'DAC D/Aコンバーター DAコンバーター d/a converter da converter'
      WHEN 'network_player' THEN 'ネットワークプレーヤー ネットワークプレイヤー ネットワーク network player streamer streaming player'
      WHEN 'network_transport' THEN 'ネットワークトランスポート network transport streaming transport'
      WHEN 'cd_sacd_player' THEN 'CD/SACDプレーヤー CDプレーヤー SACDプレーヤー cd player sacd player'
      WHEN 'turntable' THEN 'レコードプレーヤー ターンテーブル turntable record player'
      WHEN 'tonearm' THEN 'トーンアーム tonearm tone arm'
      WHEN 'cartridge' THEN 'カートリッジ cartridge'
      WHEN 'phono_eq' THEN 'フォノイコライザー フォノアンプ phono equalizer phono eq phono stage'
      WHEN 'earphone' THEN 'イヤホン earphone earphones IEM'
      WHEN 'headphone' THEN 'ヘッドホン headphone headphones'
      WHEN 'dap' THEN 'DAP デジタルオーディオプレーヤー ポータブルプレーヤー digital audio player'
      WHEN 'dj_dtm' THEN 'DJ機器 DTM DJ DDJ MIDI オーディオインターフェース'
      WHEN 'cable' THEN 'ケーブル cable cables'
      WHEN 'accessory' THEN 'アクセサリー インシュレーター accessory accessories'
      WHEN 'rack' THEN 'オーディオラック ラック audio rack'
      WHEN 'vacuum_tube' THEN '真空管 vacuum tube tube'
      ELSE 'その他 other others'
    END;

CREATE INDEX IF NOT EXISTS idx_products_manufacturer_id
  ON products(manufacturer_id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_primary_category
  ON products(primary_category_id)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_products_classification_status
  ON products(classification_status)
  WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS product_categories (
  product_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY(product_id, category_id),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category
  ON product_categories(category_id, product_id);

INSERT OR IGNORE INTO product_categories(product_id, category_id)
SELECT p.id, json_each.value
FROM products p, json_each(p.category_ids);

DROP TRIGGER IF EXISTS products_fts_ai;
DROP TRIGGER IF EXISTS products_fts_ad;
DROP TRIGGER IF EXISTS products_fts_au;
DROP TABLE IF EXISTS products_fts;

CREATE VIRTUAL TABLE products_fts USING fts5(
  title,
  manufacturer,
  model,
  category,
  raw_category,
  raw_manufacturer,
  search_aliases,
  content='products',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(
    rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    new.id, new.title, new.manufacturer, new.model, new.category,
    new.raw_category, new.raw_manufacturer, new.search_aliases
  );
END;

CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(
    products_fts, rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    'delete', old.id, old.title, old.manufacturer, old.model, old.category,
    old.raw_category, old.raw_manufacturer, old.search_aliases
  );
END;

CREATE TRIGGER products_fts_au
AFTER UPDATE OF title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases ON products
WHEN old.title IS NOT new.title
  OR old.manufacturer IS NOT new.manufacturer
  OR old.model IS NOT new.model
  OR old.category IS NOT new.category
  OR old.raw_category IS NOT new.raw_category
  OR old.raw_manufacturer IS NOT new.raw_manufacturer
  OR old.search_aliases IS NOT new.search_aliases
BEGIN
  INSERT INTO products_fts(
    products_fts, rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    'delete', old.id, old.title, old.manufacturer, old.model, old.category,
    old.raw_category, old.raw_manufacturer, old.search_aliases
  );
  INSERT INTO products_fts(
    rowid, title, manufacturer, model, category, raw_category, raw_manufacturer, search_aliases
  ) VALUES (
    new.id, new.title, new.manufacturer, new.model, new.category,
    new.raw_category, new.raw_manufacturer, new.search_aliases
  );
END;

INSERT INTO products_fts(products_fts) VALUES ('rebuild');
PRAGMA optimize;
