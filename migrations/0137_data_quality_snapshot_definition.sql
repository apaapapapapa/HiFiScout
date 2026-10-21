-- A saved snapshot may be reused while its source_revision still matches the shop's revision. The
-- revision proves the inputs are unchanged, not the aggregate's formula, so each row also records
-- the definition that computed it. Rows from older Workers stay NULL and are never reused.
ALTER TABLE data_quality_runs ADD COLUMN source_definition TEXT;
