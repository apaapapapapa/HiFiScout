---
name: hifiscout-post-phase-4-data-quality-remediation
description: Project-specific implementation guidance for the HiFiScout data-quality remediation program that starts only after Phase 4 Product Search is merged and production is green. Strengthens manufacturer and model resolution, Knowledge Catalog coverage, category correction, safe Product Identity, replay/reprocessing, remediation queues, provenance, rule versioning, dashboards, and production quality SLOs without weakening identity safety.
---

# HiFiScout: Post-Phase-4 Data Quality Remediation

Use this skill when implementing or reviewing the data-quality remediation program that follows HiFiScout Phase 4 Product Search.

This work starts **only after Phase 4 has been completed, merged to `main`, deployed, and its post-merge production pipeline is green**.

The objective is not to loosen Product Identity matching so that metrics look better. The objective is to improve the quality of the inputs and correction loop so that the existing conservative identity policy can resolve substantially more listings without increasing false-positive product merges.

The target flow is:

```text
Shop HTML / API
    |
    v
Raw seller listing facts
    |
    v
Normalization
    |
    +--> Manufacturer Resolution
    |
    +--> Model Resolution
    |
    +--> Category / Feature Classification
    |
    v
Knowledge Catalog enrichment / verification
    |
    v
Conservative Product Identity Resolution
    |
    v
Product Search projection / offers
    |
    v
Data Quality metrics

          ^
          |
Reprocessing / Remediation Queue
          |
Alias, catalog, or rule changes
```

## Operating rules

- Follow `AGENTS.md` first.
- Start from the **current `main` after Phase 4**, not from the historical pre-Phase-4 file list or schema documented here.
- Before changing code, inspect Phase 4's final migrations, canonical-product search model, offer/listing model, search projection synchronization, Product Identity integration, and any new repository/service boundaries.
- Preserve Cloudflare D1 + FTS5 + R2 as the data/search stack. Do not introduce PostgreSQL, Elasticsearch/OpenSearch, Vectorize/vector DB, graph DB, Redis/KV, MongoDB, or a new distributed database to solve this work.
- Preserve the repository boundaries that keep a future PostgreSQL migration possible.
- Keep seller facts separate from canonical facts. Never overwrite raw shop evidence merely to make normalized data look clean.
- Preserve raw values needed for later replay and audit.
- Prefer deterministic, explainable, versioned rules and verified Knowledge Catalog evidence over runtime LLM classification.
- Product Identity safety remains a hard boundary. Never improve unresolved-rate metrics by silently accepting fuzzy, ambiguous, or revision-conflicting matches.
- `MK2`, `MK3`, `SE`, `Signature`, `Limited`, `Meta`, `TX`, `X`, `Pro`, `Reference`, Anniversary variants, and equivalent meaningful revisions must not be discarded merely to increase match rate.
- Data-quality denominators and thresholds must not be manipulated to manufacture improvements. Production metrics must improve because data improves.
- All schema changes must use forward-only D1 migrations and be compatible with deployment ordering.
- Work must be performed on a feature branch with a PR to `main`. Merge only after required checks are green. After merge, verify the `main` CI/CD/deploy pipeline. If the post-merge pipeline or production validation fails because of this work, fix it in another PR and continue until `main` is green.

## Required initial inspection

Because Phase 4 may substantially change product search and read models, inspect the current repository instead of assuming exact file names. At minimum locate and understand the current equivalents of:

```text
AGENTS.md
migrations/**
src/catalog/manufacturers*
src/catalog/knowledge-catalog*
src/catalog/product-identity*
src/catalog/category*
src/catalog/product-normalizer*
src/crawler/**
src/db/**/*product*
src/db/**/*quality*
src/api/**
src/http/**
frontend/**
test/**
e2e/**
.github/workflows/**
wrangler.jsonc
```

Also inspect the final Phase 4 Skill and implementation so that remediation refreshes the **current product-level search projection** rather than an obsolete listing-only projection.

Before implementation, measure the current production baseline for at least:

