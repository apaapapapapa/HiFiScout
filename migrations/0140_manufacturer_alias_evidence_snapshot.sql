-- A derived copy of the resolver-visible manufacturer alias rows, keyed by the registry clock that
-- every resolver-visible edit already advances. A fresh isolate (each crawl's Durable Object, for
-- example) reads this one row instead of scanning every alias and its manufacturer again. It is
-- valid only while its generation, version and query definition all match; anything else rebuilds.
-- The registry triggers are therefore the snapshot's only invalidation: a later migration that
-- rewrites alias or manufacturer rows without firing them (a table rebuild, for example) must also
-- advance admin_manufacturer_registry_clock.version.
CREATE TABLE manufacturer_alias_evidence_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  built_at TEXT NOT NULL
);
