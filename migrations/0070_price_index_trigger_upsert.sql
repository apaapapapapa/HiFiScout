-- SQLite applies the conflict policy of an outer statement to writes performed by its triggers.
-- Product Identity replay uses INSERT ... ON CONFLICT DO UPDATE, so the sample-maintenance
-- triggers' legacy INSERT OR REPLACE could be downgraded to ABORT and fail when the aggregate row
-- already existed. Use an explicit UPSERT target instead; it remains deterministic when invoked
-- from another UPSERT and updates the aggregate without a transient delete/insert cycle.

DROP TRIGGER IF EXISTS trg_price_index_sample_insert;
DROP TRIGGER IF EXISTS trg_price_index_sample_delete;
DROP TRIGGER IF EXISTS trg_price_index_sample_update;

CREATE TRIGGER trg_price_index_sample_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
BEGIN
  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = NEW.catalog_product_id
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;

CREATE TRIGGER trg_price_index_sample_delete
AFTER DELETE ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = OLD.catalog_product_id
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;

CREATE TRIGGER trg_price_index_sample_update
AFTER UPDATE OF catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = OLD.catalog_product_id
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  SELECT
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM knowledge_catalog_price_index_rollup
  WHERE catalog_product_id = NEW.catalog_product_id
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;