- active listing count;
- manufacturer unknown/unresolved rate;
- model missing/unresolved rate;
- category unclassified rate;
- Product Identity coverage rate;
- Product Identity unresolved rate;
- inventory unknown rate;
- evidence coverage rate;
- top unresolved manufacturer raw values;
- top unresolved manufacturer/model pairs;
- unresolved identity groups by manufacturer/model/shop/count;
- per-shop versions of the same metrics.

Store/report the baseline so the final PR can show real before/after results.

# 1. Make raw and canonical fields explicit

The remediation architecture must clearly separate source facts from normalized/canonical facts.

Conceptually, a listing should preserve fields equivalent to:

```text
raw_manufacturer
canonical_manufacturer_id
manufacturer_resolution_status
manufacturer_resolution_method
manufacturer_resolution_confidence

raw_model
normalized_model
model_resolution_status
model_resolution_method
model_resolution_confidence

raw_category
primary_category_id
category_classification_status
category_classification_method
category_classification_confidence
```

Exact column names and storage layout should follow the post-Phase-4 architecture. Do not duplicate data unnecessarily if equivalent provenance already exists in JSON metadata or normalized tables, but the distinction must be queryable, replayable, and testable.

Requirements:

- Raw shop values are immutable evidence except when a later crawl actually changes the source value.
- Canonical/normalized values may be recomputed without re-crawling.
- Existing APIs must not accidentally expose internal provenance fields unless intentionally added to a debug/admin contract.
- Migration/backfill must preserve existing listings.

# 2. Strengthen Manufacturer Resolution

Manufacturer Resolution is the highest-priority improvement because a wrong manufacturer ID prevents the Product Identity resolver from even loading the correct canonical candidates.

Implement a dedicated manufacturer resolution pipeline conceptually equivalent to:

```text
raw manufacturer / title evidence
    |
    v
Unicode NFKC normalization
case normalization
legal-entity token removal
spacing/punctuation normalization
    |
    v
verified alias lookup
    |
    +--> exact verified alias -> resolved/high confidence
    |
    +--> deterministic known-title extraction -> resolved when unambiguous
    |
    +--> weak/ambiguous evidence -> candidate only
    |
    `--> no evidence -> unresolved
```

## Manufacturer requirements

- Keep the existing code-level manufacturer dictionary as a bootstrap/fallback if useful, but move operational alias management toward D1 / Knowledge Catalog-backed data rather than requiring a code deploy for every newly observed seller spelling.
- Introduce or extend canonical manufacturer and manufacturer-alias persistence.
- Store normalized aliases for deterministic lookup.
- Alias rows should include enough metadata for audit, for example source, verification status, created/updated timestamps, and rule/provenance information.
- Verified aliases may auto-resolve.
- Unverified/ambiguous aliases must remain candidates and must not silently become canonical.
- When the explicit seller manufacturer field is missing, deterministic title evidence may be used.
- Preserve the original raw manufacturer string.
- Unknown values must be aggregatable by normalized raw value and listing count.
- A newly verified alias must be able to trigger targeted reprocessing of affected historical listings without fetching shop pages again.

Examples that should converge when verified:

```text
TAD
Technical Audio Devices
テクニカルオーディオデバイセズ
    -> canonical TAD manufacturer

Accuphase
ACCUPHASE
アキュフェーズ
    -> canonical Accuphase manufacturer
```

Do not infer a canonical manufacturer from merely similar edit distance if multiple legitimate brands are possible.

# 3. Create a dedicated Model Resolver

Do not rely on a single generic "split title at whitespace" fallback as the primary model strategy.

The preferred processing order is:

```text
raw title / seller model
    |
    v
resolve manufacturer first
    |
    v
remove verified manufacturer presentation tokens where appropriate
    |
    v
remove seller/listing merchandising annotations
    |
    v
extract raw model candidate
    |
    v
