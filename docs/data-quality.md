# Data Quality

HiFiScout Phase 2 treats data quality as a domain concern after crawl, normalization, persistence, search projection, and Product Identity Resolution. A crawl can succeed while the resulting data quality is `warning` or `critical`; quality evaluation failures are logged and do not convert a successful crawl into a crawler failure.

## Architecture

The crawler records run-level facts and delegates evaluation/persistence to the common Data Quality layer. Shop-specific quality logic is not embedded in crawler branches. Global thresholds live in `src/data-quality/quality-thresholds.ts`; a shop adapter may declare a narrowly scoped `qualityThresholds` override when domain evidence justifies it.

`src/data-quality/quality-evaluator.ts` is a pure-function-oriented evaluator. `src/db/data-quality-repository.ts` owns D1 aggregation, persistence, latest/history queries, and API serialization. `migrations/0019_data_quality.sql` creates `data_quality_runs`, whose rows are linked to `crawl_runs` when available.

Snapshot quality and crawl-run quality are semantically separate even though they are persisted atomically in one bounded D1 history row. `snapshot_status` covers the current active-listing state; `run_status` covers parser, evidence, and item-count behavior for that crawl. `quality_status` is only the worst status across those groups. It is not a weighted composite score.

## Snapshot metrics

Snapshot metrics are calculated in D1 with `COUNT(*)` and `SUM(CASE ...)` over active listings for one shop. Products are not loaded wholesale into a Worker.

- Manufacturer Unknown: listings whose dedicated `manufacturer_resolution_status` is not `resolved`, split into missing and non-empty raw seller values. Raw evidence, normalized raw keys, canonical IDs, method, confidence, and resolver version are stored explicitly; bounded metadata keeps the corresponding explanation for compatibility and audit.
- Category Unclassified: `classification_status != 'classified'`. Canonical `other` remains separate as `other_category_count`.
- Product Identity Unresolved: denominator is every active listing. Explicit `unresolved` resolution rows count as unresolved, and any active listing with no `product_identity_resolutions` row is also treated as unresolved instead of disappearing from the metric. Stored/API detail `identityResolutionMissingCount` is derived as `active listings - matched - unresolved`, making coverage gaps directly observable.
- Inventory Unknown: `stock_status = 'unknown'`; all other canonical availability states are treated as known.
- Model Missing: denominator is `model_expected_count`, not all products. Canonical accessory leaves (`cable`, `rack`, `power_accessory`, `vacuum_tube`, `other_accessory`) and canonical `other` are excluded from the model-required population so products that legitimately may not have a model number are not counted as extraction failures. A listing counts as extracted only when its dedicated `model_resolution_status` is `resolved`; a `candidate` listing has a model the resolver could not fully classify and is counted as an extraction failure rather than as a success.

Every ratio retains count and denominator. A zero denominator produces `rate: null` and `status: unknown` rather than an artificial 0% or 100%.

For Product Identity specifically, the invariant is:

```text
active listings = matched resolutions + unresolved resolutions + missing resolution rows
```

Missing resolution rows are a data-quality failure state, not a separate population excluded from the denominator.

## Crawl-run metrics

- Parser Failure: page-level parse attempts, successes, failures, and failure rate.
- Item Count: previous/current count, absolute difference, and percentage difference. First crawls and missing baselines are `unknown` for this metric.
- Evidence Coverage: measures only anomaly events for which Evidence Archive is expected. Archived or deduplicated evidence counts as covered; failed or quota-suppressed archival counts as failed coverage. Normal products do not create an evidence denominator.

The existing Evidence Archive allow-list, redaction, deduplication, retention classes, R2 size limits, and quota protections are reused. Data Quality does not introduce a second evidence store.

## Status and thresholds

Statuses are `healthy`, `warning`, `critical`, and `unknown`. High-error thresholds and item-count drops use inclusive boundaries; Evidence Coverage follows the proposed strict “below” boundaries.

