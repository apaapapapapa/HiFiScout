-- Record which authenticated subject produced an administrative change.
--
-- The value is the stable Access identity (`access:user:<issuer host>/<sub>`, or
-- `access:service:<issuer host>/<client id>`), never the display email: an address can be
-- reassigned, and history rows should not accumulate a second copy of it.
--
-- Existing rows keep the empty default, which reads as "unknown". They are deliberately NOT
-- backfilled: nobody can say now who made those edits, and attributing them to whoever happens to
-- be the current operator would be worse than an honest gap. No UPDATE runs over either table.
ALTER TABLE admin_product_change_log ADD COLUMN actor TEXT NOT NULL DEFAULT '';

-- The CSV receipt is written once per change at preview time and updated in place on apply, so the
-- actor recorded here is the subject that requested the import.
ALTER TABLE admin_csv_import_changes ADD COLUMN actor TEXT NOT NULL DEFAULT '';
