---
name: hifiscout-phase-4-product-search
description: Project-specific guidance for HiFiScout Phase 4 Product Search, moving the user-facing search model from seller listings to canonical products with cross-shop offers while preserving unresolved listings, deterministic identity safety, D1/FTS5 performance, API compatibility, and search quality.
---

# HiFiScout Phase 4: Product Search

Use this skill when implementing or reviewing Phase 4 of the HiFiScout roadmap.

Phase 4 starts only after Phase 3 Shop Platform / Shop Adapter standardization is complete. The objective is to change the primary user-facing search model from:

```text
shop listing -> search result
```

to:

```text
product -> offers from one or more shops
```

The key UX outcome is that a user searching for one audio product sees one product result and can compare the active seller offers for that product, instead of seeing multiple near-duplicate cards simply because multiple shops list the same model.

This is not a cosmetic grouping pass over the existing page. Search semantics, pagination, result counts, sort order, filters, API contracts, read models, and frontend rendering must all agree on the product-level unit.

## Operating rules

- Follow `AGENTS.md` first.
- Start from the current `main`; do not assume the repository still matches the baseline documented here.
- Reconfirm Phase 3 is complete before making Product Search depend on its boundaries.
- Preserve D1 + FTS5 as the primary search stack. Do not introduce Elasticsearch/OpenSearch, PostgreSQL, Vectorize/vector DB, graph DB, Redis/KV, or another search engine for Phase 4.
- Preserve Product Identity Resolution and Knowledge Catalog as the source of cross-shop identity. Do not create a second fuzzy grouping engine inside search.
- Only a confirmed identity match may merge listings into one cross-shop product. A candidate, fuzzy suggestion, ambiguous match, or unresolved identity must never silently merge listings.
- Never hide unresolved listings merely because they cannot yet attach to a canonical product. They must remain searchable through a standalone fallback representation.
- Keep seller listings as factual offers. Do not mutate shop data into canonical product facts just to simplify rendering.
- Keep public/browser API DTOs explicitly declared and runtime-validated. Do not expose persistence rows directly.
- Avoid per-result N+1 queries. Search summary and offer loading must be bounded and measurable.
- Add schema changes through forward-only D1 migrations that are safe with the currently deployed Worker during rollout.
- Do not delete legacy search tables/contracts in the same migration that introduces the replacement if migration-before-deploy ordering would break the old Worker.
- Prefer one final product-search architecture over a permanent legacy/new dual stack. Temporary compatibility during rollout is acceptable; remove it after all callers and tests migrate.
- Phase 4 must not expand into Phase 5 Price Intelligence or Phase 6 Watch/Alert. Use existing price/activity facts where needed for search, but do not build long-term analytics, notification rules, or watch subscriptions here.
- For implementation work, use a feature branch and PR to `main`; merge only after required checks are green. After merge, verify the `main` CI/CD pipeline. If the merged pipeline fails because of the change, fix it and return `main` to green before considering the work complete.

## Current baseline to inspect

At Phase 4 start, inspect rather than assume at least:

```text
AGENTS.md
migrations/0017_search_identity_evidence.sql
src/catalog/product-identity.ts
src/catalog/knowledge-catalog.ts
src/catalog/categories.ts
src/catalog/manufacturers.ts
src/catalog/types.ts
src/db/product-identity-repository.ts
src/db/product-search-projection-repository.ts
src/db/product-search-repository.ts
src/db/product-row-mapper.ts
src/db/product-list-cursor.ts
src/db/product-write-repository.ts
src/db/product-feature-repository.ts
src/db/types.ts
src/api/contracts.ts
src/api/product-query.ts
src/http/**
frontend/api-client.ts
frontend/app.ts
frontend/filters.ts
frontend/pagination.ts
frontend/product-view.ts
frontend/favorites.ts
frontend/types.ts
test/**
e2e/**
.dependency-cruiser.json
wrangler.jsonc
```

The baseline already contains important Phase 1/2 capabilities that Phase 4 should reuse:

