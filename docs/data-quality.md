# Data Quality

HiFiScout treats data quality as a domain concern after crawl, normalization, persistence, search projection, and Product Identity Resolution. A crawl can succeed while the resulting data quality is `warning` or `critical`; quality evaluation failures are logged and do not convert a successful crawl into a crawler failure.

## Architecture

The crawler records run-level facts and delegates evaluation/persistence to the common Data Quality layer. Shop-specific quality logic is not embedded in crawler branches. Global thresholds live in `src/data-quality/quality-thresholds.ts`; a shop plugin may declare a narrowly scoped `capabilities.dataQuality.thresholds` override when domain evidence justifies it.

`src/data-quality/quality-evaluator.ts` is a pure-function-oriented evaluator. `src/db/data-quality-repository.ts` owns D1 aggregation, persistence, latest/history queries, and API serialization. `migrations/0019_data_quality.sql` creates `data_quality_runs`, whose rows are linked to `crawl_runs` when available.

Snapshot quality and crawl-run quality are semantically separate even though they are persisted atomically in one bounded D1 history row. `snapshot_status` covers the current active-listing state; `run_status` covers parser, evidence, and item-count behavior for that crawl. `quality_status` is only the worst status across those groups. It is not a weighted composite score.

## Decision evidence and precision

`src/catalog/sale-subject.ts` separates the sale object from compatible equipment and included or missing accessories. Category inference and catalog evidence consumption share that distinction; identity exact/alias matching additionally rejects bundles and incompatible accessory evidence. A per-model lookup cache must still apply the listing-specific guard when consuming its result, since a body and its remote can share the same seller model field in one batch.

`identitySafeModelLookupVariants` is the common listing/catalog vocabulary for presentation and approved manufacturer-market variants. `modelLookupAliases` identifies category-only hints such as a bundle's base model; those hints cannot authorize a product merge. Revision vetoes remain effective for aliases. Candidate retrieval uses indexed model keys through `catalog-lookup-candidates.ts`; the retrieval key is only a coarse candidate filter, not evidence of identity. Fuzzy discovery is capped and its candidates cannot authorize exact/alias attachment. Bootstrap dictionaries and prepared identity candidates are reused without caching changing operational alias snapshots indefinitely.

Official page policy v3 requires model evidence from product content, matching structured identifiers or an eligible product heading. Navigation does not establish the model. Conflicting structured/local category evidence is terminal; only insufficient evidence permits fallback. A page-wide category label cannot classify a sibling mentioned only in an index paragraph. The persisted `verified_from_official_product_page_v3` message distinguishes this policy from older verification results for targeted, budgeted review through existing verification operations. Deployments do not refetch the full verified catalog.

Category evidence includes rule IDs and the classifier version. `confidenceKind: evidence_tier` makes clear that fixed confidence values express evidence authority, not measured correctness probabilities. The local decision corpus tests false classifications and false merges separately from unresolved coverage. Reducing the unresolved rate is not evidence of better precision. Add reviewed real-world examples alongside the synthetic counterexamples without fetching seller sites from CI.

## Snapshot metrics

Snapshot metrics are calculated in D1 with `COUNT(*)` and `SUM(CASE ...)` over active listings for one shop. Products are not loaded wholesale into a Worker.

- Manufacturer Unknown: listings whose dedicated `manufacturer_resolution_status` is not `resolved`, split into missing and non-empty raw seller values. Raw evidence, normalized raw keys, canonical IDs, method, confidence, and resolver version are stored explicitly; bounded metadata keeps the corresponding explanation for compatibility and audit.
- Category Unclassified: `classification_status != 'classified'`. Taxonomy v3 stores the internal `unclassified` sentinel and has no canonical `other`. The legacy-compatible `other_category_count` field remains in stored/API quality snapshots but is expected to stay zero; taxonomy health separately reports any legacy `other` residue.
- Product Identity Unresolved: denominator is every active listing. Explicit `unresolved` resolution rows count as unresolved, and any active listing with no `product_identity_resolutions` row is also treated as unresolved instead of disappearing from the metric. Stored/API detail `identityResolutionMissingCount` is derived as `active listings - matched - unresolved`, making coverage gaps directly observable.
- Inventory Unknown: `stock_status = 'unknown'`; all other canonical availability states are treated as known.
- Model Missing: denominator is `model_expected_count`, not all products. Taxonomy v3 cable, power, and accessory leaves (`CAB.*`, `PWR.*`, `ACC.*`) are excluded from the model-required population so products that legitimately may not have a model number are not counted as extraction failures. Legacy ids remain in the predicate only while replay compatibility is required. A listing counts as extracted only when its dedicated `model_resolution_status` is `resolved`; a `candidate` listing has a model the resolver could not fully classify and is counted as an extraction failure rather than as a success.

