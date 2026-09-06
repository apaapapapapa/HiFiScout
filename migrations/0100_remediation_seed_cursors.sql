-- Five bounded selector checkpoints and one rotation position. No product rewrite or new
-- index on a frequently written table; queue insertion commits before its checkpoint advances.
CREATE TABLE data_quality_remediation_seed_cursors (
  selector TEXT PRIMARY KEY,
  version_key TEXT NOT NULL,
  after_version INTEGER NOT NULL,
  after_id INTEGER NOT NULL
) WITHOUT ROWID;