normalize identity representation
```

## Model requirements

Preserve three conceptual levels:

```text
raw model         = source presentation, e.g. "D-1000 MKII / Silver"
normalized model  = deterministic search/identity representation
canonical model   = Knowledge Catalog verified product model when matched
```

Do not overwrite raw model text with the canonical model.

Create deterministic handling for removable seller annotations such as, where demonstrably safe:

- used/demo/outlet labels;
- condition words;
- sold/negotiating/listing-state words;
- seller inventory numbers/SKUs;
- packaging/accessory notes;
- presentation color tokens that are not part of canonical product identity.

However, product revisions and editions must be preserved. Add explicit regression coverage for at least:

```text
D1000 vs D1000 MK2
D1000 MK2 vs D1000 MK3
D1000 MK2 vs D1000 TX
805 D4 vs 805 D4 Signature
LS50 vs LS50 Meta
C1 vs C1X
SE / Limited / Reference / Pro variants
```

If a token cannot safely be classified as merchandising metadata versus identity, prefer unresolved/candidate behavior over destructive removal.

# 4. Expand Knowledge Catalog coverage through a remediation loop

Knowledge Catalog is the correction authority and the basis for safe canonical product identity.

Listings that cannot resolve must feed a structured candidate process instead of remaining an unorganized backlog.

Aggregate unresolved listings by useful deterministic keys, especially:

```text
canonical manufacturer + normalized model
```

and record evidence such as:

- listing count;
- distinct shop count;
- first/last seen;
- categories observed;
- raw model variants;
- source URLs/evidence references;
- current identity rejection reason.

Prioritize catalog candidates by impact. A candidate seen across multiple shops and many listings should generally rank above a one-off unknown item.

A reasonable priority signal may include:

```text
unresolved listing count
+ distinct shop count
+ currently unclassified count
+ high-value search impact
```

Do not treat cross-shop repetition alone as proof of product identity. Candidate creation is not verification.

When a Knowledge Catalog product or alias becomes verified:

1. identify affected listings;
2. re-run normalization/resolution as needed;
3. re-run Product Identity;
4. refresh the Phase 4 product search entity/projection and offer membership;
5. update DQ metrics;
6. record provenance of the change.

# 5. Let verified canonical identity correct category safely

The existing evidence-based category classifier should remain conservative.

Do not replace it with a broad heuristic classifier just to reduce `unclassified`.

Use verified Knowledge Catalog identity as authoritative category evidence when available:

```text
verified canonical product
    > deterministic exact known-product evidence
    > strong explicit product-title evidence
    > seller category mapping
    > weak parser/classifier hints
```

Exact ranking should respect the current post-Phase-4 classifier architecture, but the invariant is:

- verified canonical product facts may correct weaker seller/category evidence;
- conflicting weak evidence must not override verified catalog facts;
- unresolved identity must not pretend to have verified catalog category evidence;
- broad seller categories remain weak/corroborative unless the shop adapter has reliable specific mappings.

Category remains "what the product is". Features remain "what the product can do". Do not collapse feature attributes into multiple primary categories.

# 6. Preserve conservative Product Identity behavior

Product Identity Resolution itself should change only when evidence demonstrates a safe deterministic improvement.

Preserve the decision philosophy:

```text
verified manufacturer
    |
    v
exact normalized model / canonical model
    |
    v
verified catalog alias
    |
    v
variant/revision vetoes
    |
    v
bounded fuzzy candidate
```

Only high-confidence deterministic matches should auto-attach a listing to a canonical product.

Mandatory safety rules:

- Same manufacturer + exact normalized canonical model may auto-match when unique and not vetoed.
- Verified catalog model aliases may auto-match when unique and not vetoed.
- Ambiguous exact collisions must remain unresolved.
- Variant/revision conflicts must veto auto-match.
- Fuzzy matching remains a **candidate mechanism**, not an automatic merge mechanism, unless a future deterministic evidence rule proves equivalence independently of edit distance.
- Category may gate weak/fuzzy candidates but must not override a model revision conflict.
- Candidate catalog IDs must never be treated as matched canonical product IDs in Product Search.

Do not add a second identity engine to the Phase 4 search layer.

# 7. Add replay/reprocessing without re-crawling

Alias, catalog, and resolver improvements must be applicable to stored listings without accessing shop websites again.

Build or formalize a deterministic reprocessing path conceptually like:

```text
stored raw listing
    |
    v
Manufacturer Resolution
    |
    v
Model Resolution
    |
    v
Category / Feature Resolution
    |
    v
Product Identity Resolution
    |
    v
Phase 4 Search Projection refresh
    |
    v
