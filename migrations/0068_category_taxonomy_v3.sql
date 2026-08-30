-- Category taxonomy v3: one product-type primary category plus orthogonal facets.
--
-- This migration changes category values in place. Listing/catalog ids, identity resolutions,
-- price history and search entity membership are deliberately preserved. Temporary staging tables
-- make the evidence decisions auditable and keep the expensive expressions bounded to one pass.

DROP TABLE IF EXISTS migration_0068_categories;
DROP TABLE IF EXISTS migration_0068_legacy_map;
DROP TABLE IF EXISTS migration_0068_candidates;
DROP TABLE IF EXISTS migration_0068_evidence;
DROP TABLE IF EXISTS migration_0068_resolved;
DROP TABLE IF EXISTS migration_0068_legacy_facets;
DROP TABLE IF EXISTS migration_0068_catalog_categories;

CREATE TABLE migration_0068_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  root_order INTEGER NOT NULL,
  leaf_order INTEGER NOT NULL
);

INSERT INTO migration_0068_categories(id, name, parent_id, root_order, leaf_order) VALUES
  ('PER', 'パーソナルオーディオ', NULL, 1, 0),
  ('PER.HEADPHONE', 'ヘッドホン', 'PER', 1, 1),
  ('PER.EARPHONE', 'イヤホン / IEM', 'PER', 1, 2),
  ('SPK', 'スピーカー', NULL, 2, 0),
  ('SPK.LOUDSPEAKER', 'スピーカー', 'SPK', 2, 1),
  ('SPK.SUBWOOFER', 'サブウーファー', 'SPK', 2, 2),
  ('SPK.SOUNDBAR', 'サウンドバー', 'SPK', 2, 3),
  ('AMP', 'アンプ', NULL, 3, 0),
  ('AMP.INTEGRATED', 'プリメインアンプ', 'AMP', 3, 1),
  ('AMP.PRE', 'プリアンプ', 'AMP', 3, 2),
  ('AMP.POWER', 'パワーアンプ', 'AMP', 3, 3),
  ('AMP.HEADPHONE', 'ヘッドホンアンプ / エナジャイザー', 'AMP', 3, 4),
  ('AMP.RECEIVER', 'Stereo / AV Receiver', 'AMP', 3, 5),
  ('AMP.PHONO', 'フォノアンプ / フォノイコライザー', 'AMP', 3, 6),
  ('AMP.STEPUP', 'MC昇圧機器', 'AMP', 3, 7),
  ('SRC', 'ソース機器', NULL, 4, 0),
  ('SRC.STREAMER', 'ネットワークストリーマー / Network Transport', 'SRC', 4, 1),
  ('SRC.DAP', 'DAP', 'SRC', 4, 2),
  ('SRC.DISC', 'Disc Player / Disc Transport', 'SRC', 4, 3),
  ('SRC.SERVER', 'Music Server / Ripper', 'SRC', 4, 4),
  ('SRC.TUNER', 'チューナー / Radio', 'SRC', 4, 5),
  ('ANA', 'アナログ', NULL, 5, 0),
  ('ANA.TURNTABLE', 'ターンテーブル', 'ANA', 5, 1),
  ('ANA.TONEARM', 'トーンアーム', 'ANA', 5, 2),
  ('ANA.CARTRIDGE', 'カートリッジ', 'ANA', 5, 3),
  ('ANA.STYLUS', '交換針', 'ANA', 5, 4),
  ('ANA.HEADSHELL', 'ヘッドシェル', 'ANA', 5, 5),
  ('ANA.TAPE', 'テープデッキ', 'ANA', 5, 6),
  ('PRC', 'プロセッシング / 変換', NULL, 6, 0),
  ('PRC.DAC', 'D/A Converter', 'PRC', 6, 1),
  ('PRC.ADC', 'A/D Converter', 'PRC', 6, 2),
  ('PRC.DDC', 'DDC / Digital Bridge', 'PRC', 6, 3),
  ('PRC.PROCESSOR', 'Audio Processor', 'PRC', 6, 4),
  ('PRC.CLOCK', 'Master Clock', 'PRC', 6, 5),
  ('SIG', '信号 / ネットワーク機器', NULL, 7, 0),
  ('SIG.NETWORK', 'Audio Network Equipment', 'SIG', 7, 1),
  ('SIG.ISOLATOR', 'Signal Isolator', 'SIG', 7, 2),
  ('SIG.SELECTOR', 'Selector / Distributor', 'SIG', 7, 3),
  ('SIG.WIRELESS', 'Wireless Transmitter / Receiver', 'SIG', 7, 4),
  ('CAB', 'ケーブル', NULL, 8, 0),
  ('CAB.ANALOG', 'Analog Interconnect', 'CAB', 8, 1),
  ('CAB.DIGITAL', 'Digital Audio / AV Cable', 'CAB', 8, 2),
  ('CAB.SPEAKER', 'Speaker Cable', 'CAB', 8, 3),
  ('CAB.PERSONAL', 'Headphone / IEM Cable', 'CAB', 8, 4),
  ('CAB.DATA', 'USB / LAN Data Cable', 'CAB', 8, 5),
  ('CAB.ADAPTER', 'Passive Adapter', 'CAB', 8, 6),
  ('PWR', '電源', NULL, 9, 0),
  ('PWR.CORD', '電源ケーブル', 'PWR', 9, 1),
  ('PWR.DISTRIBUTION', '電源タップ / PDU', 'PWR', 9, 2),
  ('PWR.CONDITIONER', '電源コンディショナー / Isolation', 'PWR', 9, 3),
  ('PWR.REGEN', 'AC Regenerator', 'PWR', 9, 4),
  ('PWR.SUPPLY', '外部電源 / Linear PSU', 'PWR', 9, 5),
  ('PWR.BATTERY', 'Battery / UPS', 'PWR', 9, 6),
  ('ACC', 'アクセサリー', NULL, 10, 0),
  ('ACC.FURNITURE', 'ラック / オーディオ家具', 'ACC', 10, 1),
  ('ACC.STAND', 'スタンド / マウント', 'ACC', 10, 2),
  ('ACC.ISOLATION', 'インシュレーター / 振動対策', 'ACC', 10, 3),
  ('ACC.ACOUSTIC', 'ルームアコースティック', 'ACC', 10, 4),
  ('ACC.WEAR', '消耗・装着部品', 'ACC', 10, 5),
  ('ACC.CASE', 'ケース / カバー / バッグ', 'ACC', 10, 6),
  ('ACC.MAINTENANCE', 'クリーニング / メンテナンス', 'ACC', 10, 7),
  ('ACC.TUBE', '真空管', 'ACC', 10, 8),
  ('ACC.PART', '交換部品 / DIY Part', 'ACC', 10, 9),
  ('SYS', 'システム', NULL, 11, 0),
  ('SYS.MULTIFUNCTION', '複合オーディオ機器', 'SYS', 11, 1),
  ('SYS.COMPLETE', 'Complete Audio System', 'SYS', 11, 2),
  ('REC', 'Pro Audio Extension', NULL, 12, 0),
  ('REC.INTERFACE', 'Audio Interface', 'REC', 12, 1),
  ('REC.MIC', 'Microphone', 'REC', 12, 2),
  ('REC.MIXER', 'Mixer / Console', 'REC', 12, 3),
  ('REC.RECORDER', 'Recorder', 'REC', 12, 4),
  ('REC.MICPRE', 'Mic Pre / Channel Strip', 'REC', 12, 5),
  ('REC.MONITOR', 'Monitor Controller', 'REC', 12, 6),
  ('REC.DJ', 'DJ Controller / Digital DJ Gear', 'REC', 12, 7),
  ('unclassified', '未分類', NULL, 99, 0);

