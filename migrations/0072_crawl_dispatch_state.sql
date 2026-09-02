-- #417 Phase 7: move crawl control state away from Queue-specific queued_*/crawl_lease_* names.
--
-- Deploy applies migrations before the Worker, so this migration is intentionally additive.
-- During Worker rollout, old and new isolates can overlap. Temporary bidirectional triggers keep
-- both schemas fenced against each other until every isolate uses dispatch_* columns. A follow-up
-- migration removes the bridge and legacy columns after this runtime has reached production.

ALTER TABLE shop_sync_state ADD COLUMN dispatch_requested_at TEXT;
ALTER TABLE shop_sync_state ADD COLUMN dispatch_token TEXT;
ALTER TABLE shop_sync_state ADD COLUMN dispatch_last_sent_at TEXT;

UPDATE shop_sync_state
SET dispatch_requested_at = queued_at,
    dispatch_token = CASE
      WHEN queued_at IS NULL THEN NULL
      ELSE COALESCE(queued_token, shop_key || ':' || queued_at)
    END,
    dispatch_last_sent_at = CASE
      WHEN queued_at IS NULL THEN NULL
      ELSE COALESCE(queued_last_sent_at, queued_at)
    END;

CREATE INDEX IF NOT EXISTS idx_shop_sync_state_dispatch_requested_at
  ON shop_sync_state(dispatch_requested_at)
  WHERE dispatch_requested_at IS NOT NULL;

-- Pre-Phase-7 Worker -> Phase-7 schema.
CREATE TRIGGER IF NOT EXISTS trg_shop_sync_state_legacy_dispatch_insert
AFTER INSERT ON shop_sync_state
WHEN NEW.queued_at IS NOT NULL
BEGIN
  UPDATE shop_sync_state
  SET dispatch_requested_at = NEW.queued_at,
      dispatch_token = COALESCE(NEW.queued_token, NEW.shop_key || ':' || NEW.queued_at),
      dispatch_last_sent_at = COALESCE(NEW.queued_last_sent_at, NEW.queued_at)
  WHERE shop_key = NEW.shop_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_shop_sync_state_legacy_dispatch_update
AFTER UPDATE OF queued_at, queued_token, queued_last_sent_at ON shop_sync_state
WHEN NEW.dispatch_requested_at IS NOT NEW.queued_at
  OR NEW.dispatch_token IS NOT CASE
    WHEN NEW.queued_at IS NULL THEN NULL
    ELSE COALESCE(NEW.queued_token, NEW.shop_key || ':' || NEW.queued_at)
  END
  OR NEW.dispatch_last_sent_at IS NOT CASE
    WHEN NEW.queued_at IS NULL THEN NULL
    ELSE COALESCE(NEW.queued_last_sent_at, NEW.queued_at)
  END
BEGIN
  UPDATE shop_sync_state
  SET dispatch_requested_at = NEW.queued_at,
      dispatch_token = CASE
        WHEN NEW.queued_at IS NULL THEN NULL
        ELSE COALESCE(NEW.queued_token, NEW.shop_key || ':' || NEW.queued_at)
      END,
      dispatch_last_sent_at = CASE
        WHEN NEW.queued_at IS NULL THEN NULL
        ELSE COALESCE(NEW.queued_last_sent_at, NEW.queued_at)
      END
  WHERE shop_key = NEW.shop_key;
END;

-- Phase-7 Worker -> pre-Phase-7 schema. This closes the mixed-isolate race during deploy: an old
-- Worker sees a new Worker's reservation and therefore cannot create a second logical crawl.
CREATE TRIGGER IF NOT EXISTS trg_shop_sync_state_dispatch_legacy_insert
AFTER INSERT ON shop_sync_state
WHEN NEW.dispatch_requested_at IS NOT NULL
  AND (
    NEW.queued_at IS NOT NEW.dispatch_requested_at
    OR NEW.queued_token IS NOT NEW.dispatch_token
    OR NEW.queued_last_sent_at IS NOT NEW.dispatch_last_sent_at
  )
BEGIN
  UPDATE shop_sync_state
  SET queued_at = NEW.dispatch_requested_at,
      queued_token = NEW.dispatch_token,
      queued_last_sent_at = NEW.dispatch_last_sent_at
  WHERE shop_key = NEW.shop_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_shop_sync_state_dispatch_legacy_update
AFTER UPDATE OF dispatch_requested_at, dispatch_token, dispatch_last_sent_at ON shop_sync_state
WHEN NEW.queued_at IS NOT NEW.dispatch_requested_at
  OR NEW.queued_token IS NOT NEW.dispatch_token
  OR NEW.queued_last_sent_at IS NOT NEW.dispatch_last_sent_at
BEGIN
  UPDATE shop_sync_state
  SET queued_at = NEW.dispatch_requested_at,
      queued_token = NEW.dispatch_token,
      queued_last_sent_at = NEW.dispatch_last_sent_at
  WHERE shop_key = NEW.shop_key;
END;