DQ recomputation
```

Requirements:

- Idempotent: running the same version twice must not keep changing rows.
- Bounded: suitable for Cloudflare Workers/D1 execution limits.
- Restartable: progress can continue after partial failure.
- Targetable: alias/catalog/rule changes should reprocess affected listings rather than blindly rewriting the whole database.
- Full rebuild remains available for recovery/testing.
- Reprocessing must preserve current seller factual state such as price, stock, source URL, and shop timestamps unless the remediation rule explicitly operates on those fields.
- Search projection refresh must follow the final Phase 4 architecture.

# 8. Version normalization and resolution rules

Track rule versions so stale listings can be identified deterministically.

Equivalent metadata should exist for at least:

```text
manufacturer resolver version
model resolver version
category classifier version
identity resolver version
```

Versioning requirements:

- A code/rule deployment increments only the resolver version whose behavior changed.
- Stored results record the version that produced them.
- Queries/jobs can identify `stored_version < current_version` work.
- Version bumps must have tests proving replay behavior.
- Reprocessing a listing at the current version is a no-op if source facts and dependent canonical evidence are unchanged.

Knowledge Catalog/alias changes also need a dependency mechanism so affected listings can be selected even if the code rule version itself did not change.

# 9. Implement a bounded Remediation Queue

Unresolved data-quality work must become actionable work items instead of passive metrics.

Use D1-backed bounded work tracking unless the post-Phase-4 architecture already provides a suitable queue abstraction. Do not introduce a large distributed queue platform without a concrete need.

Useful work types include:

```text
resolve_manufacturer
resolve_model
classify_category
resolve_identity
reprocess_listing
rebuild_search_entity
```

Conceptual states:

```text
pending
processing
resolved
failed
```

Requirements:

- unique/idempotent work keys so duplicate signals do not create unbounded duplicates;
- bounded batch claiming;
- retry count and last error;
- timestamps;
- reason/source that created the work;
- affected entity/listing identifiers;
- safe recovery of abandoned `processing` work;
- metrics for backlog size and failure rate.

Do not create queue rows for every healthy listing forever. Work items exist to remediate actionable stale/unresolved state.

# 10. Prioritize remediation by impact

Expose the highest-leverage fixes rather than a raw list of thousands of rows.

At minimum provide aggregate views/API/query helpers for items such as:

```text
unknown manufacturer raw value
-> affected active listing count
-> distinct shops
-> candidate canonical manufacturer if any

unresolved manufacturer + normalized model
-> listing count
-> distinct shops
-> candidate catalog product if any

category mapping/rule issue
-> affected listing count

model extraction pattern
-> affected listing count
```

Sort primarily by estimated affected listing/search-entity count, with deterministic tie-breakers.

A human should be able to add one verified alias or catalog correction and immediately see how many listings/search entities can improve.

# 11. Record before/after provenance

Every remediation-induced canonical change must be explainable.

Preserve enough audit data to answer:

- what listing/entity changed;
- previous normalized/canonical value;
- new normalized/canonical value;
- rule/alias/catalog change responsible;
- resolver method/confidence;
- resolver version;
- processed timestamp;
- previous/new Product Identity resolution;
- previous/new search entity membership when identity changed.

Do not necessarily create a giant event table for every no-op replay. Design bounded retention or change-only history if appropriate.

The system should be able to explain a transition such as:

```text
BEFORE
manufacturer = fallback:bw
identity = unresolved

AFTER
manufacturer = bowers-wilkins
identity = matched
catalog_product_id = 812

