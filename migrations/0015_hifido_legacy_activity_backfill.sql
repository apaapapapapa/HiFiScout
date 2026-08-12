-- Correct legacy HiFiDo rows that were first discovered by the rotating historical recheck.
-- These rows previously used crawler discovery time as user-facing activity even when the
-- retailer's own arrival date showed that the listing was already older than 48 hours.
UPDATE products
SET last_activity_at = source_published_at
WHERE shop_key = 'hifido'
  AND source_published_at IS NOT NULL
  AND last_activity_at = first_seen_at
  AND datetime(source_published_at) < datetime(first_seen_at, '-48 hours');

-- Existing rows acquire source_published_at lazily as HiFiDo pages are revisited. Keep the
-- same correction active for the first source timestamp backfill, while preserving rows that
-- have had a genuine user-facing activity after initial discovery.
CREATE TRIGGER IF NOT EXISTS trg_hifido_source_activity_backfill
AFTER UPDATE OF source_published_at ON products
WHEN NEW.shop_key = 'hifido'
  AND OLD.source_published_at IS NULL
  AND NEW.source_published_at IS NOT NULL
  AND OLD.last_activity_at = OLD.first_seen_at
  AND datetime(NEW.source_published_at) < datetime(NEW.first_seen_at, '-48 hours')
BEGIN
  UPDATE products
  SET last_activity_at = NEW.source_published_at
  WHERE id = NEW.id;
END;