- `products` represents seller listings, not canonical cross-shop products.
- `product_search_projection` and `product_search_fts` provide the current D1/FTS5 listing search read model.
- `product_identity_resolutions` maps a listing to a verified Knowledge Catalog product when identity is confirmed.
- Identity exact and catalog-alias matches are high-confidence `matched` resolutions; ambiguous/fuzzy outcomes remain unresolved candidates.
- `knowledge_catalog_products` is the canonical-product basis.
- categories/features/manufacturer normalization already exist.
- the frontend currently consumes listing-shaped `ProductListItem` results from `/api/products`.
- current list sorting/filtering/pagination is listing-oriented and must not be assumed to remain correct after grouping.

Do not bypass these foundations by inferring cross-shop equality from display titles in the frontend.

## Core domain distinction

Phase 4 must make three concepts explicit:

```text
Canonical Product
  durable product identity from Knowledge Catalog

Seller Listing / Offer
  one shop's factual listing for that product

Search Entity
  the product-level unit returned by search
```

A canonical product can have zero, one, or many current seller offers.

A seller listing may be identity-resolved to a canonical product or unresolved.

A search entity is:

1. one canonical product with all eligible active matched seller offers; or
2. one unresolved seller listing represented as a standalone fallback entity.

The fallback rule is mandatory. Product-centric search must improve grouping without causing identity coverage gaps to become user-visible data loss.

## Identity safety

Treat identity resolution as a hard boundary.

A listing may join a canonical search entity only when all of the following are true:

- `product_identity_resolutions.status = 'matched'`;
- `catalog_product_id` is non-null;
- the referenced Knowledge Catalog product is an eligible canonical product under the current catalog policy;
- the listing remains active/eligible for search.

Do not group on:

- `candidate_catalog_product_id`;
- fuzzy distance alone;
- equal normalized title strings;
- equal model stems when variants differ;
- manufacturer + partial model without the existing identity resolver accepting it;
- frontend heuristics.

Examples such as `MK2`, `MK3`, `SE`, `Limited`, `Signature`, `TX`, `Meta`, and similar variants must remain separate whenever the identity layer treats them as distinct.

If Phase 4 reveals insufficient identity coverage, improve the existing identity/catalog pipeline and its tests. Do not hide uncertainty inside the search layer.

## Product search read model

Do not implement Phase 4 as “fetch listing rows, group the current page in JavaScript.” That produces incorrect counts, pagination, ranking, and filters.

Search must have a product-level read model or an equivalently correct query plan whose unit is the search entity before pagination.

A recommended shape is conceptually:

```text
product_search_entities
  internal search entity id/key
  entity kind: catalog | unresolved_listing
  catalog product id nullable
  fallback listing id nullable
  canonical/display manufacturer
  canonical/display model
  primary category
  category/search terms
  model/manufacturer aliases
  aggregated offer/activity fields

product_search_entity_offers
  search entity id
  listing product id
  shop key
  offer fields needed for filtering/summary

product_search_entities_fts
  FTS5 projection over product-level searchable terms
```

Exact table names are not mandatory if the current code suggests a cleaner model, but the invariants are mandatory:

- one FTS/search row per search entity, not per matched seller listing;
- one membership relation from each eligible active listing to exactly one search entity;
- matched listings for the same canonical catalog product share an entity;
- unresolved listings each receive their own fallback entity;
- entity membership changes when identity resolution changes;
- inactive/deactivated listings stop contributing to active offer summaries;
- stale fallback entities are removed when their listing becomes matched or inactive;
- canonical entities remain free of duplicate listing membership;
- read-model rebuild/backfill is deterministic and idempotent.

Do not make frontend code responsible for maintaining these invariants.

## Projection synchronization

Phase 4 must define how the product-search projection stays fresh.

Projection changes can be caused by more than title/price updates. At minimum account for:

- listing insert/update/deactivation/reactivation;
- manufacturer/model/category normalization changes;
- feature changes where feature filtering affects search;
- stock status changes;
- price changes;
- activity timestamp changes used for sorting/filtering;
- product identity resolution changes;
- Knowledge Catalog canonical model/manufacturer/category/alias changes;
- catalog verification changes if they affect identity eligibility.

Prefer explicit repository/service synchronization where cross-table logic is complex. SQLite triggers are acceptable for narrow mechanical projection freshness, but do not encode an opaque second domain model in a large trigger maze.

Provide a deterministic rebuild/backfill path for tests, local development, migration recovery, and production repair.

A rebuild must be safe to run more than once.

## Search terms and relevance

Retain the useful behavior of the existing FTS5 search while changing the result unit.

