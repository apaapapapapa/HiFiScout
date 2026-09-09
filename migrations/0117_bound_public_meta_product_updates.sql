-- Product classification changes are common during crawl and remediation. The 0103 trigger
-- expressed the old/new counter delta as a tuple IN over an EXCEPT subquery. D1 planned that
-- shape from public_meta_counts and scanned the whole vocabulary even when a canonical category
-- change did not alter any public counter. Keep the same BEFORE-trigger semantics (including
-- reversal by manual-authority AFTER triggers), but address each possible counter by its primary
-- key. Only a real old/new membership delta writes a counter.
DROP TRIGGER IF EXISTS public_meta_products_update;

CREATE TRIGGER public_meta_products_update
BEFORE UPDATE OF shop_key, manufacturer_id, manufacturer, is_active, primary_category_id, metadata_json ON products
WHEN OLD.is_active IS NOT NEW.is_active OR (OLD.is_active = 1 AND (OLD.shop_key IS NOT NEW.shop_key OR OLD.manufacturer_id IS NOT NEW.manufacturer_id OR OLD.manufacturer IS NOT NEW.manufacturer OR OLD.primary_category_id IS NOT NEW.primary_category_id OR (CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END) IS NOT (CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END)))
BEGIN
  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'shop' AND group_key = '' AND value = OLD.shop_key
    AND OLD.is_active = 1
    AND NOT (NEW.is_active = 1 AND OLD.shop_key IS NEW.shop_key);
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'shop', '', NEW.shop_key, 1
  WHERE NEW.is_active = 1
    AND NOT (OLD.is_active = 1 AND OLD.shop_key IS NEW.shop_key)
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'manufacturer' AND group_key = OLD.manufacturer_id AND value = OLD.manufacturer
    AND OLD.is_active = 1 AND OLD.manufacturer <> ''
    AND NOT (NEW.is_active = 1 AND NEW.manufacturer <> ''
      AND OLD.manufacturer_id IS NEW.manufacturer_id AND OLD.manufacturer IS NEW.manufacturer);
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'manufacturer', NEW.manufacturer_id, NEW.manufacturer, 1
  WHERE NEW.is_active = 1 AND NEW.manufacturer <> ''
    AND NOT (OLD.is_active = 1 AND OLD.manufacturer <> ''
      AND OLD.manufacturer_id IS NEW.manufacturer_id AND OLD.manufacturer IS NEW.manufacturer)
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'taxonomy' AND group_key = '' AND value = 'active_count'
    AND OLD.is_active = 1 AND NEW.is_active IS NOT 1;
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'taxonomy', '', 'active_count', 1
  WHERE NEW.is_active = 1 AND OLD.is_active IS NOT 1
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'taxonomy' AND group_key = '' AND value = 'unclassified_count'
    AND OLD.is_active = 1 AND OLD.primary_category_id = 'unclassified'
    AND NOT (NEW.is_active = 1 AND NEW.primary_category_id = 'unclassified');
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'taxonomy', '', 'unclassified_count', 1
  WHERE NEW.is_active = 1 AND NEW.primary_category_id = 'unclassified'
    AND NOT (OLD.is_active = 1 AND OLD.primary_category_id = 'unclassified')
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'taxonomy' AND group_key = '' AND value = 'low_confidence_count'
    AND OLD.is_active = 1
    AND (CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END)
    AND NOT (NEW.is_active = 1 AND COALESCE((CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END), 0));
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'taxonomy', '', 'low_confidence_count', 1
  WHERE NEW.is_active = 1
    AND (CASE WHEN json_valid(COALESCE(NEW.metadata_json, '')) THEN CAST(json_extract(NEW.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END)
    AND NOT (OLD.is_active = 1 AND COALESCE((CASE WHEN json_valid(COALESCE(OLD.metadata_json, '')) THEN CAST(json_extract(OLD.metadata_json, '$.categoryClassification.confidence') AS REAL) BETWEEN 0.000001 AND 0.649999 ELSE 0 END), 0))
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'taxonomy' AND group_key = '' AND value = 'legacy_residue_count'
    AND OLD.is_active = 1
    AND OLD.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory')
    AND NOT (NEW.is_active = 1 AND NEW.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'));
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'taxonomy', '', 'legacy_residue_count', 1
  WHERE NEW.is_active = 1
    AND NEW.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory')
    AND NOT (OLD.is_active = 1 AND OLD.primary_category_id IN ('amplifier','digital','analog','speaker','headphone_group','accessories','cable','integrated_amp','pre_amp','power_amp','headphone_amp','av_amp','dac','network_player','cd_sacd_player','transport','dap','network_switch','optical_isolator','router','music_server','master_clock','turntable','tonearm','cartridge','headshell','phono_eq','phono_step_up_transformer','speaker_bookshelf','speaker_floorstanding','center_speaker','subwoofer','active_speaker','wired_headphone','wired_earphone','btw_headphone','btw_earphone','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_strip','clean_power','vacuum_tube','other_accessory','dj_dtm','other','network_transport','cd_sacd_transport','accessory','speaker_other','headphone','earphone','power_accessory'))
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;

  UPDATE public_meta_counts SET row_count = row_count - 1
  WHERE kind = 'taxonomy' AND group_key = '' AND value = 'legacy_other_count'
    AND OLD.is_active = 1 AND OLD.primary_category_id = 'other'
    AND NOT (NEW.is_active = 1 AND NEW.primary_category_id = 'other');
  INSERT INTO public_meta_counts(kind, group_key, value, row_count)
  SELECT 'taxonomy', '', 'legacy_other_count', 1
  WHERE NEW.is_active = 1 AND NEW.primary_category_id = 'other'
    AND NOT (OLD.is_active = 1 AND OLD.primary_category_id = 'other')
  ON CONFLICT(kind, group_key, value) DO UPDATE SET row_count = row_count + 1;
END;