Every ratio retains count and denominator. A zero denominator produces `rate: null` and `status: unknown` rather than an artificial 0% or 100%.

### The unclassified sentinel

"The classifier could not decide" has its own category id, `unclassified` (display name `未分類`).
It is deliberately neither `classifiable` nor `filterable`: no classifier may target it, it never
appears as a public filter option, and `categoryFilterIds("other")` does not expand to it.

Before taxonomy v3, `other` mixed unresolved products with real product types such as tuners,
equalizers, and channel dividers. Those products now have explicit leaves (`SRC.TUNER` and
`PRC.PROCESSOR`); unresolved evidence maps only to `unclassified`. The public taxonomy therefore
cannot mix classification failures into a normal filter.

Three write paths produce it, and all three must agree:
`unresolved()` in `src/catalog/category-classifier.ts`, the fallback in `normalizeCategory()`, and
the fallback in `catalogFields()` (`src/db/product-write-repository.ts`). The classifier's in-memory
`categoryIds: []` is a separate contract — `category-enricher.ts` and `page-verification.ts` read an
empty list as "not classified" — while persistence derives canonical direct leaves and their ancestor membership. An unresolved row persists the `unclassified` sentinel; a classified multi-product listing may have several direct leaves. See `catalogFields()` and `rebuildListingCategories()` for the shared crawl/replay representation.

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

The table describes defaults in `src/data-quality/quality-thresholds.ts`; that module and registered plugin overrides are authoritative. Tune thresholds with observed production distributions, and keep shop overrides exceptional.

## Access and operational entry points

Public `/api/admin/*` requests return 404 in `src/index.ts`, before the legacy router runs.
`ADMIN_TOKEN` cannot enable those routes. The separate Cloudflare Access-protected admin Worker
supports catalog/listing editing, correction reports, and CSV exports through `CatalogAdminService`;
its contract is defined in `src/admin/contracts.ts`. It does not expose every old operational handler.

| Responsibility | Current entry point |
| --- | --- |
| Post-deploy data quality and identity checks | `.github/workflows/production-operational-health.yml`, `scripts/production-operational-health.sh`, `scripts/product-search-identity-health.sh` |
| Bounded manual resolver replay | `.github/workflows/resolver-replay-drain.yml`, `scripts/resolver-replay-drain.ts` |
| Explicit full representation audit | `.github/workflows/product-data-audit.yml` or the admin export surface |
| Listing/catalog corrections | Access-protected admin Worker; [Registered Product Admin](./listing-admin.md) |
| Latest/history evaluation and serialization | `src/db/data-quality-repository.ts` |
| Remediation impact, governance, and contributor aggregation | `src/db/data-quality-remediation-impact-repository.ts`, `src/db/data-quality-remediation-governance-repository.ts` |

The repository serializers keep snapshot metrics and latest crawl-run metrics distinct. Bounded
history/trend queries and remediation contributor counts describe D1 state; they are not live
Cloudflare billing metrics. Follow [the remediation runbook](./data-quality-remediation.md) and
[resolver replay status](./resolver-replay-status.md) for investigations and explicit maintenance.

## Observability

After evaluation, the crawler emits a structured `data_quality_evaluated` log with shop, crawl-run ID, status, item total, and quality rates. HTML and other evidence content are never included in the structured log. Evaluation failures emit `data_quality_evaluation_failure` without failing the crawl.

`Production Operational Health` recomputes active-listing Identity coverage and checks Product
Search membership/grouping after deployment. Missing identity rows, missing memberships, stale
fallbacks, and invalid entity/offer state fail the operational check. They do not retroactively fail
a successful Worker deployment. Automatic checks consume the deployed SHA from `deployment-identity`;
quota-deferred/no-op deployments supply no new identity and downstream checks skip accordingly.

Repair remains an explicit maintenance action, separate from health detection. See
[Data platform architecture](./data-platform-architecture.md) and the workflow responsibility map
in `.github/workflows/README.md`.

## Retention

Data Quality history defaults to 180 days through `DATA_QUALITY_RETENTION_DAYS`. Existing daily maintenance deletes old rows in the same bounded batch size used by other retention jobs (default 500, hard cap 1000). No unbounded history delete is performed.

## Performance

The primary snapshot query filters `products` by `shop_key` and `is_active`, aggregates in D1, and joins existing Product Identity Resolution rows by product ID. Migration 0019 adds a shop/active/classification/category index supporting this access path. History uses `(shop_key, evaluated_at DESC, id DESC)` and retention uses `(evaluated_at, id)`.