CREATE TABLE migration_0068_legacy_map (
  legacy_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  canonical_id TEXT
);

-- Exactly the public v2/pre-v2 compatibility vocabulary. Evidence rows intentionally have no
-- default: failure to find explicit evidence becomes the internal sentinel, never a normal other.
INSERT INTO migration_0068_legacy_map(legacy_id, strategy, canonical_id) VALUES
  ('amplifier', 'evidence', NULL), ('digital', 'evidence', NULL),
  ('analog', 'evidence', NULL), ('speaker', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('headphone_group', 'evidence', NULL), ('accessories', 'evidence', NULL),
  ('cable', 'evidence', NULL), ('integrated_amp', 'deterministic', 'AMP.INTEGRATED'),
  ('pre_amp', 'deterministic', 'AMP.PRE'), ('power_amp', 'deterministic', 'AMP.POWER'),
  ('headphone_amp', 'deterministic', 'AMP.HEADPHONE'), ('av_amp', 'evidence', NULL),
  ('dac', 'deterministic', 'PRC.DAC'), ('network_player', 'deterministic', 'SRC.STREAMER'),
  ('cd_sacd_player', 'deterministic', 'SRC.DISC'), ('transport', 'evidence', NULL),
  ('dap', 'deterministic', 'SRC.DAP'), ('network_switch', 'deterministic', 'SIG.NETWORK'),
  ('optical_isolator', 'deterministic', 'SIG.ISOLATOR'),
  ('router', 'deterministic', 'SIG.NETWORK'), ('music_server', 'deterministic', 'SRC.SERVER'),
  ('master_clock', 'deterministic', 'PRC.CLOCK'),
  ('turntable', 'deterministic', 'ANA.TURNTABLE'), ('tonearm', 'deterministic', 'ANA.TONEARM'),
  ('cartridge', 'deterministic', 'ANA.CARTRIDGE'), ('headshell', 'deterministic', 'ANA.HEADSHELL'),
  ('phono_eq', 'deterministic', 'AMP.PHONO'),
  ('phono_step_up_transformer', 'deterministic', 'AMP.STEPUP'),
  ('speaker_bookshelf', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('speaker_floorstanding', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('center_speaker', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('subwoofer', 'deterministic', 'SPK.SUBWOOFER'),
  ('active_speaker', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('wired_headphone', 'deterministic', 'PER.HEADPHONE'),
  ('wired_earphone', 'deterministic', 'PER.EARPHONE'),
  ('btw_headphone', 'deterministic', 'PER.HEADPHONE'),
  ('btw_earphone', 'deterministic', 'PER.EARPHONE'),
  ('cable_xlr', 'evidence', NULL), ('cable_rca', 'deterministic', 'CAB.ANALOG'),
  ('cable_phono', 'deterministic', 'CAB.ANALOG'), ('cable_usb', 'deterministic', 'CAB.DATA'),
  ('cable_lan', 'deterministic', 'CAB.DATA'), ('cable_digital', 'deterministic', 'CAB.DIGITAL'),
  ('cable_power', 'deterministic', 'PWR.CORD'), ('cable_other', 'evidence', NULL),
  ('rack', 'deterministic', 'ACC.FURNITURE'),
  ('power_strip', 'deterministic', 'PWR.DISTRIBUTION'), ('clean_power', 'evidence', NULL),
  ('vacuum_tube', 'deterministic', 'ACC.TUBE'), ('other_accessory', 'evidence', NULL),
  ('dj_dtm', 'evidence', NULL), ('other', 'evidence', NULL),
  ('network_transport', 'deterministic', 'SRC.STREAMER'),
  ('cd_sacd_transport', 'deterministic', 'SRC.DISC'), ('accessory', 'evidence', NULL),
  ('speaker_other', 'deterministic', 'SPK.LOUDSPEAKER'),
  ('headphone', 'deterministic', 'PER.HEADPHONE'),
  ('earphone', 'deterministic', 'PER.EARPHONE'),
  ('power_accessory', 'deterministic', 'PWR.CONDITIONER');

CREATE TABLE migration_0068_candidates (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  legacy_id TEXT NOT NULL,
  evidence_text TEXT NOT NULL DEFAULT '',
  was_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(entity_type, entity_id, position, legacy_id)
);

INSERT INTO migration_0068_candidates(entity_type, entity_id, position, legacy_id, evidence_text, was_primary)
SELECT 'product_primary', id, 0, COALESCE(NULLIF(primary_category_id, ''), 'unclassified'),
       LOWER(COALESCE(title, '') || ' ' || COALESCE(raw_category, '') || ' ' ||
             COALESCE(category, '') || ' ' || COALESCE(metadata_json, '')), 1
FROM products;

INSERT OR IGNORE INTO migration_0068_candidates(entity_type, entity_id, position, legacy_id, evidence_text, was_primary)
SELECT 'product_direct', p.id, CAST(j.key AS INTEGER), CAST(j.value AS TEXT),
       LOWER(COALESCE(p.title, '') || ' ' || COALESCE(p.raw_category, '') || ' ' ||
             COALESCE(p.category, '') || ' ' || COALESCE(p.metadata_json, '')),
       CASE WHEN CAST(j.value AS TEXT) = p.primary_category_id THEN 1 ELSE 0 END
FROM products p,
     json_each(
       CASE
         WHEN json_valid(COALESCE(p.direct_category_ids, ''))
              AND json_array_length(p.direct_category_ids) > 0 THEN p.direct_category_ids
         WHEN json_valid(COALESCE(p.category_ids, ''))
              AND json_array_length(p.category_ids) > 0 THEN p.category_ids
         ELSE json_array(p.primary_category_id)
       END
     ) j
WHERE j.type = 'text';

INSERT INTO migration_0068_candidates(entity_type, entity_id, position, legacy_id, evidence_text, was_primary)
SELECT 'admin_primary', o.listing_product_id, 0, o.primary_category_id,
       LOWER(COALESCE(p.title, '') || ' ' || COALESCE(p.raw_category, '') || ' ' ||
             COALESCE(p.category, '')), 1
FROM product_admin_overrides o
JOIN products p ON p.id = o.listing_product_id
WHERE o.primary_category_id IS NOT NULL;

INSERT INTO migration_0068_candidates(entity_type, entity_id, position, legacy_id, evidence_text, was_primary)
SELECT 'catalog', c.product_id,
       ROW_NUMBER() OVER (PARTITION BY c.product_id ORDER BY c.is_primary DESC, c.category_id),
       c.category_id,
       LOWER(COALESCE(k.canonical_name, '') || ' ' || COALESCE(k.canonical_model, '') || ' ' ||
             COALESCE(k.normalized_model, '')), c.is_primary
FROM knowledge_catalog_product_categories c
JOIN knowledge_catalog_products k ON k.id = c.product_id;

CREATE TABLE migration_0068_evidence (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  legacy_id TEXT NOT NULL,
  evidence_candidate TEXT,
  PRIMARY KEY(entity_type, entity_id, position, legacy_id)
);

-- Product-type evidence only. Cable/accessory rules precede equipment rules so "headphone cable"
-- cannot become a headphone. XLR stays unresolved unless the signal domain is explicit.
INSERT INTO migration_0068_evidence
SELECT entity_type, entity_id, position, legacy_id,
  CASE
    WHEN evidence_text LIKE '%電源ケーブル%' OR evidence_text LIKE '%電源コード%'
      OR evidence_text LIKE '%power cable%' OR evidence_text LIKE '%power cord%'
      OR evidence_text LIKE '%ac cord%' THEN 'PWR.CORD'
    WHEN evidence_text LIKE '%電源タップ%' OR evidence_text LIKE '%電源ボックス%'
      OR evidence_text LIKE '%power strip%' OR evidence_text LIKE '% pdu %' THEN 'PWR.DISTRIBUTION'
    WHEN evidence_text LIKE '%regenerator%' OR evidence_text LIKE '%リジェネレータ%' THEN 'PWR.REGEN'
    WHEN evidence_text LIKE '%power conditioner%' OR evidence_text LIKE '%clean power%'
      OR evidence_text LIKE '%isolation transformer%' OR evidence_text LIKE '%クリーン電源%'
      OR evidence_text LIKE '%電源コンディショナ%' THEN 'PWR.CONDITIONER'
    WHEN evidence_text LIKE '%linear power%' OR evidence_text LIKE '%external power%'
      OR evidence_text LIKE '%power supply%' OR evidence_text LIKE '%外部電源%'
      OR evidence_text LIKE '%リニア電源%' THEN 'PWR.SUPPLY'
    WHEN evidence_text LIKE '%battery supply%' OR evidence_text LIKE '% ups %'
      OR evidence_text LIKE '%バッテリー電源%' THEN 'PWR.BATTERY'
    WHEN evidence_text LIKE '%speaker cable%' OR evidence_text LIKE '%スピーカーケーブル%' THEN 'CAB.SPEAKER'
    WHEN evidence_text LIKE '%headphone cable%' OR evidence_text LIKE '%earphone cable%'
      OR evidence_text LIKE '%iem cable%' OR evidence_text LIKE '%リケーブル%' THEN 'CAB.PERSONAL'
    WHEN evidence_text LIKE '%usb cable%' OR evidence_text LIKE '%lan cable%'
      OR evidence_text LIKE '%ethernet cable%' OR evidence_text LIKE '%usbケーブル%'
      OR evidence_text LIKE '%lanケーブル%' THEN 'CAB.DATA'
    WHEN evidence_text LIKE '%aes/ebu%' OR evidence_text LIKE '%aes3%'
      OR evidence_text LIKE '%spdif%' OR evidence_text LIKE '%s/pdif%'
      OR evidence_text LIKE '%toslink%' OR evidence_text LIKE '%digital cable%'
      OR evidence_text LIKE '%デジタルケーブル%' OR evidence_text LIKE '%hdmi cable%' THEN 'CAB.DIGITAL'
    WHEN evidence_text LIKE '%rca cable%' OR evidence_text LIKE '%phono cable%'
      OR evidence_text LIKE '%analog cable%' OR evidence_text LIKE '%interconnect%'
      OR evidence_text LIKE '%アナログケーブル%' OR evidence_text LIKE '%フォノケーブル%' THEN 'CAB.ANALOG'
    WHEN (evidence_text LIKE '% xlr%' OR evidence_text LIKE '%xlr %')
      AND (evidence_text LIKE '%digital%' OR evidence_text LIKE '%デジタル%'
           OR evidence_text LIKE '%aes%') THEN 'CAB.DIGITAL'
    WHEN (evidence_text LIKE '% xlr%' OR evidence_text LIKE '%xlr %')
      AND (evidence_text LIKE '%analog%' OR evidence_text LIKE '%アナログ%'
           OR evidence_text LIKE '%rca%' OR evidence_text LIKE '%interconnect%') THEN 'CAB.ANALOG'
    WHEN evidence_text LIKE '%passive adapter%' OR evidence_text LIKE '%splitter%'
      OR evidence_text LIKE '%変換プラグ%' THEN 'CAB.ADAPTER'
    WHEN evidence_text LIKE '%audio rack%' OR evidence_text LIKE '%オーディオラック%' THEN 'ACC.FURNITURE'
    WHEN evidence_text LIKE '%speaker stand%' OR evidence_text LIKE '%headphone stand%'
      OR evidence_text LIKE '%スピーカースタンド%' THEN 'ACC.STAND'
    WHEN evidence_text LIKE '%insulator%' OR evidence_text LIKE '%isolation board%'
      OR evidence_text LIKE '%インシュレータ%' OR evidence_text LIKE '%オーディオボード%' THEN 'ACC.ISOLATION'
    WHEN evidence_text LIKE '%acoustic panel%' OR evidence_text LIKE '%absorber%'
      OR evidence_text LIKE '%diffuser%' OR evidence_text LIKE '%吸音%' OR evidence_text LIKE '%拡散パネル%' THEN 'ACC.ACOUSTIC'
    WHEN evidence_text LIKE '%ear pad%' OR evidence_text LIKE '%ear tip%'
      OR evidence_text LIKE '%イヤーパッド%' OR evidence_text LIKE '%イヤーピース%' THEN 'ACC.WEAR'
    WHEN evidence_text LIKE '%headphone case%' OR evidence_text LIKE '%equipment case%'
      OR evidence_text LIKE '%ケース%' OR evidence_text LIKE '%カバー%' THEN 'ACC.CASE'
    WHEN evidence_text LIKE '%cleaner%' OR evidence_text LIKE '%maintenance%'
      OR evidence_text LIKE '%クリーニング%' OR evidence_text LIKE '%メンテナンス%' THEN 'ACC.MAINTENANCE'
    WHEN evidence_text LIKE '%vacuum tube%' OR evidence_text LIKE '%真空管%' THEN 'ACC.TUBE'
    WHEN evidence_text LIKE '%replacement part%' OR evidence_text LIKE '%diy part%'
      OR evidence_text LIKE '%交換部品%' OR evidence_text LIKE '%補修部品%' THEN 'ACC.PART'
    WHEN evidence_text LIKE '%headphone amp%' OR evidence_text LIKE '%headphone amplifier%'
      OR evidence_text LIKE '%ヘッドホンアンプ%' OR evidence_text LIKE '%energizer%' THEN 'AMP.HEADPHONE'
    WHEN evidence_text LIKE '%earphone%' OR evidence_text LIKE '%イヤホン%'
      OR evidence_text LIKE '% iem %' THEN 'PER.EARPHONE'
    WHEN evidence_text LIKE '%headphone%' OR evidence_text LIKE '%ヘッドホン%' THEN 'PER.HEADPHONE'
    WHEN evidence_text LIKE '%subwoofer%' OR evidence_text LIKE '%サブウーファー%' THEN 'SPK.SUBWOOFER'
    WHEN evidence_text LIKE '%soundbar%' OR evidence_text LIKE '%sound bar%'
      OR evidence_text LIKE '%サウンドバー%' THEN 'SPK.SOUNDBAR'
    WHEN evidence_text LIKE '%speaker%' OR evidence_text LIKE '%スピーカー%' THEN 'SPK.LOUDSPEAKER'
    WHEN evidence_text LIKE '%integrated amp%' OR evidence_text LIKE '%integrated amplifier%'
      OR evidence_text LIKE '%プリメインアンプ%' THEN 'AMP.INTEGRATED'
    WHEN evidence_text LIKE '%phono equalizer%' OR evidence_text LIKE '%phono stage%'
      OR evidence_text LIKE '%phono amp%' OR evidence_text LIKE '%フォノイコライザ%'
      OR evidence_text LIKE '%フォノアンプ%' THEN 'AMP.PHONO'
    WHEN evidence_text LIKE '%step-up transformer%' OR evidence_text LIKE '%昇圧トランス%'
      OR evidence_text LIKE '%mc head amp%' THEN 'AMP.STEPUP'
    WHEN evidence_text LIKE '%av receiver%' OR evidence_text LIKE '%stereo receiver%'
      OR evidence_text LIKE '%avレシーバ%' THEN 'AMP.RECEIVER'
    WHEN evidence_text LIKE '%power amp%' OR evidence_text LIKE '%power amplifier%'
      OR evidence_text LIKE '%パワーアンプ%' THEN 'AMP.POWER'
    WHEN evidence_text LIKE '%preamp%' OR evidence_text LIKE '%pre amplifier%'
      OR evidence_text LIKE '%control amplifier%' OR evidence_text LIKE '%プリアンプ%'
      OR evidence_text LIKE '%コントロールアンプ%' THEN 'AMP.PRE'
    WHEN evidence_text LIKE '%network transport%' OR evidence_text LIKE '%network player%'
      OR evidence_text LIKE '%streamer%' OR evidence_text LIKE '%ネットワークプレーヤ%'
      OR evidence_text LIKE '%ネットワークトランスポート%' THEN 'SRC.STREAMER'
    WHEN evidence_text LIKE '%digital audio player%' OR evidence_text LIKE '% dap %'
      OR evidence_text LIKE '%ポータブルプレーヤ%' THEN 'SRC.DAP'
    WHEN evidence_text LIKE '%sacd%' OR evidence_text LIKE '%cd player%'
      OR evidence_text LIKE '%cd transport%' OR evidence_text LIKE '%disc player%'
      OR evidence_text LIKE '%disc transport%' OR evidence_text LIKE '%cdプレーヤ%'
      OR evidence_text LIKE '%cdトランスポート%' THEN 'SRC.DISC'
    WHEN evidence_text LIKE '%music server%' OR evidence_text LIKE '%music ripper%'
      OR evidence_text LIKE '%ミュージックサーバ%' THEN 'SRC.SERVER'
    WHEN evidence_text LIKE '%tuner%' OR evidence_text LIKE '%チューナー%' THEN 'SRC.TUNER'
    WHEN evidence_text LIKE '%turntable%' OR evidence_text LIKE '%record player%'
      OR evidence_text LIKE '%ターンテーブル%' OR evidence_text LIKE '%レコードプレーヤ%' THEN 'ANA.TURNTABLE'
    WHEN evidence_text LIKE '%tonearm%' OR evidence_text LIKE '%tone arm%'
      OR evidence_text LIKE '%トーンアーム%' THEN 'ANA.TONEARM'
    WHEN evidence_text LIKE '%cartridge%' OR evidence_text LIKE '%カートリッジ%' THEN 'ANA.CARTRIDGE'
    WHEN evidence_text LIKE '%replacement stylus%' OR evidence_text LIKE '%交換針%'
      OR evidence_text LIKE '%レコード針%' THEN 'ANA.STYLUS'
    WHEN evidence_text LIKE '%headshell%' OR evidence_text LIKE '%head shell%'
      OR evidence_text LIKE '%ヘッドシェル%' THEN 'ANA.HEADSHELL'
    WHEN evidence_text LIKE '%tape deck%' OR evidence_text LIKE '%cassette deck%'
      OR evidence_text LIKE '%テープデッキ%' THEN 'ANA.TAPE'
    WHEN evidence_text LIKE '% a/d converter%' OR evidence_text LIKE '% adc %'
      OR evidence_text LIKE '%adコンバータ%' THEN 'PRC.ADC'
    WHEN evidence_text LIKE '% d/a converter%' OR evidence_text LIKE '% dac %'
      OR evidence_text LIKE '%d/aコンバータ%' THEN 'PRC.DAC'
    WHEN evidence_text LIKE '%digital bridge%' OR evidence_text LIKE '%usb bridge%'
      OR evidence_text LIKE '% ddc %' OR evidence_text LIKE '%reclocker%'
      OR evidence_text LIKE '%リクロッカ%' THEN 'PRC.DDC'
    WHEN evidence_text LIKE '%master clock%' OR evidence_text LIKE '%clock generator%'
      OR evidence_text LIKE '%マスタークロック%' THEN 'PRC.CLOCK'
    WHEN evidence_text LIKE '%audio processor%' OR evidence_text LIKE '%equalizer%'
      OR evidence_text LIKE '%room correction%' OR evidence_text LIKE '%channel divider%'
      OR evidence_text LIKE '%イコライザ%' OR evidence_text LIKE '%ルーム補正%'
      OR evidence_text LIKE '%チャンネルディバイダ%' THEN 'PRC.PROCESSOR'
    WHEN evidence_text LIKE '%network switch%' OR evidence_text LIKE '%switching hub%'
      OR evidence_text LIKE '%audio router%' OR evidence_text LIKE '%ネットワークスイッチ%'
      OR evidence_text LIKE '%スイッチングハブ%' THEN 'SIG.NETWORK'
    WHEN evidence_text LIKE '%optical isolator%' OR evidence_text LIKE '%signal isolator%'
      OR evidence_text LIKE '%アイソレータ%' OR evidence_text LIKE '%光絶縁%' THEN 'SIG.ISOLATOR'
    WHEN evidence_text LIKE '%selector%' OR evidence_text LIKE '%distributor%'
      OR evidence_text LIKE '%matrix%' OR evidence_text LIKE '%セレクタ%' OR evidence_text LIKE '%分配器%' THEN 'SIG.SELECTOR'
    WHEN evidence_text LIKE '%wireless transmitter%' OR evidence_text LIKE '%wireless receiver%'
      OR evidence_text LIKE '%bluetooth adapter%' OR evidence_text LIKE '%ワイヤレス送信%' THEN 'SIG.WIRELESS'
    WHEN evidence_text LIKE '%audio interface%' OR evidence_text LIKE '%オーディオインターフェース%' THEN 'REC.INTERFACE'
    WHEN evidence_text LIKE '%microphone%' OR evidence_text LIKE '%マイクロフォン%' THEN 'REC.MIC'
    WHEN evidence_text LIKE '%mixing console%' OR evidence_text LIKE '%audio mixer%'
      OR evidence_text LIKE '%ミキサー%' THEN 'REC.MIXER'
    WHEN evidence_text LIKE '%field recorder%' OR evidence_text LIKE '%digital recorder%'
      OR evidence_text LIKE '%レコーダー%' THEN 'REC.RECORDER'
    WHEN evidence_text LIKE '%mic pre%' OR evidence_text LIKE '%channel strip%'
      OR evidence_text LIKE '%マイクプリ%' THEN 'REC.MICPRE'
    WHEN evidence_text LIKE '%monitor controller%' OR evidence_text LIKE '%モニターコントローラー%' THEN 'REC.MONITOR'
    WHEN evidence_text LIKE '%dj controller%' OR evidence_text LIKE '%digital dj%'
      OR evidence_text LIKE '%djコントローラー%' THEN 'REC.DJ'
    ELSE NULL
  END
FROM migration_0068_candidates;

CREATE TABLE migration_0068_resolved (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  legacy_id TEXT NOT NULL,
  new_category_id TEXT NOT NULL,
  mapping_strategy TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL,
  was_primary INTEGER NOT NULL,
  PRIMARY KEY(entity_type, entity_id, position, legacy_id)
);

INSERT INTO migration_0068_resolved
SELECT c.entity_type, c.entity_id, c.position, c.legacy_id,
       CASE
         WHEN canonical.parent_id IS NOT NULL THEN canonical.id
         WHEN m.canonical_id IS NOT NULL THEN m.canonical_id
         WHEN e.evidence_candidate IS NOT NULL AND (
           (c.legacy_id IN ('amplifier', 'AMP') AND e.evidence_candidate LIKE 'AMP.%') OR
           (c.legacy_id IN ('digital', 'SRC', 'PRC', 'SIG') AND
             (e.evidence_candidate LIKE 'SRC.%' OR e.evidence_candidate LIKE 'PRC.%' OR e.evidence_candidate LIKE 'SIG.%')) OR
           (c.legacy_id IN ('analog', 'ANA') AND
             (e.evidence_candidate LIKE 'ANA.%' OR e.evidence_candidate IN ('AMP.PHONO', 'AMP.STEPUP'))) OR
           (c.legacy_id = 'headphone_group' AND
             (e.evidence_candidate LIKE 'PER.%' OR e.evidence_candidate = 'AMP.HEADPHONE')) OR
           (c.legacy_id IN ('accessories', 'other_accessory') AND
             (e.evidence_candidate LIKE 'ACC.%' OR e.evidence_candidate LIKE 'CAB.%' OR e.evidence_candidate LIKE 'PWR.%')) OR
           (c.legacy_id IN ('cable', 'cable_other') AND
             (e.evidence_candidate LIKE 'CAB.%' OR e.evidence_candidate = 'PWR.CORD')) OR
           (c.legacy_id = 'av_amp' AND e.evidence_candidate IN ('AMP.RECEIVER', 'PRC.PROCESSOR', 'AMP.POWER', 'AMP.PRE')) OR
           (c.legacy_id = 'transport' AND e.evidence_candidate IN ('SRC.DISC', 'SRC.STREAMER', 'PRC.DDC')) OR
           (c.legacy_id = 'cable_xlr' AND e.evidence_candidate IN ('CAB.ANALOG', 'CAB.DIGITAL')) OR
           (c.legacy_id = 'clean_power' AND e.evidence_candidate IN ('PWR.CONDITIONER', 'PWR.REGEN')) OR
           (c.legacy_id = 'dj_dtm' AND e.evidence_candidate LIKE 'REC.%') OR
           (c.legacy_id = 'accessory' AND e.evidence_candidate LIKE 'ACC.%') OR
           (c.legacy_id = 'other' AND e.evidence_candidate IN (
             'SRC.TUNER', 'PRC.PROCESSOR', 'SPK.SOUNDBAR', 'CAB.SPEAKER',
             'CAB.PERSONAL', 'ACC.ISOLATION'
           ))
         ) THEN e.evidence_candidate
         ELSE 'unclassified'
       END,
       CASE
         WHEN canonical.parent_id IS NOT NULL THEN 'canonical'
         WHEN m.canonical_id IS NOT NULL THEN 'deterministic'
         WHEN e.evidence_candidate IS NOT NULL AND (
           (c.legacy_id IN ('amplifier', 'AMP') AND e.evidence_candidate LIKE 'AMP.%') OR
           (c.legacy_id IN ('digital', 'SRC', 'PRC', 'SIG') AND
             (e.evidence_candidate LIKE 'SRC.%' OR e.evidence_candidate LIKE 'PRC.%' OR e.evidence_candidate LIKE 'SIG.%')) OR
           (c.legacy_id IN ('analog', 'ANA') AND
             (e.evidence_candidate LIKE 'ANA.%' OR e.evidence_candidate IN ('AMP.PHONO', 'AMP.STEPUP'))) OR
           (c.legacy_id = 'headphone_group' AND
             (e.evidence_candidate LIKE 'PER.%' OR e.evidence_candidate = 'AMP.HEADPHONE')) OR
           (c.legacy_id IN ('accessories', 'other_accessory') AND
             (e.evidence_candidate LIKE 'ACC.%' OR e.evidence_candidate LIKE 'CAB.%' OR e.evidence_candidate LIKE 'PWR.%')) OR
           (c.legacy_id IN ('cable', 'cable_other') AND
             (e.evidence_candidate LIKE 'CAB.%' OR e.evidence_candidate = 'PWR.CORD')) OR
           (c.legacy_id = 'av_amp' AND e.evidence_candidate IN ('AMP.RECEIVER', 'PRC.PROCESSOR', 'AMP.POWER', 'AMP.PRE')) OR
           (c.legacy_id = 'transport' AND e.evidence_candidate IN ('SRC.DISC', 'SRC.STREAMER', 'PRC.DDC')) OR
           (c.legacy_id = 'cable_xlr' AND e.evidence_candidate IN ('CAB.ANALOG', 'CAB.DIGITAL')) OR
           (c.legacy_id = 'clean_power' AND e.evidence_candidate IN ('PWR.CONDITIONER', 'PWR.REGEN')) OR
           (c.legacy_id = 'dj_dtm' AND e.evidence_candidate LIKE 'REC.%') OR
           (c.legacy_id = 'accessory' AND e.evidence_candidate LIKE 'ACC.%') OR
           (c.legacy_id = 'other' AND e.evidence_candidate IN (
             'SRC.TUNER', 'PRC.PROCESSOR', 'SPK.SOUNDBAR', 'CAB.SPEAKER',
             'CAB.PERSONAL', 'ACC.ISOLATION'
           ))
         ) THEN 'evidence'
         ELSE 'unclassified'
       END,
       CASE
         WHEN canonical.parent_id IS NOT NULL OR m.canonical_id IS NOT NULL THEN 1.0
         WHEN e.evidence_candidate IS NOT NULL THEN 0.75
         ELSE 0.0
       END,
       c.evidence_text, c.was_primary
FROM migration_0068_candidates c
LEFT JOIN migration_0068_categories canonical ON canonical.id = c.legacy_id
LEFT JOIN migration_0068_legacy_map m ON m.legacy_id = c.legacy_id
LEFT JOIN migration_0068_evidence e
  ON e.entity_type = c.entity_type AND e.entity_id = c.entity_id
 AND e.position = c.position AND e.legacy_id = c.legacy_id;

CREATE TABLE IF NOT EXISTS taxonomy_v3_migration_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  category_position INTEGER NOT NULL,
  legacy_category_id TEXT NOT NULL,
  canonical_category_id TEXT NOT NULL,
  mapping_strategy TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL DEFAULT '',
  migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(entity_type, entity_id, category_position, legacy_category_id)
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_v3_audit_strategy
  ON taxonomy_v3_migration_audit(mapping_strategy, canonical_category_id, entity_type);

INSERT OR IGNORE INTO taxonomy_v3_migration_audit(
  entity_type, entity_id, category_position, legacy_category_id, canonical_category_id,
  mapping_strategy, confidence, evidence_text
)
SELECT entity_type, entity_id, position, legacy_id, new_category_id,
       mapping_strategy, confidence, substr(evidence_text, 1, 1000)
FROM migration_0068_resolved
WHERE legacy_id <> new_category_id
   OR EXISTS (SELECT 1 FROM migration_0068_legacy_map m WHERE m.legacy_id = migration_0068_resolved.legacy_id);

CREATE TABLE IF NOT EXISTS product_facet_facts (
  product_id INTEGER NOT NULL,
  facet_id TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  verified_at TEXT,
  PRIMARY KEY(product_id, facet_id, facet_value, source),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_facet_facts_filter
  ON product_facet_facts(facet_id, facet_value, product_id);

CREATE TABLE migration_0068_legacy_facets (
  legacy_id TEXT NOT NULL,
  facet_id TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  PRIMARY KEY(legacy_id, facet_id, facet_value)
);

INSERT INTO migration_0068_legacy_facets VALUES
  ('dap', 'portability', 'portable'),
  ('network_switch', 'network_device_type', 'switch'),
  ('network_switch', 'protocol', 'ethernet'),
  ('router', 'network_device_type', 'router'),
  ('phono_step_up_transformer', 'technology', 'transformer'),
  ('speaker_bookshelf', 'form_factor', 'bookshelf'),
  ('speaker_floorstanding', 'form_factor', 'floorstanding'),
  ('center_speaker', 'channel_role', 'center'),
  ('active_speaker', 'amplification_mode', 'active'),
  ('wired_headphone', 'connectivity', 'wired'),
  ('wired_earphone', 'connectivity', 'wired'),
  ('btw_headphone', 'connectivity', 'wireless'),
  ('btw_headphone', 'protocol', 'bluetooth'),
  ('btw_earphone', 'connectivity', 'wireless'),
  ('btw_earphone', 'protocol', 'bluetooth'),
  ('cable_xlr', 'connector_a', 'xlr'),
  ('cable_xlr', 'connector_b', 'xlr'),
  ('cable_rca', 'connector_a', 'rca'),
  ('cable_rca', 'connector_b', 'rca'),
  ('cable_rca', 'signal_type', 'analog'),
  ('cable_phono', 'application', 'phono'),
  ('cable_phono', 'signal_type', 'analog'),
  ('cable_usb', 'connector_a', 'usb'),
  ('cable_usb', 'signal_type', 'data'),
  ('cable_lan', 'connector_a', 'ethernet'),
  ('cable_lan', 'connector_b', 'ethernet'),
  ('cable_lan', 'signal_type', 'data'),
  ('cable_digital', 'signal_type', 'digital'),
  ('cable_power', 'signal_type', 'power'),
  ('dj_dtm', 'use_case', 'dj');

INSERT OR IGNORE INTO product_facet_facts(
  product_id, facet_id, facet_value, source, confidence, verified_at
)
SELECT r.entity_id, f.facet_id, f.facet_value, 'legacy_category', 0.9,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM migration_0068_resolved r
JOIN migration_0068_legacy_facets f ON f.legacy_id = r.legacy_id
WHERE r.entity_type IN ('product_primary', 'product_direct');

-- XLR is a connector, not a signal type. Preserve the connector fact and add signal type only
-- when the evidence-based category decision established the domain.
INSERT OR IGNORE INTO product_facet_facts(
  product_id, facet_id, facet_value, source, confidence, verified_at
)
SELECT r.entity_id, 'signal_type',
       CASE r.new_category_id WHEN 'CAB.DIGITAL' THEN 'digital' ELSE 'analog' END,
       'legacy_category', 0.75, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM migration_0068_resolved r
WHERE r.entity_type IN ('product_primary', 'product_direct')
  AND r.legacy_id = 'cable_xlr'
  AND r.new_category_id IN ('CAB.ANALOG', 'CAB.DIGITAL');

-- Immediately useful title/category facets; the bounded remediation replay owns the full rule set.
INSERT OR IGNORE INTO product_facet_facts
SELECT id, 'connectivity', 'wireless', 'title', 0.8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE LOWER(title) LIKE '%wireless%' OR LOWER(title) LIKE '%bluetooth%'
   OR title LIKE '%ワイヤレス%' OR title LIKE '%無線%';
INSERT OR IGNORE INTO product_facet_facts
SELECT id, 'connectivity', 'wired', 'title', 0.8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE LOWER(title) LIKE '%wired%' OR LOWER(title) LIKE '% xlr%'
   OR LOWER(title) LIKE '% usb%' OR title LIKE '%有線%';
INSERT OR IGNORE INTO product_facet_facts
SELECT id, 'protocol', 'bluetooth', 'title', 0.8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products WHERE LOWER(title) LIKE '%bluetooth%' OR title LIKE '%ブルートゥース%';
INSERT OR IGNORE INTO product_facet_facts
SELECT id, 'connector_a', 'xlr', 'title', 0.8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products WHERE LOWER(title) LIKE '%xlr%' OR LOWER(title) LIKE '%aes/ebu%';
INSERT OR IGNORE INTO product_facet_facts
SELECT id, 'connector_b', 'xlr', 'title', 0.8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products WHERE LOWER(title) LIKE '%xlr%' OR LOWER(title) LIKE '%aes/ebu%';

-- Category overrides are migrated before product rows so their existing AFTER UPDATE trigger
-- reinforces the v3 value instead of restoring a legacy id.
UPDATE product_admin_overrides AS o
SET primary_category_id = (
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'admin_primary' AND r.entity_id = o.listing_product_id
    ),
    category_ids = json_array((
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'admin_primary' AND r.entity_id = o.listing_product_id
    )),
    category_name = COALESCE((
      SELECT c.name
      FROM migration_0068_resolved r
      JOIN migration_0068_categories c ON c.id = r.new_category_id
      WHERE r.entity_type = 'admin_primary' AND r.entity_id = o.listing_product_id
    ), category_name),
    search_aliases = COALESCE((
      SELECT r.new_category_id || ' ' || c.name
      FROM migration_0068_resolved r
      JOIN migration_0068_categories c ON c.id = r.new_category_id
      WHERE r.entity_type = 'admin_primary' AND r.entity_id = o.listing_product_id
    ), search_aliases)
WHERE o.primary_category_id IS NOT NULL;

UPDATE products AS p
SET primary_category_id = (
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    ),
    category_ids = json_array((
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    )),
    direct_category_ids = COALESCE(NULLIF((
      SELECT json_group_array(category_id)
      FROM (
        SELECT DISTINCT r.new_category_id AS category_id, c.root_order, c.leaf_order
        FROM migration_0068_resolved r
        JOIN migration_0068_categories c ON c.id = r.new_category_id
        WHERE r.entity_type = 'product_direct' AND r.entity_id = p.id
          AND (r.new_category_id <> 'unclassified' OR NOT EXISTS (
            SELECT 1 FROM migration_0068_resolved concrete
            WHERE concrete.entity_type = 'product_direct' AND concrete.entity_id = p.id
              AND concrete.new_category_id <> 'unclassified'
          ))
        ORDER BY c.root_order, c.leaf_order, r.new_category_id
      )
    ), '[]'), json_array((
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    ))),
    category = (
      SELECT c.name
      FROM migration_0068_resolved r
      JOIN migration_0068_categories c ON c.id = r.new_category_id
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    ),
    classification_status = CASE WHEN (
      SELECT r.new_category_id FROM migration_0068_resolved r
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    ) = 'unclassified' THEN 'unclassified' ELSE 'classified' END,
    search_aliases = (
      SELECT r.new_category_id || ' ' || c.name
      FROM migration_0068_resolved r
      JOIN migration_0068_categories c ON c.id = r.new_category_id
      WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
    ),
    metadata_json = json_set(
      CASE WHEN json_valid(COALESCE(p.metadata_json, '')) THEN p.metadata_json ELSE '{}' END,
      '$.categoryClassification.version', 16,
      '$.categoryClassification.taxonomyVersion', 'v3',
      '$.categoryClassification.state', CASE WHEN (
        SELECT r.new_category_id FROM migration_0068_resolved r
        WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
      ) = 'unclassified' THEN 'unclassified' ELSE 'classified' END,
      '$.categoryClassification.status', CASE WHEN (
        SELECT r.new_category_id FROM migration_0068_resolved r
        WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
      ) = 'unclassified' THEN 'unclassified' ELSE 'classified' END,
      '$.categoryClassification.reason', CASE WHEN (
        SELECT r.new_category_id FROM migration_0068_resolved r
        WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
      ) = 'unclassified' THEN 'insufficient_evidence' ELSE '' END,
      '$.categoryClassification.source', 'taxonomy_v3_migration',
      '$.categoryClassification.categoryIds', json_array((
        SELECT r.new_category_id FROM migration_0068_resolved r
        WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
      )),
      '$.categoryClassification.candidateCategoryIds', json('[]'),
      '$.categoryClassification.confidence', (
        SELECT r.confidence FROM migration_0068_resolved r
        WHERE r.entity_type = 'product_primary' AND r.entity_id = p.id
      )
    );

-- An explicit admin category is a single-product correction and therefore owns the direct leaf.
UPDATE products
SET direct_category_ids = json_array(primary_category_id)
WHERE id IN (
  SELECT listing_product_id FROM product_admin_overrides WHERE primary_category_id IS NOT NULL
);

-- Collapse catalog categories that map to the same v3 leaf and select one deterministic primary.
CREATE TABLE migration_0068_catalog_categories AS
SELECT r.entity_id AS product_id, new_category_id AS category_id,
       MAX(was_primary) AS was_primary,
       MIN(position) AS first_position
FROM migration_0068_resolved r
WHERE r.entity_type = 'catalog'
  AND (r.new_category_id <> 'unclassified' OR NOT EXISTS (
    SELECT 1 FROM migration_0068_resolved concrete
    WHERE concrete.entity_type = 'catalog' AND concrete.entity_id = r.entity_id
      AND concrete.new_category_id <> 'unclassified'
  ))
GROUP BY product_id, new_category_id;

DELETE FROM knowledge_catalog_product_categories;
INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
SELECT product_id, category_id,
       CASE WHEN ROW_NUMBER() OVER (
         PARTITION BY product_id
         ORDER BY was_primary DESC, first_position, c.root_order, c.leaf_order, category_id
       ) = 1 THEN 1 ELSE 0 END
FROM migration_0068_catalog_categories mapped
JOIN migration_0068_categories c ON c.id = mapped.category_id;

-- Rebuild listing category membership after dropping only the two category-override guards.
DROP TRIGGER IF EXISTS product_admin_overrides_categories_bd;
DROP TRIGGER IF EXISTS product_admin_overrides_categories_bi;

DELETE FROM product_categories;
INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct)
SELECT p.id, CAST(j.value AS TEXT), 1
FROM products p, json_each(p.direct_category_ids) j
JOIN migration_0068_categories c ON c.id = CAST(j.value AS TEXT)
WHERE c.parent_id IS NOT NULL;

INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct)
SELECT pc.product_id, c.parent_id, 0
FROM product_categories pc
JOIN migration_0068_categories c ON c.id = pc.category_id
WHERE c.parent_id IS NOT NULL;

CREATE TRIGGER product_admin_overrides_categories_bd
BEFORE DELETE ON product_categories
WHEN EXISTS (
  SELECT 1 FROM product_admin_overrides o
  WHERE o.listing_product_id = OLD.product_id AND o.primary_category_id IS NOT NULL
)
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

-- Refresh the category portions of both search read models without changing entity identity or
-- offer membership. Updating products above already refreshed the listing FTS projection.
UPDATE product_search_entities AS e
SET primary_category_id = COALESCE(
  (SELECT kpc.category_id
   FROM knowledge_catalog_product_categories kpc
   WHERE kpc.product_id = e.catalog_product_id
   ORDER BY kpc.is_primary DESC, kpc.category_id LIMIT 1),
  (SELECT p.primary_category_id FROM products p WHERE p.id = e.fallback_listing_id),
  (SELECT p.primary_category_id
   FROM product_search_entity_offers m JOIN products p ON p.id = m.listing_product_id
   WHERE m.entity_id = e.id ORDER BY p.id LIMIT 1),
  'unclassified'
);

DELETE FROM product_search_entity_categories;
INSERT OR IGNORE INTO product_search_entity_categories(entity_id, category_id, is_direct)
SELECT m.entity_id, pc.category_id, MAX(pc.is_direct)
FROM product_search_entity_offers m
JOIN products p ON p.id = m.listing_product_id AND p.is_active = 1
JOIN product_categories pc ON pc.product_id = p.id
GROUP BY m.entity_id, pc.category_id;

UPDATE product_search_entities AS e
SET direct_category_ids = COALESCE((
  SELECT group_concat(category_id)
  FROM (
    SELECT ec.category_id
    FROM product_search_entity_categories ec
    JOIN migration_0068_categories c ON c.id = ec.category_id
    WHERE ec.entity_id = e.id AND ec.is_direct = 1
    ORDER BY c.root_order, c.leaf_order, ec.category_id
  )
), '');

UPDATE product_search_entities AS e
SET title_terms = aggregate.title_terms,
    category_terms = aggregate.category_terms
FROM (
  SELECT sampled.entity_id,
         TRIM(COALESCE(group_concat(sampled.title_terms, ' '), '')) AS title_terms,
         TRIM(COALESCE(group_concat(sampled.category_terms, ' '), '')) AS category_terms
  FROM (
    SELECT m.entity_id,
           TRIM(COALESCE(NULLIF(sp.title, ''), p.title) || ' ' ||
                COALESCE(sp.manufacturer_terms, '') || ' ' || COALESCE(sp.model_terms, '')) AS title_terms,
           COALESCE(NULLIF(sp.category_terms, ''), p.category) AS category_terms,
           ROW_NUMBER() OVER (PARTITION BY m.entity_id ORDER BY p.id) AS rn
    FROM product_search_entity_offers m
    JOIN products p ON p.id = m.listing_product_id
    LEFT JOIN product_search_projection sp ON sp.product_id = p.id
    WHERE p.is_active = 1
  ) sampled
  WHERE sampled.rn <= 3
  GROUP BY sampled.entity_id
) aggregate
WHERE e.id = aggregate.entity_id;

DROP TABLE migration_0068_catalog_categories;
DROP TABLE migration_0068_legacy_facets;
DROP TABLE migration_0068_resolved;
DROP TABLE migration_0068_evidence;
DROP TABLE migration_0068_candidates;
DROP TABLE migration_0068_legacy_map;
DROP TABLE migration_0068_categories;
