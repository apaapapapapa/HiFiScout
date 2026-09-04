-- Let one transaction collapse many sample writes into one aggregate recompute per product.
--
-- Migration 0071 made the sample triggers recompute one product instead of the whole ledger, which
-- is the right cost for the paths that write one or two samples at a time: an identity change, a
-- sold-out observation, a listing deactivation. It is the wrong cost for the price-history backfill,
-- which writes up to fifty samples in one transaction and can write many of them for the same
-- product. Each of those rows pays a full recompute of that product -- four passes over every sample
-- it already has -- so a product carrying a thousand samples is re-read four thousand rows deep once
-- per row written, for a value that only the last write leaves standing.
--
-- SQLite has no statement-level trigger, so a per-row trigger cannot coalesce by itself. What it can
-- do is defer. While a deferral row exists the triggers record which products changed instead of
-- recomputing them, and the transaction that opened the deferral drains that record before it
-- commits.
--
-- Aggregates stay synchronous. The drain runs inside the same transaction as the writes, so no
-- reader outside it can observe a sample without its aggregate. Nothing about the visible ordering
-- changes; only the number of times the same answer is computed does.
--
-- The deferral is scoped by the transaction holding it. D1 runs a batch as one transaction, so an
-- uncommitted deferral row is invisible to every other writer, and a batch that fails rolls the
-- deferral back with everything else. There is no state to leak and no window in which some other
-- path silently skips its recompute.
--
-- Mixed-version safety: this migration is applied before the Worker that uses it ships. Until then
-- no deferral is ever opened, `NOT EXISTS` is always true, and the immediate triggers below fire on
-- every row exactly as 0071 wrote them. The same holds if the Worker is rolled back afterwards.

CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_refresh_deferrals (
  token TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL
);

-- One row per product touched while a deferral is open. The primary key is what does the
-- coalescing: ten samples for one product attempt ten inserts and leave one row.
CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_dirty_products (
  catalog_product_id INTEGER PRIMARY KEY
);

-- The deferred half. `OLD` matters as much as `NEW`: a sample that moves between catalog products
-- leaves the product it came from with a different set, and after the row is written only the
-- trigger still knows which product that was. The application cannot derive it, which is why the
-- record is kept here rather than assembled by the caller.

CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_insert_deferred
AFTER INSERT ON knowledge_catalog_price_index_samples
WHEN EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id)
  VALUES (NEW.catalog_product_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_update_deferred
AFTER UPDATE OF catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
WHEN EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id)
  VALUES (OLD.catalog_product_id);
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id)
  VALUES (NEW.catalog_product_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_price_index_sample_delete_deferred
AFTER DELETE ON knowledge_catalog_price_index_samples
WHEN EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id)
  VALUES (OLD.catalog_product_id);
END;

-- The immediate half. Below this line the three triggers are 0071's, unchanged except for the
-- `WHEN NOT EXISTS` guard on each: every path that does not open a deferral -- identity changes,
-- sold-out observations, listing deactivation, admin edits -- keeps recomputing synchronously on
-- every row, at exactly the cost 0071 established.

DROP TRIGGER IF EXISTS trg_price_index_sample_insert;
DROP TRIGGER IF EXISTS trg_price_index_sample_delete;
DROP TRIGGER IF EXISTS trg_price_index_sample_update;

CREATE TRIGGER trg_price_index_sample_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
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
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
  ),
  signal_stats AS (
    SELECT
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
  )
  SELECT
    NEW.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
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
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
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
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
  ),
  signal_stats AS (
    SELECT
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
  )
  SELECT
    OLD.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
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

-- A sample can move between catalog products, so both aggregates are refreshed.
CREATE TRIGGER trg_price_index_sample_update
AFTER UPDATE OF catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
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
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
  ),
  signal_stats AS (
    SELECT
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
  )
  SELECT
    OLD.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
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
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
  ),
  signal_stats AS (
    SELECT
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
  )
  SELECT
    NEW.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
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