| Metric | Warning | Critical |
| --- | ---: | ---: |
| Manufacturer Unknown | >= 2% | >= 5% |
| Category Unclassified | >= 3% | >= 10% |
| Identity Unresolved | >= 20% | >= 40% |
| Inventory Unknown | >= 5% | >= 15% |
| Model Missing | >= 10% | >= 25% |
| Parser Failure | >= 2% | >= 10% |
| Item Count Drop | <= -20% | <= -50% |
| Evidence Coverage | < 95% | < 80% |

The thresholds intentionally start with the Phase 2 proposal because production quality baselines are not available to repository code or unauthenticated CI. They should be tuned only with observed production distributions, and shop overrides should remain exceptional.

## API

`GET /api/admin/data-quality/status` returns the overall status and latest quality record for each shop. Each shop exposes `snapshot` and `latestRun` separately, while the flattened `metrics` object supports lightweight operational UI consumers. The `details` object includes `identityResolutionMissingCount` so operators can distinguish ordinary unresolved identities from listings that have no resolution row at all. Each shop also carries `remediationSlo` (the post-Phase-4 milestone evaluation) and a `dashboard`: per-metric current/threshold/status, delta against the run immediately before it, a bounded recent-snapshot trend with direction (`improving`/`degrading`/`flat`/`unknown`), and delta against the source-controlled rollout baseline captured before this remediation program began (`docs/post-phase4-data-quality-baseline.md`). A top-level `remediation` object carries the same rollout baseline, the bounded query limits used to build it, remediation-queue backlog/failure health, the identity-resolution match-method distribution, and the highest-impact remediation contributors (unknown manufacturers, unresolved manufacturer/model pairs, category issues, model extraction patterns, and catalog candidate groups).

`GET /api/admin/data-quality/history?shop=<shop-key>&limit=<n>` returns crawl-linked history for one shop, i.e. the trend over recent snapshots in full. The query is bounded to at most 200 rows. Both endpoints require the existing `ADMIN_TOKEN` bearer authorization.

`GET /api/admin/data-quality/unresolved-manufacturers?limit=<n>` returns a bounded impact-ordered aggregation of unresolved normalized raw spellings. `POST /api/admin/manufacturer-aliases` writes an audited pending/verified/rejected alias. A verified write reprocesses one bounded page of matching stored listings without crawling a seller and returns `nextAfterId` when the caller must resume. The replay refreshes Product Identity and the Phase 4 product-search projection in dependency order. These endpoints also require `ADMIN_TOKEN`.

`GET /api/admin/data-quality/unresolved-models?limit=<n>` aggregates model extraction failures by canonical manufacturer, normalized model, status, and resolver method. `GET /api/admin/data-quality/unresolved-identity?limit=<n>` aggregates listings Product Identity still refuses to match, keyed by canonical manufacturer plus normalized model and carrying the current rejection reason, shop spread, and sample evidence — these are also the catalog candidate groups the status dashboard's top contributors surface. `GET /api/admin/data-quality/remediation-events?limit=<n>` returns recent before/after provenance for canonical changes that remediation caused.

`POST /api/admin/data-quality/replay-manufacturers` and `POST /api/admin/data-quality/replay-models` reprocess one bounded page of listings whose stored result predates the current resolver version or whose downstream projection refresh is still pending. `POST /api/admin/knowledge-catalog/replay` applies one verified catalog product to the listings it explains. `POST /api/admin/data-quality/rebuild` enqueues one bounded, restartable page of the full-recovery rebuild (see below) and returns the rebuild order alongside `nextAfterId`. All accept optional `afterId`/`limit` and return `nextAfterId` when the caller must resume; none contacts a seller site. All of these require `ADMIN_TOKEN`.

## Observability

After evaluation, the crawler emits a structured `data_quality_evaluated` log with shop, crawl-run ID, status, item total, and quality rates. HTML and other evidence content are never included in the structured log. Evaluation failures emit `data_quality_evaluation_failure` without failing the crawl.

The production deployment baseline independently recomputes Identity coverage over active listings. It reports `identity_resolution_missing_count` and `identity_resolution_coverage_rate`, uses all active listings as the Identity Unresolved denominator, and fails the deployment validation step if even one active listing has no Identity resolution row. This turns the active-listing Identity invariant into an operational regression gate rather than a one-time migration assertion.