Infrastructure-level D1/R2 latency, storage, and error metrics remain in Cloudflare Observability as established in Phase 1; D1 stores only domain-significant quality results.

## Persistence and replay compatibility

Migration 0017 introduced search/identity/evidence foundations and migration 0018 added Evidence Archive usage metadata. Deployment applies migrations before the Worker release, so Phase 2 migration 0019 is applied after those foundations. Migration 0020 closes the rollout-era Identity coverage gap by inserting an explicit unresolved/backfill-pending resolution for every existing listing that lacks one.

Migration 0023 separates raw and derived manufacturer/model fields on seller listings and adds canonical manufacturer plus manufacturer-alias persistence. The public `manufacturer_id` remains a filter/display compatibility field; only `canonical_manufacturer_id` may load Product Identity candidates. Pending aliases and verified alias collisions therefore cannot silently merge products.

Migration 0024 gives Model Resolution its own rule version, extends Knowledge Catalog candidates with the evidence a reviewer needs (raw model variants, sample source URLs, identity rejection reason, unresolved-identity and `other` counts), and adds `data_quality_remediation_events` for before/after provenance. `model_resolver_version` defaults to `1` so every pre-existing listing stays behind the current resolver and is selectable for bounded replay. Resolver versions mean that the stored evidence was evaluated by that algorithm; `remediation_projection_required` separately remains set until projection, Product Identity, and search-entity refresh all succeed. A compare-and-clear operation token prevents an older concurrent replay from clearing newer pending work. A failed downstream pass is therefore selected again even after its derived fields and resolver version were persisted.

## Model Resolution

Model Resolution is a dedicated stage that runs after Manufacturer Resolution, because a resolved manufacturer is what makes brand-token removal and title extraction safe. It keeps three levels apart: `raw_model` is the seller's presentation and is never overwritten, `normalized_model` is the deterministic identity representation, and the canonical model stays in the Knowledge Catalog.

Merchandising annotations — listing state, condition, packaging, seller stock numbers, delivery footnotes, presentation colours — are removed only through an explicit vocabulary, and every removal is re-checked against the identity parts. A removal that would rewrite the identity string or drop a revision or edition token (`MK2`, `MK3`, `TX`, `SE`, `Signature`, `Meta`, `X`, `Limited`, `Reference`, `Pro`) is rejected. Residue that is neither clearly merchandising nor clearly identity is left in the model and the listing becomes a `candidate`: the data is never destroyed, but the resolver does not claim a resolved model either.

### Presentation colour

The finish is the one removed annotation that is kept rather than discarded. Removing a verified finish is what lets black and silver offers of a TAD D-1000 group as one product, so the finish must never reach `normalized_model`; but it is also what the shopper is choosing between, so deleting it made two different offers look identical on one card. A colour word alone is not proof of a finish: Ortofon Cadenza Black/Bronze and Tannoy Monitor Red/Gold/Silver are distinct model or grade identities. Explicit seller syntax is removable, Japanese colour wording and qualified finishes such as `GLOSS BLACK` carry presentation evidence on their own unless the model line is identity-bearing, and a plain English colour requires verified product-line evidence. This deliberately prefers a temporary split over a false merge.

`src/catalog/model-presentation-color.ts` is the single source for both halves: the match patterns are generated from the same spellings the normalizer looks up, so a finish cannot be recognized by one and not the other. Every seller spelling of a finish folds to one canonical label — `グロス・ブラック`, `グロスブラック` and `GLOSS BLACK` are all `グロスブラック` — and a qualified finish stays distinct from its plain form, because `ピアノブラック` and `ブラック` are different things to look at. A two-tone listing keeps its components in one label (`ブラック/ゴールド`) rather than becoming two finishes the product is offered in.

The label is stored per listing in `products.presentation_color` and aggregated per product into `product_search_entities.presentation_colors`, so a list card can name the finishes without reading its offers. A finish is recorded only when its text actually left the model: when the identity guard rolls a removal back, the colour is still in the model and is not claimed a second time.

Title evidence is only used when the manufacturer resolved, and only when the remaining tail is model-shaped — at most three tokens and containing a digit. A title is prose with a model somewhere inside it, so an unbounded tail such as `Integrated Stereo Amplifier E-5000` stays a `candidate` instead of being recorded as a resolved model.

`candidate` and `unresolved` models cannot attach to a canonical product. This is a hard gate in `resolveProductIdentity`, not a convention: identity normalization strips exactly the residue that produced the status — `D-1000 MK2 特別仕様` normalizes to `D1000MK2` — so without the gate an unclassified edition would exact-match the base product at high confidence. Gated listings are recorded as `unresolved` with `rejected_by = ["unresolved_model"]`, keeping their normalized model so they still group for remediation.

