-- Move the trailing-90-day price-index median off the public request path.
--
-- The durable aggregate already stores recent_asking_median_yen.  This migration adds a tiny
-- per-product expiry projection so hourly maintenance only recomputes products whose
-- oldest still-recent asking sample has actually crossed the 90-day boundary.
--
-- Existing rows are normalized by a resumable keyset backfill owned by scheduled maintenance.
-- This migration intentionally does no history-sized SELECT, window ranking, GROUP BY, or aggregate
-- UPDATE: production can apply the DDL even while the account is close to its daily D1 quota.
CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_recent_refreshes (
  catalog_product_id INTEGER PRIMARY KEY,
  next_expiry_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_index_recent_refresh_due
  ON knowledge_catalog_price_index_recent_refreshes(next_expiry_at, catalog_product_id)
  WHERE next_expiry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_catalog_price_index_recent_backfill_runs (
  backfill_key TEXT PRIMARY KEY,
  after_catalog_product_id INTEGER NOT NULL DEFAULT 0
    CHECK (after_catalog_product_id >= 0),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- One constant-size state write starts the background backfill.  The Worker advances this cursor
-- in the same D1 batch as at most 25 product-scoped projection refreshes.
INSERT OR IGNORE INTO knowledge_catalog_price_index_recent_backfill_runs(
  backfill_key,
  after_catalog_product_id,
  status,
  started_at,
  updated_at,
  completed_at
) VALUES (
  'recent-price-index-v1',
  0,
  'running',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);

-- New asking evidence is already synchronously folded into knowledge_catalog_price_indexes by the
-- scoped rollup trigger.  Maintain only the earliest possible time-driven change here; this avoids
-- touching or rereading the full sample ledger on public requests.
CREATE TRIGGER IF NOT EXISTS trg_price_index_recent_refresh_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
WHEN NEW.sample_kind = 'asking' AND NEW.price_yen IS NOT NULL
BEGIN
  INSERT INTO knowledge_catalog_price_index_recent_refreshes(
    catalog_product_id,
    next_expiry_at,
    updated_at
  )
  SELECT
    NEW.catalog_product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.observed_at, '+90 days'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE julianday(NEW.observed_at) >= julianday('now', '-90 days')
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    next_expiry_at = CASE
      WHEN knowledge_catalog_price_index_recent_refreshes.next_expiry_at IS NULL
        THEN excluded.next_expiry_at
      WHEN excluded.next_expiry_at < knowledge_catalog_price_index_recent_refreshes.next_expiry_at
        THEN excluded.next_expiry_at
      ELSE knowledge_catalog_price_index_recent_refreshes.next_expiry_at
    END,
    updated_at = excluded.updated_at;
END;

-- Updates/deletes are uncommon compared with append-only asking evidence.  The existing scoped
-- aggregate trigger makes their value correct immediately; mark the product due so the next sweep
-- recalculates the next time boundary rather than attempting fragile incremental expiry repair.
CREATE TRIGGER IF NOT EXISTS trg_price_index_recent_refresh_update
AFTER UPDATE OF catalog_product_id, sample_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
BEGIN
  INSERT INTO knowledge_catalog_price_index_recent_refreshes(
    catalog_product_id, next_expiry_at, updated_at
  ) VALUES (
    OLD.catalog_product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-0.001 seconds'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    next_expiry_at = excluded.next_expiry_at,
    updated_at = excluded.updated_at;

  INSERT INTO knowledge_catalog_price_index_recent_refreshes(
    catalog_product_id, next_expiry_at, updated_at
  ) VALUES (
    NEW.catalog_product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-0.001 seconds'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    next_expiry_at = excluded.next_expiry_at,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_price_index_recent_refresh_delete
AFTER DELETE ON knowledge_catalog_price_index_samples
WHEN OLD.sample_kind = 'asking'
BEGIN
  INSERT INTO knowledge_catalog_price_index_recent_refreshes(
    catalog_product_id, next_expiry_at, updated_at
  )
  SELECT
    OLD.catalog_product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-0.001 seconds'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1
    FROM knowledge_catalog_products
    WHERE id = OLD.catalog_product_id
  )
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    next_expiry_at = excluded.next_expiry_at,
    updated_at = excluded.updated_at;
END;