Product-level search should search canonical facts and bounded seller evidence, including where appropriate:

- canonical manufacturer name/id/aliases;
- canonical model and normalized model;
- Knowledge Catalog model aliases;
- canonical category terms and search aliases;
- representative seller title/model terms that improve recall without becoming canonical truth.

Maintain normalized model handling so queries such as punctuation/spacing variants continue to work.

Relevance should remain deterministic. A reasonable ordering is:

1. exact manufacturer + normalized model;
2. exact normalized model;
3. exact canonical/display title/model phrase where applicable;
4. FTS5 relevance;
5. deterministic activity/id tie-breakers.

Do not allow the number of seller listings for a product to artificially multiply its relevance score.

Short terms that the FTS tokenizer cannot handle must retain a bounded fallback strategy rather than producing empty results.

Add regression cases for representative audio model names, especially punctuation, spaces, hyphens, revision suffixes, and short manufacturer/model tokens.

## Offer aggregation semantics

A product search result must summarize its active seller offers.

At minimum the product result should be able to expose:

- active offer count;
- in-stock offer count;
- distinct shop count;
- lowest eligible price;
- optionally highest eligible price when useful;
- representative/best offer for compact rendering;
- latest meaningful activity across eligible offers;
- whether any offer is newly listed under the existing “new” policy;
- whether any offer satisfies the existing price-drop predicate.

Keep the seller listing factual fields available on the product detail/offer list:

```text
listing product id
shop key / shop display name
source URL
title
condition text
price
stock status
first/last seen
last meaningful activity
source published time
```

Do not invent a canonical price. “From ¥X” or equivalent must be derived from eligible offers and clearly remain an offer aggregate.

## Filter semantics

After Phase 4, filters must have explicit product-vs-offer semantics.

Product-level filters include:

- manufacturer;
- canonical category/group category;
- canonical features.

Offer-level filters include:

- shop;
- in-stock;
- min/max price;
- price-drop state;
- listing recency/newness where the existing semantics are seller-listing based.

For an offer-level filter, include a product if at least one active offer satisfies the complete offer predicate.

Do not evaluate each offer filter independently across different offers. For example, when `shop=A`, `inStock=true`, and `maxPrice=100000`, the entity must have at least one offer from shop A that is in stock and at or below ¥100,000. It is incorrect to satisfy `shop=A` with one offer and the price predicate with another shop's offer.

When offer filters are active, summary fields shown to the user should be derived consistently from the eligible offer subset when otherwise the card would contradict the filter. If the UI intentionally shows “all offers” alongside “matched offers,” label the distinction explicitly and test it.

Category descendant filtering and feature predicates must continue to use the canonical category/feature model rather than seller category text.

## Sort semantics

Product-level sort values must be defined from product/offer aggregates, not accidental representative-listing columns.

Preserve the user-visible sort vocabulary where practical, but redefine it explicitly for product entities.

Recommended semantics:

```text
newest
  newest eligible offer publication/first-seen timestamp DESC

oldest
  oldest corresponding product-level timestamp ASC using the exact inverse-compatible definition chosen for newest

updated
  maximum meaningful listing activity timestamp across eligible offers DESC

priceAsc
  minimum eligible non-null offer price ASC, nulls last

priceDesc
  minimum eligible non-null offer price DESC, nulls last
```

If a different `oldest` definition is selected, document and test it. Do not accidentally use one offer for ascending and a different aggregation for descending.

Search relevance order should take precedence when a free-text query intentionally uses relevance ordering, as the current search does, unless the API explicitly allows relevance + secondary sort.

## Pagination and counts

Pagination is a Phase 4 correctness requirement.

The following must all operate on search entities after filtering:

- `items`;
- `hasMore`;
- cursor or offset movement;
- `totalCount`;
- `totalPages`;
- page-number UI.

Never paginate listing rows and then group them.

If cursor pagination remains for non-relevance sorts, the cursor must encode stable product-level sort values and a deterministic search-entity tie-breaker.

If relevance search cannot support the same cursor safely, preserve a bounded offset strategy or introduce a correct relevance cursor deliberately. Do not fake cursor continuity with listing ids.

Add tests proving that a product with offers from multiple shops appears once across page boundaries and cannot disappear/duplicate when moving between pages.

## API contract

The browser-facing contract should become product-oriented.