reason = verified manufacturer alias added
resolver_version = manufacturer-v4
```

# 12. Data Quality targets and SLOs

Use the current Phase 2 Data Quality framework rather than building a separate monitoring system.

The first remediation milestone should aim for approximately:

```text
Manufacturer unknown/unresolved   < 10%
Category unclassified             < 10%
Identity coverage                 = 100%
Identity unresolved               < 50%
Inventory unknown                 < 5%
Model missing/unresolved           < 5%
Evidence coverage                 > 95%
```

After the correction loop is stable, tighten toward:

```text
Manufacturer unknown/unresolved   < 2%
Category unclassified             < 3%
Identity unresolved               < 20%
```

These are quality goals, not permission to distort denominators or auto-merge uncertain products.

Important distinction:

- structural impossibilities such as missing required identity-resolution rows for active eligible listings may be deploy/production gates;
- source-dependent quality percentages should generally be monitored as SLO/warning/critical data-quality states rather than making every deploy impossible during real shop-data degradation.

Keep per-shop metrics so one bad source cannot hide behind a healthy global average.

# 13. Improve the Data Quality dashboard / status API

Extend the existing DQ status surface rather than building a disconnected dashboard.

For each major metric, expose where practical:

```text
current value
threshold/status
previous value
absolute delta
percentage delta
trend over recent snapshots
per-shop breakdown
top remediation contributors
```

High-value views include:

- top unknown manufacturer raw values;
- top model extraction failures;
- top unresolved manufacturer/model groups;
- top catalog candidates by affected listings and distinct shops;
- remediation queue backlog/failures;
- identity resolution method distribution;
- before/after change since the current remediation rollout began.

Avoid unbounded queries over the full history on user-facing status endpoints. Use bounded aggregates/snapshots where necessary.

# 14. Rebuild/backfill order

When migrating existing production data, process dependencies in this order unless the post-Phase-4 architecture proves a safer variant:

```text
1. preserve/backfill raw source fields
2. resolve canonical manufacturer
3. resolve/normalize model
4. reclassify category/features
5. enrich/create Knowledge Catalog candidates
6. re-run Product Identity
7. rebuild/refresh Phase 4 product search entities and offer membership
8. recompute DQ aggregates/snapshots
```

Do not rebuild Product Search before new identity/category results are persisted, or the search projection may immediately become stale.

Migration/backfill must be restartable and idempotent. For large updates, use bounded application-level batches rather than a single transaction that risks D1 execution limits.

# 15. Testing requirements

Add strong regression coverage. At minimum include:

## Manufacturer tests

- Unicode/case/punctuation/legal-entity normalization;
- verified alias resolution;
- unknown alias remains unresolved/candidate;
- ambiguous alias never auto-resolves;
- title manufacturer extraction when explicit source field is absent;
- alias addition triggers targeted replay selection.

## Model tests

- seller annotations removed only when safe;
- raw model preserved;
- normalized model deterministic;
- punctuation/spacing variants converge;
- revision/edition variants remain distinct;
- shop-specific input edge cases.

## Knowledge Catalog tests

- unresolved groups aggregate deterministically;
- verified catalog change causes eligible listings to re-resolve;
- unverified candidate does not auto-match;
- priority calculation is deterministic;
- candidate creation is idempotent.

## Identity tests

Keep and expand the existing safety suite:

```text
D1000 != D1000MK2
D1000MK2 != D1000MK3
D1000MK2 != D1000TX
805D4 != 805D4Signature
LS50 != LS50Meta
C1 != C1X
```

Also prove:

- verified alias may match;
- ambiguous aliases remain unresolved;
- fuzzy similarity alone remains unresolved candidate;
- corrected manufacturer can convert a previously unresolved listing into a safe exact match.

## Replay / queue tests

- idempotent replay;
- current-version no-op;
- stale-version selection;
- dependency-triggered replay after alias/catalog change;
- bounded batch claiming;
- duplicate queue signal deduplication;
- retry/failure behavior;
- recovery of abandoned processing rows.

## Search integration tests

After a listing changes identity through remediation:

- old unresolved Phase 4 fallback entity is removed when appropriate;
- listing joins the correct canonical product entity;
- offer counts and shop counts are correct;
- no duplicate membership is created;
- filters/sort/pagination remain correct;
- canonical product variants remain separate.

## Migration tests

- production-shaped old rows migrate safely;
- raw evidence is not lost;
- backfill is idempotent/restartable;
- old deployed Worker compatibility is considered when migration executes before new Worker deployment.

# 16. Performance and Cloudflare constraints

Measure, do not assume.

- Keep D1 reads/writes bounded.
- Add indexes for replay selectors, normalized aliases, unresolved grouping, and queue claiming based on actual query plans.
- Avoid N+1 Knowledge Catalog lookups during bulk replay.
- Prefer batched candidate maps and bounded `IN` queries/services.
- Do not perform network calls to seller sites during replay.
- Avoid runtime full-table scans on normal crawl/search requests.
- If remediation jobs are scheduled, make each invocation safe to retry and bounded in work count/time.
- Preserve Phase 4 search latency and result correctness.

# 17. Rollout strategy

Prefer incremental deploy-safe steps rather than one destructive migration.

A recommended sequence is:

```text
A. schema/provenance additions + backward-compatible writes
B. Manufacturer Resolver + alias storage + observability
C. Model Resolver + raw/normalized separation
D. Knowledge Catalog candidate/remediation aggregation
E. replay engine + rule versions
F. bounded Remediation Queue
G. category correction from verified identity
H. identity re-resolution integration
I. Phase 4 search projection refresh integration
J. production backfill/replay
K. dashboard/SLO improvements
L. remove obsolete compatibility paths after verification
```

If Phase 4's final architecture already provides some of these mechanisms, reuse and extend them instead of duplicating them.

# 18. Production validation

Do not consider the project complete because unit tests pass.

After deployment:

1. confirm migrations applied successfully;
2. run/observe bounded production replay/backfill;
3. confirm active eligible listing identity coverage remains 100%;
4. compare manufacturer/category/model/identity DQ metrics against the recorded baseline;
5. inspect top changed manufacturer aliases and model normalization patterns;
6. sample matched identity transitions, especially revisions/editions, for false-positive risk;
7. confirm Product Search counts, pagination, product grouping, and offer membership remain sane;
8. confirm unresolved listings are still searchable where Phase 4 requires fallback entities;
9. confirm crawl and deploy health for every active shop;
10. confirm `main` CI/CD and production E2E are green.

If metrics worsen or false-positive product merges are found, fix the resolver/catalog rule rather than hiding the regression.

# Definition of done

This work is complete only when all of the following are true:

- Phase 4 was already complete and green before this work started.
- Raw seller manufacturer/model/category evidence is preserved separately from canonical values.
- Manufacturer Resolution is a dedicated deterministic stage with verified alias persistence and candidate observability.
- Manufacturer aliases can be added without requiring a source-code rule for every seller spelling.
- Model Resolution is a dedicated stage with raw/normalized/canonical separation.
- Seller annotations are removed conservatively while meaningful product revisions remain distinct.
- Knowledge Catalog unresolved-product candidates are aggregated and prioritized by impact.
- Verified catalog/alias corrections can reprocess affected listings without a shop recrawl.
- Verified canonical identity can provide authoritative category correction without weakening unresolved behavior.
- Product Identity still rejects ambiguous/fuzzy/revision-conflicting automatic merges.
- Replay/reprocessing is deterministic, idempotent, bounded, restartable, and targetable.
- Resolver rule versions and dependency-triggered stale work are tracked.
- A bounded remediation work queue exists with retries, failure observability, and deduplication.
- Remediation priorities show affected listing/search-entity impact.
- Before/after provenance exists for actual canonical changes.
- Existing Phase 2 Data Quality status surfaces show current/delta/trend/per-shop information and top contributors where appropriate.
- Production backfill/replay has been executed successfully.
- Real production DQ metrics are demonstrably improved from the recorded baseline; improvements are not created by denominator or threshold manipulation.
- Product Search still groups only confirmed identities and preserves unresolved fallback listings.
- Required local validation passes, including at least the repository's current equivalents of formatting, lint, typecheck, tests, and no-first-party-JavaScript checks.
- PR checks are green.
- The implementation PR is merged to `main`.
- Post-merge `main` CI/CD/deploy/E2E are green.
- Any post-merge regression introduced by the work has been fixed and verified.

# Final implementation report

When finishing the implementation, report at least:

- PR(s) and merge commit(s);
- migrations added;
- resolver/catalog/replay architecture implemented;
- production replay/backfill executed;
- before/after global DQ metrics;
- before/after per-shop DQ metrics;
- number of listings whose manufacturer/model/category/identity changed;
- number of newly matched canonical identities;
- unresolved identity change;
- samples of revision/variant safety verification;
- remediation queue status;
- final Phase 4 Product Search sanity results;
- `main` CI/CD/deploy/E2E run links and final status.

Do not stop after writing code, opening a PR, merging a PR, or starting a backfill. The completion boundary is a verified green production state with measurable data-quality improvement and no weakened Product Identity safety.