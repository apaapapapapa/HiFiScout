-- Verified product knowledge is kept separate from seller observations and inferred classifications.
CREATE TABLE IF NOT EXISTS knowledge_catalog_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer_id TEXT NOT NULL,
  canonical_model TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  canonical_name TEXT NOT NULL DEFAULT '',
  lifecycle_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (lifecycle_status IN ('unknown', 'active', 'discontinued')),
  verification_status TEXT NOT NULL DEFAULT 'verified'
    CHECK (verification_status IN ('verified', 'rejected')),
  review_status TEXT NOT NULL DEFAULT 'current'
    CHECK (review_status IN ('current', 'due')),
  first_verified_at TEXT,
  last_verified_at TEXT,
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(manufacturer_id, normalized_model)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_products_manufacturer
  ON knowledge_catalog_products(manufacturer_id, verification_status);
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_products_review
  ON knowledge_catalog_products(review_status, last_verified_at);

CREATE TABLE IF NOT EXISTS knowledge_catalog_product_categories (
  product_id INTEGER NOT NULL,
  category_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY(product_id, category_id),
  FOREIGN KEY(product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_categories_category
  ON knowledge_catalog_product_categories(category_id, product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_catalog_primary_category
  ON knowledge_catalog_product_categories(product_id)
  WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS knowledge_catalog_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  alias_type TEXT NOT NULL DEFAULT 'model'
    CHECK (alias_type IN ('model', 'name')),
  created_at TEXT NOT NULL,
  UNIQUE(product_id, alias_type, normalized_alias),
  FOREIGN KEY(product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_aliases_lookup
  ON knowledge_catalog_aliases(alias_type, normalized_alias, product_id);

CREATE TABLE IF NOT EXISTS knowledge_catalog_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('manufacturer_official', 'official_distributor', 'manufacturer_archive', 'trusted_catalog', 'manual_verified')),
  source_url TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'missing', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, source_type, source_url),
  FOREIGN KEY(product_id) REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_sources_product
  ON knowledge_catalog_sources(product_id, status);

-- Candidates are observations only. They must never be promoted to verified knowledge solely
-- because HiFiScout inferred a category for the corresponding seller listing.
CREATE TABLE IF NOT EXISTS knowledge_catalog_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  observed_manufacturer TEXT NOT NULL DEFAULT '',
  observed_model TEXT NOT NULL DEFAULT '',
  sample_title TEXT NOT NULL DEFAULT '',
  candidate_category_ids TEXT NOT NULL DEFAULT '[]',
  active_listing_count INTEGER NOT NULL DEFAULT 0,
  shop_count INTEGER NOT NULL DEFAULT 0,
  unclassified_count INTEGER NOT NULL DEFAULT 0,
  priority_score INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'matched', 'ignored')),
  catalog_product_id INTEGER,
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(manufacturer_id, normalized_model),
  FOREIGN KEY(catalog_product_id) REFERENCES knowledge_catalog_products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_candidates_priority
  ON knowledge_catalog_candidates(review_status, priority_score DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_catalog_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  catalog_products INTEGER NOT NULL DEFAULT 0,
  due_products INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  pending_candidates INTEGER NOT NULL DEFAULT 0,
  matched_candidates INTEGER NOT NULL DEFAULT 0,
  reclassified_products INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_review_runs_started
  ON knowledge_catalog_review_runs(started_at DESC);