A conceptual list item is:

```ts
interface ProductSearchItem {
  key: string;
  catalog_product_id: number | null;
  identity_kind: "catalog" | "unresolved_listing";
  manufacturer: string;
  model: string;
  primary_category_id: string;
  category_ids: string[];
  offer_count: number;
  in_stock_offer_count: number;
  shop_count: number;
  lowest_price_yen: number | null;
  latest_activity_at: string | null;
  representative_offer: ProductOfferSummary;
}
```

Do not copy this interface mechanically if a cleaner final contract emerges, but preserve the product/offer distinction.

The product detail contract should return:

- product/canonical display information;
- category/features useful to the UI;
- identity kind;
- all eligible active offers under the detail endpoint's documented policy;
- enough offer data to link to each seller listing safely.

Do not make clients reconstruct offer membership from separate listing searches.

Keep API DTOs in `src/api/contracts.ts` or an equally explicit cross-runtime contract module. Map DB rows deliberately at the repository/service boundary.

Add runtime guards in the browser/API client for new response shapes.

## Endpoint rollout

Choose the endpoint migration based on the current repository, but finish with one clear primary product-search contract.

Two acceptable rollout patterns are:

1. add a product-oriented endpoint, migrate frontend/tests, then retire or demote the legacy listing endpoint; or
2. intentionally evolve `/api/products` to product semantics with coordinated frontend/test migration.

Avoid maintaining two independently implemented search engines.

If a legacy listing endpoint remains because another workflow still needs raw listings, name and document it as a listing endpoint rather than leaving ambiguous `/products` semantics.

## Product detail UX

The frontend should make the product-first model obvious without becoming visually heavy.

A product search card should primarily show:

- manufacturer + model/product name;
- canonical category where useful;
- lowest current eligible price or appropriate no-price state;
- number of shops/offers when greater than one;
- stock availability summary;
- latest/new/price-drop signals already supported by current semantics.

Selecting the product should expose the individual seller offers.

Offer rows/cards should show enough information to choose between shops:

- shop name;
- condition;
- price;
- stock state;
- seller listing title where it helps distinguish condition/edition/accessories;
- link to the seller page.

Do not remove seller-specific details that materially distinguish two offers of the same model.

For an unresolved fallback entity, render the best available normalized listing information without pretending identity is confirmed. An internal “unresolved” debug label is optional; the user experience should remain useful even when catalog matching is incomplete.

## Frontend state and URLs

Keep search/filter/sort/page state shareable through the existing URL-state model.

When moving to product-level result keys:

- do not put raw SQL/internal row assumptions into browser routing;
- use a stable encoded public identifier or explicit route kind/id;
- prevent catalog ids and listing ids from colliding;
- sanitize any seller URLs using the existing URL-safety boundary;
- preserve back/forward navigation and filter restoration.

If favorites currently store listing ids, do not silently reinterpret those ids as product ids. Either preserve legacy favorite behavior for Phase 4 or implement an explicit migration with tests. Product watch semantics belong to the later Watch/Alert phase unless separately requested.

## Search performance

Phase 4 must remain suitable for Cloudflare D1.

Requirements:

- no unbounded full-table JavaScript grouping on every request;
- no N+1 offer lookup per product result;
- FTS5 remains the primary free-text index;
- add supporting indexes for entity membership, active offer predicates, common sort aggregates, and identity joins where query plans require them;
- keep list result size bounded;
- batch offer loading when the list response includes representative/summary offer information;
- measure/log search latency and result count using structured logs compatible with existing observability;
- preserve or improve current search latency instrumentation.

For non-trivial SQL, inspect realistic D1/SQLite query plans during development. Prefer a denormalized read projection where it eliminates repeated aggregation at request time, but define synchronization and rebuild invariants before denormalizing.

Do not add a cache layer merely to hide an inefficient query model.

## Migration and backfill safety

D1 migrations are applied before new Worker deployment, so schema rollout must remain compatible with the old Worker until the new code is live.

Recommended sequence:

1. add new product-search entity/membership/projection tables and indexes without dropping current listing search structures;
2. backfill deterministically from existing products, identity resolutions, Knowledge Catalog, categories, and features;
3. deploy code capable of maintaining and reading the new projection;
4. migrate frontend/API callers;
5. verify production read-model parity and search behavior;
6. only in a later safe migration remove obsolete legacy search structures if nothing uses them.