The same step also counts product search read-model drift — active listings with no entity membership, memberships pointing at inactive listings, entities left without offers, and fallback entities whose listing has since been confirmed — and fails the deploy when any counter is non-zero. A product that stops being searchable is invisible to users but silent in the logs, which is why it is a gate rather than a dashboard; `POST /api/admin/product-search/rebuild` is the documented repair. See [Data platform architecture](./data-platform-architecture.md) for the read model itself.

## Retention

Data Quality history defaults to 180 days through `DATA_QUALITY_RETENTION_DAYS`. Existing daily maintenance deletes old rows in the same bounded batch size used by other retention jobs (default 500, hard cap 1000). No unbounded history delete is performed.

## Performance

The primary snapshot query filters `products` by `shop_key` and `is_active`, aggregates in D1, and joins existing Product Identity Resolution rows by product ID. Migration 0019 adds a shop/active/classification/category index supporting this access path. History uses `(shop_key, evaluated_at DESC, id DESC)` and retention uses `(evaluated_at, id)`.

Infrastructure-level D1/R2 latency, storage, and error metrics remain in Cloudflare Observability as established in Phase 1; D1 stores only domain-significant quality results.

## Baseline and rollout

Migration 0017 introduced search/identity/evidence foundations and migration 0018 added Evidence Archive usage metadata. Deployment applies migrations before the Worker release, so Phase 2 migration 0019 is applied after those foundations. Migration 0020 closes the rollout-era Identity coverage gap by inserting an explicit unresolved/backfill-pending resolution for every existing listing that lacks one.

Migration 0023 separates raw and derived manufacturer/model fields on seller listings and adds canonical manufacturer plus manufacturer-alias persistence. The public `manufacturer_id` remains a filter/display compatibility field; only `canonical_manufacturer_id` may load Product Identity candidates. Pending aliases and verified alias collisions therefore cannot silently merge products.

Migration 0024 gives Model Resolution its own rule version, extends Knowledge Catalog candidates with the evidence a reviewer needs (raw model variants, sample source URLs, identity rejection reason, unresolved-identity and `other` counts), and adds `data_quality_remediation_events` for before/after provenance. `model_resolver_version` defaults to `1` so every pre-existing listing stays behind the current resolver and is selectable for bounded replay. Resolver versions mean that the stored evidence was evaluated by that algorithm; `remediation_projection_required` separately remains set until projection, Product Identity, and search-entity refresh all succeed. A compare-and-clear operation token prevents an older concurrent replay from clearing newer pending work. A failed downstream pass is therefore selected again even after its derived fields and resolver version were persisted.

## Model Resolution

Model Resolution is a dedicated stage that runs after Manufacturer Resolution, because a resolved manufacturer is what makes brand-token removal and title extraction safe. It keeps three levels apart: `raw_model` is the seller's presentation and is never overwritten, `normalized_model` is the deterministic identity representation, and the canonical model stays in the Knowledge Catalog.

Merchandising annotations — listing state, condition, packaging, seller stock numbers, presentation colours — are removed only through an explicit vocabulary, and every removal is re-checked against the identity parts. A removal that would rewrite the identity string or drop a revision or edition token (`MK2`, `MK3`, `TX`, `SE`, `Signature`, `Meta`, `X`, `Limited`, `Reference`, `Pro`) is rejected. Residue that is neither clearly merchandising nor clearly identity is left in the model and the listing becomes a `candidate`: the data is never destroyed, but the resolver does not claim a resolved model either.

Title evidence is only used when the manufacturer resolved, and only when the remaining tail is model-shaped — at most three tokens and containing a digit. A title is prose with a model somewhere inside it, so an unbounded tail such as `Integrated Stereo Amplifier E-5000` stays a `candidate` instead of being recorded as a resolved model.

`candidate` and `unresolved` models cannot attach to a canonical product. This is a hard gate in `resolveProductIdentity`, not a convention: identity normalization strips exactly the residue that produced the status — `D-1000 MK2 特別仕様` normalizes to `D1000MK2` — so without the gate an unclassified edition would exact-match the base product at high confidence. Gated listings are recorded as `unresolved` with `rejected_by = ["unresolved_model"]`, keeping their normalized model so they still group for remediation.

