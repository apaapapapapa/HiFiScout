-- Attempts and ambiguous checks are not proof of availability. Do not backfill this from
-- last_inventory_checked_at; only a new, explicit in-stock detail observation may set it.
ALTER TABLE products ADD COLUMN last_confirmed_available_at TEXT;
