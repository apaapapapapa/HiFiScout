# Data Quality

HiFiScout Phase 2 treats data quality as a domain concern after crawl, normalization, persistence, search projection, and Product Identity Resolution. A crawl can succeed while the resulting data quality is `warning` or `critical`; quality evaluation failures are logged and do not convert a successful crawl into a crawler failure.

## Architecture

The crawler records run-level facts and delegates evaluation/persistence to the common Data Quality layer. Shop-specific quality logic is not embedded in crawler branches. Global thresholds live in `src/data-quality/quality-thresholds.js`; a shop adapter may declare a narrowly scoped `qualityThresholds` override when domain evidence justifies it.

`src/data-quality/quality-evaluator.js` is a pure-function-oriented evaluator. `src/db/data-quality-repository.js` owns D1 aggregation, persistence, latest/history queries, and API serialization. `migrations/0019_data_quality.sql` creates `data_quality_runs`, whose rows are linked to `crawl_runs` when available.

Snapshot quality and crawl-run quality are semantically separate even though they are persisted atomically in one bounded D1 history row. `snapshot_status` covers the current active-listing state; `run_status` covers parser, evidence, and item-count behavior for that crawl. `quality_status` is only the worst status across those groups. It is not a weighted composite score.

## Snapshot metrics

Snapshot metrics are calculated in D1 with `COUNT(*)` and `SUM(CASE ...)` over active listings for one shop. Products are not loaded wholesale into a Worker.

- Manufacturer Unknown: missing raw manufacturer plus raw manufacturer values that did not resolve through a known canonical manufacturer alias. Manufacturer normalization evidence is stored in existing bounded product metadata.
- Category Unclassified: `classification_status != 'classified'`. Canonical `other` remains separate as `other_category_count`.
- Product Identity Unresolved: reuses `product_identity_resolutions` and separately retains matched, unresolved, veto, and candidate counts.
- Inventory Unknown: `stock_status = 'unknown'`; all other canonical availability states are treated as known.
- Model Missing: denominator is `model_expected_count`, not all products. Classified accessory, cable, and canonical `other` listings are excluded from the initial model-required population.

Every ratio retains count and denominator. A zero denominator produces `rate: null` and `status: unknown` rather than an artificial 0% or 100%.

## Crawl-run metrics

- Parser Failure: page-level parse attempts, successes, failures, and failure rate.
- Item Count: previous/current count, absolute difference, and percentage difference. First crawls and missing baselines are `unknown` for this metric.
- Evidence Coverage: measures only anomaly events for which Evidence Archive is expected. Archived or deduplicated evidence counts as covered; failed or quota-suppressed archival counts as failed coverage. Normal products do not create an evidence denominator.

The existing Evidence Archive allow-list, redaction, deduplication, retention classes, R2 size limits, and quota protections are reused. Data Quality does not introduce a second evidence store.

## Status and thresholds

Statuses are `healthy`, `warning`, `critical`, and `unknown`. Exact boundaries are inclusive.

| Metric | Warning | Critical |
| --- | ---: | ---: |
| Manufacturer Unknown | >= 2% | >= 5% |
| Category Unclassified | >= 3% | >= 10% |
| Identity Unresolved | >= 20% | >= 40% |
| Inventory Unknown | >= 5% | >= 15% |
| Model Missing | >= 10% | >= 25% |
| Parser Failure | >= 2% | >= 10% |
| Item Count Drop | <= -20% | <= -50% |
| Evidence Coverage | <= 95% | <= 80% |

The thresholds intentionally start with the Phase 2 proposal because production quality baselines are not available to repository code or unauthenticated CI. They should be tuned only with observed production distributions, and shop overrides should remain exceptional.

## API

`GET /api/admin/data-quality/status` returns the overall status and latest quality record for each shop. Each shop exposes `snapshot` and `latestRun` separately, while the flattened `metrics` object supports lightweight operational UI consumers.

`GET /api/admin/data-quality/history?shop=<shop-key>&limit=<n>` returns crawl-linked history for one shop. The query is bounded to at most 200 rows. Both endpoints require the existing `ADMIN_TOKEN` bearer authorization.

## Observability

After evaluation, the crawler emits a structured `data_quality_evaluated` log with shop, crawl-run ID, status, item total, and quality rates. HTML and other evidence content are never included in the structured log. Evaluation failures emit `data_quality_evaluation_failure` without failing the crawl.

## Retention

Data Quality history defaults to 180 days through `DATA_QUALITY_RETENTION_DAYS`. Existing daily maintenance deletes old rows in the same bounded batch size used by other retention jobs (default 500, hard cap 1000). No unbounded history delete is performed.

## Performance

The primary snapshot query filters `products` by `shop_key` and `is_active`, aggregates in D1, and joins existing Product Identity Resolution rows by product ID. Migration 0019 adds a shop/active/classification/category index supporting this access path. History uses `(shop_key, evaluated_at DESC, id DESC)` and retention uses `(evaluated_at, id)`.

Infrastructure-level D1/R2 latency, storage, and error metrics remain in Cloudflare Observability as established in Phase 1; D1 stores only domain-significant quality results.

## Baseline and rollout

Migration 0017 introduced search/identity/evidence foundations and migration 0018 added Evidence Archive usage metadata. Deployment applies migrations before the Worker release, so Phase 2 migration 0019 is applied after those foundations.

Production percentages cannot be derived safely from the repository alone because the Admin API is authenticated and CI does not assume access to `ADMIN_TOKEN`. The first successful crawl per shop after deployment persists a Phase 2 baseline. Manufacturer resolution metadata is refreshed during normal product metadata synchronization; until a listing has been observed by the new code, missing manufacturer-normalization evidence is conservatively treated as unresolved rather than falsely claiming a canonical match.