Do not create a migration that assumes code deployed later in the same pipeline already exists.

Backfill tests should verify at minimum:

- multiple matched listings collapse to one entity;
- unresolved listings remain one entity each;
- no active listing is lost;
- no active listing belongs to two entities;
- identity candidates are not grouped;
- variant models stay separated;
- aggregate price/stock/shop counts are correct.

## Consistency and repair

Add a way to detect projection drift.

High-value consistency metrics/checks include:

- active eligible listings with no search entity membership;
- listings with multiple memberships;
- canonical entities whose catalog id no longer exists/is eligible;
- stale unresolved fallback entities after identity match;
- offer-count aggregate mismatch;
- projection rows with no active offers when the policy says they should be removed;
- FTS projection/entity row count mismatch.

A deterministic repair/rebuild function or maintenance command should be available without manual SQL surgery.

Do not make a scheduled full rebuild the normal freshness mechanism unless scale measurements prove it is appropriate.

## Testing strategy

### Identity grouping tests

Cover:

- two shops, same confirmed canonical product -> one search result;
- one shop with duplicate listings that legitimately map to the same canonical product -> one entity with two offers unless business rules explicitly exclude duplicates;
- unresolved listings -> separate standalone results;
- candidate/fuzzy/ambiguous identity -> not grouped;
- `MK2` vs `MK3`, `SE`, `Limited`, `Signature`, `Meta`, `TX`, etc. -> no false merge when identity vetoes them;
- identity transition unresolved -> matched moves membership cleanly;
- identity transition matched -> unresolved/corrected rebuilds membership cleanly.

### Search tests

Cover:

- manufacturer + model exact ranking;
- model punctuation/spacing/hyphen variants;
- catalog aliases;
- short search terms;
- Japanese/ASCII terms already supported by the current tokenizer strategy;
- category/manufacturer filters;
- canonical feature filters;
- zero-result behavior.

### Offer/filter tests

Cover combined predicates on the same offer, especially:

- shop + in-stock;
- shop + price range;
- shop + in-stock + price range;
- new-only;
- price-dropped;
- multiple offers where only one matches;
- null price;
- unknown stock.

### Pagination/sort tests

Cover:

- multi-shop product appears once;
- no duplicate entity across pages;
- no missing entity at page boundaries;
- total count is entity count, not listing count;
- page count matches entity count;
- each sort has deterministic tie-breakers;
- price null handling;
- relevance pagination/offset remains stable enough for the documented contract.

### API/contract tests

Cover:

- repository row -> DTO mapping;
- browser runtime guards;
- list response;
- detail response with multiple offers;
- unresolved fallback DTO;
- safe seller links;
- backward compatibility during rollout where intentionally retained.

### E2E tests

Use Playwright for user-visible flows that justify browser coverage:

- searching a known product shows one product result even with multiple shop offers;
- opening it reveals multiple seller offers;
- filters update product-level counts/results correctly;
- pagination controls reflect product-level totals;
- URL state/back-forward behavior survives the new model;
- seller link opens the correct source listing.

Do not use E2E as the only proof of grouping/filter SQL correctness.

## Architecture boundaries

Keep the Phase 3 shop boundary intact.

Shop adapters must not know about product-search entity grouping. They continue to emit seller facts and common pipeline code handles normalization, identity, persistence, search projection, and evidence.

Add/maintain architecture rules so that:

- concrete shops do not import product-search repositories/services;
- frontend does not import DB persistence types;
- API contracts do not derive from D1 row interfaces;
- search does not import concrete shops;
- product identity does not depend on frontend/search presentation code;
- canonical catalog code remains independent from seller-specific UI logic.

Phase 4 should strengthen the read side without undoing Phase 3's plugin architecture.

## Observability

Preserve the existing structured `product_search` logging and evolve it to product-level semantics.

Useful fields include:

```text
search_latency_ms
search_result_count
search_term_count
search_fts_term_count
search_entity_count before page where cheap/available
matched_catalog_entity_count
unresolved_fallback_entity_count
offer_rows_examined or equivalent bounded diagnostic when useful
```

Do not log raw user search text unless the project has deliberately accepted that privacy behavior. Prefer counts/classifications over unnecessary query contents.