## Remediation loop

Listings that cannot resolve are aggregated by canonical manufacturer plus normalized model and prioritized by impact: unclassified listings, legacy `other` residue, unresolved identity, shop spread, and listing count. Taxonomy v3 has no canonical `other`. Cross-shop repetition contributes to priority but is never treated as proof of product identity; candidate creation is not verification.

When a catalog entry becomes verified, bounded catalog remediation replays the listings it explains: Product Identity is re-run and the search projection, entity, and offer membership are refreshed in that dependency order, with no seller fetch. Only listings whose identity actually moved produce a provenance row, so the event table stays proportional to how much data improved rather than to how often replay ran. Alias-driven manufacturer and model corrections record provenance the same way.

The backlog is selected by a durable watermark, not a time window: a verified entry is remediation work while `last_remediated_at` is null or older than `last_verified_at`. A run that verifies more entries than one invocation can replay therefore leaves the rest selectable for the next run instead of stranding them behind a newer timestamp, and a re-verified product becomes work again. Entries are processed oldest-verification-first so the backlog drains in order. `remediation_after_listing_id` persists the listing-axis cursor after each successful page and resets on re-verification; the watermark advances only when all listing pages finish. The product selector reads `productLimit + 1`, and the returned `hasMoreProducts`, `remainingProductCount`, and `incompleteProductCount` make product-axis overflow explicit. The sweep remains bounded on both axes (`KNOWLEDGE_CATALOG_REMEDIATION_MAX_PRODUCTS`, `KNOWLEDGE_CATALOG_REMEDIATION_MAX_LISTINGS`) without silently reporting a partial run as complete.

A completed crawl persists its data-quality evaluation. Manufacturer resolution metadata is refreshed during normal product metadata synchronization; until a listing has been observed by the new code, missing manufacturer-normalization evidence is conservatively treated as unresolved rather than falsely claiming a canonical match. Identity coverage is likewise conservative: a missing resolution row is counted as unresolved until the backfill or normal resolver supplies an explicit resolution.

Each scheduled remediation sweep that resolves at least one job also recomputes and persists a snapshot for each shop it touched, via the same `saveDataQualityRun` a crawl uses, with `crawl_run_id` left `null`. This closes the loop without inventing a synthetic crawl: crawl-only run metrics (parser failure, evidence coverage, item-count drop) correctly report `unknown` on that row since no crawl happened, while the snapshot metrics (manufacturer/category/identity/inventory/model) reflect current D1 state immediately rather than waiting for the shop's next crawl. A sweep with no resolved work writes no row, so history growth stays proportional to actual remediation activity and is bounded by the existing 180-day retention.

Because that row's own run status is `unknown`, `latestDataQualityByShop` never lets it stand in for crawl-run health: the newest row overall supplies the snapshot metrics, but `latestRun` (parser failure, evidence coverage, item-count drop) and the metric statuses that feed the top-level `status` are always sourced from the newest row that has a `crawl_run_id`, independent of which row is newest. A shop stuck `critical` on parser failures stays `critical` through any number of intervening remediation sweeps instead of reading as healthy the moment one runs.

## Rebuild and backfill order

Migrating existing production data, or a full recovery rebuild, follows this dependency order — each stage's output is what the next stage reads, so running them out of order stales the result immediately:

1. preserve/backfill raw source fields (immutable seller evidence; migrations only, never a replay);
2. resolve canonical manufacturer;
3. resolve/normalize model;
4. reclassify category/features;
5. enrich/create Knowledge Catalog candidates; verification follows the dedicated evidence-verification pipeline or explicit admin review, never candidate aggregation alone;
6. re-run Product Identity;
7. rebuild/refresh the product-search entities and offer membership;
8. recompute DQ aggregates/snapshots.

Steps 2–4 run together inside `replayDerivedListing`; steps 6–7 run inside
`refreshListingProjections`, which syncs listing search vocabulary, Product Identity, and then the
entity/offer memberships. Rebuilding an entity before its identity refresh would immediately stale
it. Step 8 persists the post-remediation snapshot before durable job completion. The normal
scheduled sweep and the explicit `scripts/resolver-replay-drain.ts` maintenance path use these
repositories. `enqueueFullDataQualityRebuild` is a separate bounded full-recovery capability, not a
normal crawl step; its old public HTTP handler is retired. `DATA_QUALITY_REBUILD_ORDER` in
`src/http/remediation-admin.ts` names the dependency order.