## Remediation loop

Listings that cannot resolve are aggregated by canonical manufacturer plus normalized model and prioritized by impact — unclassified listings first, then canonical `other`, then unresolved identity, then shop spread, then listing count. Cross-shop repetition contributes to priority but is never treated as proof of product identity; candidate creation is not verification.

When a catalog entry becomes verified, the review run's finalizer replays the listings it explains: Product Identity is re-run and the Phase 4 search projection, entity, and offer membership are refreshed in that dependency order, with no seller fetch. Only listings whose identity actually moved produce a provenance row, so the event table stays proportional to how much data improved rather than to how often replay ran. Alias-driven manufacturer and model corrections record provenance the same way.

The backlog is selected by a durable watermark, not a time window: a verified entry is remediation work while `last_remediated_at` is null or older than `last_verified_at`. A run that verifies more entries than one invocation can replay therefore leaves the rest selectable for the next run instead of stranding them behind a newer timestamp, and a re-verified product becomes work again. Entries are processed oldest-verification-first so the backlog drains in order. `remediation_after_listing_id` persists the listing-axis cursor after each successful page and resets on re-verification; the watermark advances only when all listing pages finish. The product selector reads `productLimit + 1`, and the returned `hasMoreProducts`, `remainingProductCount`, and `incompleteProductCount` make product-axis overflow explicit. The sweep remains bounded on both axes (`KNOWLEDGE_CATALOG_REMEDIATION_MAX_PRODUCTS`, `KNOWLEDGE_CATALOG_REMEDIATION_MAX_LISTINGS`) without silently reporting a partial run as complete.

The first successful crawl per shop after deployment persists a Phase 2 baseline. Manufacturer resolution metadata is refreshed during normal product metadata synchronization; until a listing has been observed by the new code, missing manufacturer-normalization evidence is conservatively treated as unresolved rather than falsely claiming a canonical match. Identity coverage is likewise conservative: a missing resolution row is counted as unresolved until the backfill or normal resolver supplies an explicit resolution.

Every five-minute sweep that resolves at least one job also recomputes and persists a snapshot for each shop it touched, via the same `saveDataQualityRun` a crawl uses, with `crawl_run_id` left `null`. This closes the loop without inventing a synthetic crawl: crawl-only run metrics (parser failure, evidence coverage, item-count drop) correctly report `unknown` on that row since no crawl happened, while the snapshot metrics (manufacturer/category/identity/inventory/model) reflect current D1 state immediately rather than waiting for the shop's next crawl. A sweep with no resolved work writes no row, so history growth stays proportional to actual remediation activity and is bounded by the existing 180-day retention.

## Rebuild and backfill order

Migrating existing production data, or a full recovery rebuild, follows this dependency order — each stage's output is what the next stage reads, so running them out of order stales the result immediately:

1. preserve/backfill raw source fields (immutable seller evidence; migrations only, never a replay);
2. resolve canonical manufacturer;
3. resolve/normalize model;
4. reclassify category/features;
5. enrich/create Knowledge Catalog candidates (the aggregation views above; verification stays a human/reviewer action, never automatic);
6. re-run Product Identity;
7. rebuild/refresh the Phase 4 product-search entities and offer membership;
8. recompute DQ aggregates/snapshots.

Steps 2–4 run together inside one listing update (`replayDerivedListing`); steps 6–7 run together inside `refreshListingProjections`, which syncs the search projection, then Product Identity, then the search entity and its offer membership — rebuilding the entity before identity is re-resolved would make it stale on arrival. Step 8 is the sweep-triggered snapshot persistence described above. `POST /api/admin/data-quality/replay-manufacturers`, `replay-models`, and `knowledge-catalog/replay`, the scheduled remediation sweep, and `POST /api/admin/data-quality/rebuild` (which enqueues bounded, restartable pages via `enqueueFullDataQualityRebuild` — the explicit full-recovery path; normal operation never calls it) all resolve through this same order; nothing outside this document reorders it. The rebuild endpoint echoes the order back as `DATA_QUALITY_REBUILD_ORDER` so a caller driving the pages does not have to duplicate it.
