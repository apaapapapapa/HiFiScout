-- Observed crawl cost per shop, used only as a scheduling hint.
--
-- Lane selection previously inferred workload from `defaultMaxPages`, which says nothing about how
-- many pages a shop discovers at runtime. These columns are what a shop actually cost, so a shop
-- that turns out to be large is scheduled as large from its own history rather than from a
-- declaration nobody updated.
--
-- Every column is a high-water mark: it only ever moves up. That is what keeps a shop from
-- flapping between lanes as its inventory rises and falls, and it errs toward the heavy lane,
-- which is the direction that does not reproduce the incident this came from.
CREATE TABLE IF NOT EXISTS crawl_workload_observations (
  shop_key TEXT PRIMARY KEY,
  peak_item_count INTEGER NOT NULL DEFAULT 0,
  budget_exhausted_count INTEGER NOT NULL DEFAULT 0,
  last_budget_exhausted_at TEXT,
  updated_at TEXT NOT NULL
);