Add data-quality/maintenance visibility for search projection drift rather than waiting for users to notice missing products.

## Recommended implementation sequence

Implement incrementally. A recommended order is:

1. Re-characterize current `/api/products`, FTS search, filters, sorts, cursor/offset pagination, frontend URL state, and favorites behavior.
2. Add focused characterization tests for current search normalization and identity resolution.
3. Define the final `ProductSearchItem`, offer DTO, detail DTO, and query semantics before changing UI rendering.
4. Design and migrate the product-level search entity/membership/read projection with backward-compatible D1 schema changes.
5. Implement deterministic backfill/rebuild and consistency checks.
6. Implement projection synchronization from listing/identity/catalog changes.
7. Implement product-level free-text search, exact ranking, filters, counts, sorting, and pagination.
8. Add product detail/offer loading without N+1 queries.
9. Migrate HTTP handlers and browser runtime guards to the product-oriented contract.
10. Migrate frontend rendering from listing cards to product cards plus offer detail.
11. Preserve/migrate URL state, pagination UI, shop links, and favorites deliberately.
12. Add unit/integration/E2E coverage for cross-shop grouping and unresolved fallback behavior.
13. Measure query plans/search latency and add missing indexes or projection fields only where justified.
14. Remove temporary compatibility paths after all callers/tests use the final architecture.
15. Update developer documentation and generated architecture docs where responsibilities changed.
16. Run the full repository validation, PR checks, merge to `main`, and verify post-merge CI/CD.

Do not begin with a sweeping frontend rewrite. Prove the read model and semantics first.

## Non-goals for Phase 4

Unless separately requested, do not implement:

- historical average market price;
- median/percentile pricing;
- long-term price charts beyond already existing listing history behavior;
- sold/relisted market-event analytics;
- average time-to-sell;
- cross-shop pricing recommendations;
- user watch rules;
- push/email notifications;
- recommendation ML;
- semantic/vector search;
- automatic low-confidence fuzzy merging;
- a new external search service.

These belong to later phases or separate architectural decisions.

## Phase 4 completion criteria

Phase 4 is complete only when all of the following are true:

- The primary user-facing search result unit is a product/search entity, not a seller listing.
- Confirmed listings for the same canonical Knowledge Catalog product appear as one product result with multiple offers.
- Unresolved/candidate/ambiguous listings remain searchable as standalone fallback entities and are not falsely merged.
- Search relevance operates on product-level terms and preserves exact manufacturer/model priority plus useful FTS5 recall.
- Filters have explicit product-vs-offer semantics, and combined offer filters are evaluated against the same offer.
- Product-level sort semantics are documented and deterministic.
- Pagination, `hasMore`, total count, and page count operate on product entities.
- Product cards expose useful offer summaries and product detail exposes the eligible seller offers.
- Seller source links remain safe and correct.
- Search requests do not perform frontend grouping, full-table JavaScript grouping, or per-result N+1 database queries.
- Search projection synchronization and a deterministic rebuild/repair path exist.
- D1 migration/backfill is rollout-safe and idempotent.
- Existing Product Identity, Knowledge Catalog, category/feature, evidence, data-quality, and Phase 3 shop boundaries remain intact.
- API DTOs are explicit and browser responses are runtime-validated.
- Unit/integration/E2E tests cover grouping, unresolved fallback, filters, sorting, pagination, and multi-offer detail.
- Developer documentation/architecture rules reflect the final read-side responsibilities where needed.
- All required local validation and PR CI checks pass.
- The change is merged to `main` and the post-merge `main` pipeline is green.

## Validation

Before publishing implementation changes, run the checks required by `AGENTS.md` plus the Phase 4 architecture/build checks relevant to the change.

Expected baseline:

```sh
npm ci
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run check:no-js-source
npm run docs:architecture:check
npm test
npm run build
```

For Phase 4 changes, also run focused tests for product search, identity grouping, API contracts, and any D1 migration/backfill logic. Run `npm run test:e2e` for the completed user-facing Phase 4 flow before merge when the environment supports the repository's E2E setup.

Do not substitute a few focused tests for the full suite before merge.

After opening the PR, wait for all required checks to become green. Resolve review/CI failures instead of bypassing them. Merge to `main`, then verify the workflows triggered by the merge/deploy. A merged commit with a failing `main` pipeline is not a completed Phase 4 implementation.