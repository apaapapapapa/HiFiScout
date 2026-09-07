# Data platform architecture: D1 search, product identity, and R2 evidence

Status: Accepted

## Decision

HiFiScout keeps Cloudflare D1 as the system of record for structured product data. R2 holds bounded diagnostic/verification evidence and generated CSV exports. Product search stays on D1 FTS5. Product identity is deterministic and explainable and uses the verified Knowledge Catalog as its canonical-product basis.

The architecture intentionally does **not** introduce Vectorize/vector databases, graph databases, KV/Redis, document databases, external search engines, or PostgreSQL at this stage.

## Responsibilities

### D1: structured facts and operational state

D1 remains authoritative for:

- shop listings (`products`)
- manufacturer/category normalization
- primary and additional product categories
- product feature facts
- price history
- Knowledge Catalog products, aliases, categories, candidates, and review state
- crawl/shop state
- search projection metadata
- the product-level search read model: search entities and their offer memberships
- Listing -> Knowledge Catalog product identity resolutions
- R2 evidence metadata

The existing Repository boundary remains the storage boundary. Domain logic must not depend directly on a D1-specific API where a repository already owns persistence. This keeps a future D1 -> PostgreSQL repository replacement possible without introducing a large ORM/DAO framework now.

### R2: evidence and export objects

R2 stores retained HTML evidence for parser/crawl/classification/Knowledge Catalog investigation.
D1 stores archive metadata and the R2 object key. Separately, resumable crawling temporarily stages
fetched HTML in `crawl_fetch_pages.html_text` between fetch and parse steps; parsed listing pages
clear that HTML and retain normalized products for finalization. Terminal cleanup clears staged
payloads. This temporary recovery state is not the long-term Evidence Archive.

Normal successful crawl HTML is not archived. Asynchronous Product Audit and Knowledge Catalog exports also store their bounded parts and final CSV objects in R2; D1 owns job state and object references. See [Asynchronous admin CSV generation](#asynchronous-admin-csv-generation).

## Product search

The user-facing unit of search is a **product**. Safely identified offers for the same amplifier produce one result with multiple offers; search counts, filters, sorting, and page boundaries operate on entities. Public metadata retains some listing-unit counts, as described below.

### Search entities

`product_search_entities` is the product-level read model. Each row is one **search entity**, which is either:

- a confirmed Knowledge Catalog product (`entity_kind = 'catalog'`, public key `c-<catalog id>`); or
- an unresolved fallback (`entity_kind = 'unresolved_listing'`, public key `l-<representative listing id>`), containing either one listing or a guarded exact-identity group.

The fallback kind is mandatory rather than a nicety: identity coverage is incomplete, and without it a listing the catalog has not confirmed would silently stop being findable. Public keys are namespaced because catalog ids and listing ids overlap numerically and must never be mistaken for each other.

`product_search_entity_offers` maps each active listing to exactly one entity. `listing_product_id` is the table's primary key, so duplicate membership is impossible by schema rather than by convention.

Shop-filtered search starts with that shop's active listings through the existing
`idx_products_shop_active_quality` index and then looks up offer membership by listing ID. The
result is an entity-ID set: multiple matching listings still count as one product. Exact totals
and pages share this predicate, and request-scoped sort aggregates use the same shop-first access
path. Stock, price, newness and price-drop conditions must all hold on the same listing; another
shop's offer cannot satisfy one of them. Totals remain exact and independent of page cursors.
Offer selection scales with the selected shop's active inventory, not other shops or retained
inactive rows; it is not constant-time as the selected shop itself grows. Additional FTS/product
filters have their own access costs. No extra index, counter write or cache
freshness tradeoff is introduced.

Manufacturer presentation aliases are an uncorrelated SQL set, rather than JSON expanded once per
entity. Only badge-prefixed stale presentations use the legacy suffix comparison. This retains
canonical IDs, historical aliases and Japanese labels while reducing repeated work. Without a shop
scope the presentation fallback can still scan entities; it is not an indexed constant-cost path.
`test/filtered-search-read-budget.test.ts` measures real local D1 reads at increasing unrelated-data
sizes, and `test/filtered-search-semantics.test.ts` covers distinct totals, same-offer filters,
manufacturer compatibility and cursor pagination. These are regression gates, not production
billing or Worker CPU measurements.

Canonical membership requires a `matched` Product Identity resolution against a verified `knowledge_catalog_products` row. Before catalog verification, `src/db/product-search-exact-identity.ts` may consolidate unresolved offers whose canonical manufacturer and resolved normalized model are both nonempty and exactly equal. Conflicting specific categories and persisted identity vetoes exclude unsafe grouping; its representative is the lowest eligible active listing ID. Accessory compatibility mentions and multi-model bundles cannot bypass the decision by falling back to an exact group.

Candidate/unresolved model results, fuzzy suggestions, equal titles, and equal model stems never authorize grouping. Revision, edition, and accessory evidence remains protected by the model/identity guards. Confirmed catalog membership always takes precedence over fallback grouping.

An entity exists only while it holds at least one active offer, which is what retires a fallback entity when its listing becomes confirmed and what retires a canonical entity when every shop has sold out.

`src/db/product-search-entity-sql.ts` and the exact-identity helpers own the derivation used by `syncProductSearchEntities` and `rebuildProductSearchEntities` in `src/db/product-search-entity-repository.ts`. Incremental sync and explicit rebuild share the current rules. Applied migrations retain the SQL needed for their original rollout; they are not edited to follow later runtime changes.

`productSearchEntityConsistency` reports drift per invariant: active listings with no membership, memberships pointing at inactive listings, entities with no offers, fallback entities whose listing is now matched, catalog entities whose product is no longer eligible, stale offer-count aggregates, and FTS index integrity. Production checks live in `.github/workflows/production-operational-health.yml` and its scripts, separately from deployment smoke checks. Public `/api/admin/*` routes are retired at `src/index.ts`; the legacy router's consistency/rebuild handlers are not supported public endpoints. An explicit bounded repair is available through `scripts/repair-product-search-gaps.ts` using the D1 REST API; it also pays for a full remaining-gap count.

### Repairing exact-identity splits

Listings that share an exact pre-catalog identity belong in one fallback entity. Detecting when they are not — a split — is a question no index can answer as a listing predicate, because `exactIdentitySplitMembershipPredicateSql` joins `products` to itself on identity. Asking it across the active catalog therefore costs the size of the catalog whether or not anything drifted, which is what made it the dominant scheduled D1 reader.

Repair is driven by change instead. The triggers in migration 0074 record the **identity**, not the listing, in `product_search_exact_identity_dirty`. The identity is the right unit for three reasons: peers need no discovery because every member of a group shares it; a listing that leaves an identity marks the one it left as well as the one it joined, so the peers it stranded are still covered; and repeated writes to one identity collapse onto one row, so a busy crawl cannot inflate the backlog beyond the identities it actually touched. None of that requires the self-join the scan exists to perform.

`repairDirtyExactIdentities` claims a bounded batch in `marked_at` order and, with the identity fixed, resolves the group through `idx_products_exact_identity` — an indexed search rather than a scan. It then compares the group's current membership against the one `syncProductSearchEntities` would derive, and replays the sync only when they disagree. That comparison is deliberately stronger than the scan's: the scan can only find groups that need merging, whereas a recorded change just as often means a group must be taken apart — listings that acquire conflicting categories, or a representative that is deactivated, stay consolidated under one entity and are invisible to a split test. `claimed_at` doubles as the claim token: re-marking clears it, so an identity changed mid-repair survives the clearing delete, and a claim abandoned by a killed isolate is released once it outlives its lease.

Dirty identities are claimed atomically with `UPDATE ... RETURNING`. Member lookups and clean-claim deletion are grouped below D1's bind limit: 25 clean identities cost four D1 round trips, including stale-lease recovery. Expensive resyncs have a separate per-pass limit; deferred claims retain their original queue age. Entity aggregate refreshes are batched, and the scheduler admits a complete entity transition before its first write so an intentional budget yield cannot strand its aggregates.

General cron shares a 45-call D1 budget across watchdogs, maintenance and bookkeeping. Five calls are reserved for finalization: ordinary work stops at 40, while bounded dispatch cleanup and successful task completion may use the reserve without exceeding 45. A failed catalog dispatch closes its incomplete run and jobs; a successful Queue wake always records maintenance completion, including when it used the final work call. SQL statements inside each batch are logged separately from binding calls. A 20-second wall-time deadline controls admission between work units; finalization may cross that deadline, which is not a CPU-time measurement or proof of Workers Free CPU compliance. `scheduled_maintenance_pending` retains due work across ticks, including separate daily retention, projection and verification tasks. Lease tokens fence late completion, and attempt ordering gives untouched work a turn after a budget yield. `general_cron_d1_usage` reports calls, statement count, elapsed time, rows read/written and deferrals; per-task failure logs include partial write usage too. Watchdog and task errors still use their existing durable recovery paths.

Catalog candidate preparation also persists its progress in `knowledge_catalog_candidate_refresh`.
It walks primary-key listing windows up to a captured ID horizon and stores per-identity accumulators
in `knowledge_catalog_candidate_refresh_groups`, preserving normalization, cross-page counts and
bounded evidence samples. Publication walks candidate keys in bounded pages and batches indexed
manufacturer/model lookups and guarded JSON row-set writes;
retirement starts only after all collection and publication pages finish. Each page's effects and
cursor advance share one transaction, fenced by generation and revision, so a lost acknowledgement
or concurrent continuation cannot double-count a page. Temporary groups are deleted in bounded
pages after retirement. These checkpoints add bounded reads and writes; unchanged published candidate rows
and their AUTOINCREMENT sequence remain untouched.

Scheduled daily, monthly and bootstrap callers share one preparation per UTC date. A yield retains
the pending maintenance task and resumes preparation before claiming a verifier rollout or recovery
run; the ordinary hourly bootstrap no-op does not start a refresh or consume the daily date key.
When an older generation crosses midnight, it is completed and cleaned before the requested day's
new horizon is processed. Review runs and Queue wake-ups are created only after that requested
preparation completes. The pages are
eventually consistent observations, not a transaction-wide snapshot: edits behind the cursor and
new listings beyond the horizon enter the next refresh. Explicit repository refreshes can request a
new generation independently of that scheduled daily cache.

The daily safety net remains isolated as `product_search_exact_identity_repair` in `src/scheduled.ts`. Its audit now traverses bounded candidate windows with a persistent cursor; the five-minute coverage/stale-fallback audit does the same. The candidate window is materialized before the gap predicate, so a repair-result LIMIT is never mistaken for a scan limit. Each phase advances through healthy windows and wraps at the end. If its repair allowance fills, it stops before any unprocessed gap. The explicit operator-only remaining-gap count is still an unbounded audit.

Normal five-minute repair first consumes `product_search_catalog_pending` for verified Catalog membership transitions, then `listing_projection_pending` for full projections, then audits for omissions. Migration 0096 captures existing mismatched verified memberships and records new eligible Identity/Catalog transitions atomically, including one verified Catalog product changing to another. Membership repair verifies the current authoritative catalog ID without rerunning Identity decisions or acknowledging full projection obligations. Each successful repair clears only its captured token, so a later budget yield or concurrent edit cannot lose work. Exact-identity change repair continues to consume its existing dirty set. Failure attempts rotate within the pending index, so a poison listing does not monopolize every pass. Use `scannedCount` and actual D1 accounting alongside repaired counts; finding zero defects is a performance case in its own right.

Both pending selectors materialize their indexed, limited work sets before looking up listings, including when the queue is empty.

### Atomic listing facts and durable projection work

`upsertProducts` packs complete per-listing groups into D1 batches. A group includes the listing mutation, required category/feature/facet changes and its price observation. It is never split between commits. A history INSERT uses the shop/source identity inside that transaction, so newly allocated listing IDs do not require a second commit. An unchanged replay creates no additional price observation.

Migration 0090 records a token in `listing_projection_pending` in the same transaction as an inserted or materially updated listing, including deactivation. Heartbeats and same-value updates do not enqueue work. This obligation survives a failure before `recordCrawlRunWorkSet`; an unchanged crawl returns pending observed sources in its derived work set. Normal crawl continuations and remediation refreshes clear only the token captured before their projection work, after dependency-ordered completion. A concurrent newer edit therefore remains pending. The tables contain current work and constant-size audit cursors, not another append-only event log.

### Public search response cache

The default Worker remains uncached so every public API request passes its rate limiter and URL
validation. Search and suggestion URLs are canonicalized before calling the internal
`PublicSearchCache.fetch` entrypoint through `ctx.exports`. Its request carries no client cookies,
authorization or cache-control headers. Only validated GET search/suggestion responses opt into a
30-second freshness window; private/admin routes, other endpoints and error responses cannot use
this entrypoint. The loader does not wrap the Cache API, so two cache layers cannot extend freshness.

The per-entrypoint [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
is in `wrangler.jsonc`; the runtime boundary is `src/http/public-search-cache.ts`. Workers Cache
shares cached work across locations and collapses concurrent misses according to the
[platform contract](https://developers.cloudflare.com/workers/cache/). This reduces D1 reads on hits
without adding R2 objects or operations. The gateway still executes and requests remain subject to
Workers usage limits. Deployments use the platform's default version-specific cache keys.
Non-Workers callers use the existing Cache API fallback. Unit tests prove routing, freshness headers
and guard order; regional hit rates and platform request coalescing require production observation.

### Public metadata counts

`/api/meta` reads current `shop_sync_state` and the singleton `public_meta_snapshot`. Public requests
never aggregate the catalog. Scheduled work normally publishes counts hourly; `countsUpdatedAt`
identifies that complete snapshot while shop sync/health keep their short edge-cache cadence.

Migration 0102 introduces `public_meta_counts` and the `public_meta_incremental_aggregate` reader.
Shop/manufacturer counts use active listings, including the existing minimum manufacturer label per
manufacturer ID. Category counts use entity memberships. Guarded source triggers apply only actual
changes; a price, heartbeat, unchanged classification or cache timestamp does not change counters.
Empty vocabulary entries are removed, so retired values do not accumulate in every later scan.

Facets count distinct entities even when several shops or evidence sources assert the same value.
Offer/fact/activity changes coalesce into `public_meta_dirty_entities`; the reader re-evaluates only
those entities into `public_meta_entity_facets`. Each page's effects and acknowledgement commit
together. A write before the page batch is included; a later write creates another obligation.
Replacement fact rows, entity moves, cascaded deletions and replay cannot double-count membership.
The legacy migration-audit statistic is recalculated only after that audit changes, not every hour.

A refresh admits at most five 100-entity pages plus publication within the invocation's D1 budget.
If work remains, `MAINTENANCE_PENDING` retains its existing scheduled obligation for the next
five-minute tick and allows other maintenance to proceed. Publication and its timestamp change
atomically only when the backlog is empty. Failures or prolonged backlogs retain the previous
complete snapshot and its age; do not interpret an old timestamp as current counts. Public HTTP
traffic never drains this work. Observe snapshot age and backlog alongside the scheduled D1 usage.

The migration backfills counters and facet membership atomically before installing source triggers.
The old `public_meta_aggregate` view stays available for the previous Worker's hourly refresh during
rollout/rollback and as a differential verification oracle. Both versions read the same public
singleton. Taxonomy changes must update the counter conditions and both aggregate definitions.
Rollback deploys the previous Worker; it does not drop the source-maintained tables.

### Category storage and D1 measurement

Migration 0101 makes `product_categories`, `product_search_entity_categories` and
`knowledge_catalog_product_categories` `WITHOUT ROWID`: the existing composite membership key is
the physical key, removing the separate rowid-table/primary-index write. Secondary indexes, primary
category uniqueness, foreign-key cascades and admin override guards remain intact. The replacement
and restoration of the old metadata view share one migration transaction.

`test/d1-table-design-budget.test.ts` uses local Miniflare/workerd D1, including indexes and triggers.
Its three isolated category inserts fall from 4/3/5 to 3/2/4 writes before adding the metadata
triggers. Do not present those as the combined category-counter path: that path also maintains a
counter, and disappearing vocabulary may require cleanup.

The metadata workload changes 100 listing cache timestamps and ten entity facet values, then
publishes one snapshot. At 1,000 listings it reads 7,134 rows before and 704 after; at 10,000 it reads
70,134 before and the same 704 after. Both workloads write 331 before and 391 after (3 versus 10 SQL
statements). An unchanged refresh reads 23 and writes one row in five statements. This demonstrates
bounded reads with explicit write amplification, not an account-wide reduction in both dimensions.
The existing unchanged-crawl/search write-budget tests must continue to pass.

One-time table copies, index builds and backfill are separate from steady-state savings. A populated
local upgrade with 250 listing categories, 250 entity categories, one catalog category and 250
entity facets measured 7,599 reads/1,658 writes for 0101 and 4,569 reads/289 writes for 0102. These
sum individual statements in atomic D1 batches; the metadata for only the final statement of a
multi-statement `prepare().run()` is not a migration total. Production migration cost depends on its
actual data; the existing quota-aware deployment and migration-history checks remain the gate.

Other table proposals remain unapplied because a reduction in both reads and writes is not proven:

| Proposal | Local comparison including maintenance | Decision |
| --- | --- | --- |
| Separate detail-check/cache state | Reading 250 listings and changing one check: 501 reads/3 writes becomes 751 reads/1 write with the extra indexed join | Saves writes but increases reads on every cache lookup |
| Persist candidate memberships and dirty keys | Reassigning 250 distinct keys: temporary-group insert/delete costs 250 reads/500 writes; indexed membership moves plus old/new dirty insert/ack alone cost 750 reads/1,500 writes | This lower bound excludes publication common to both paths; a quiet-day win does not prove a correction-day win. Candidate `last_seen_at` is also part of the output |
| Persist latest asking sample per listing | For 1,000 observations/100 listings the equivalent rollup reads 12,923 versus 8,922; an evidence event still needs its ledger write and adds one latest-state read/write (six ledger writes become at least seven) | Reduces some history reads but adds writes; observation totals and listing-end signals still need retained evidence |

These counterexamples are adoption limits, not production savings estimates. A later proposal must
measure source changes, unchanged replay, retirement/correction, refresh, retention and migration
together while preserving the existing evidence and public-result semantics.

### Search projection

`product_search_projection` decouples listing search vocabulary from the physical shape of `products` and feeds the seller evidence folded into each entity's search terms. The obsolete listing-level `product_search_fts` index is retired. Only `product_search_entities_fts` is maintained; the listing projection remains necessary input. SQL triggers compare actual values, so a crawler UPDATE that names unchanged text columns does not rewrite the projection or FTS.

The projection contains:

- canonical manufacturer ID
- canonical/raw manufacturer names and deterministic manufacturer aliases
- source model
- identity-normalized model
- deterministic model presentation aliases
- title
- canonical/raw category terms and existing category search aliases

The crawler refreshes only the listings whose inputs actually moved in the current crawl: the ones it inserted, changed, reactivated, or deactivated. Title-derived feature facts follow the same delta: they are written by the listing write itself, for those listings only, because a title that did not move cannot have produced different facts, and the drift a rule change leaves on untouched listings belongs to the resumable remediation worker rather than to a whole-inventory pass on every crawl. `metadata_json` deliberately does not follow that delta — the change-detection behind it never compares metadata, and some metadata exists only in the freshly parsed listing (`categoryClassification.detailCheckedAt`, the negative cache for detail-page fetches, is written precisely when the check left every column alone). `syncProductMetadata` is handed the whole observed set and computes its own delta against the stored JSON. A listing the seller re-reported unchanged projects to exactly what is already stored, so re-deriving the whole inventory every time bought nothing and made the cost of a routine crawl track the size of the shop. Stale resolver versions and Knowledge Catalog edits are replayed by the remediation queue, which is a resumable worker of its own rather than something hidden inside a normal crawl. The repository compares the calculated projection with the persisted one and skips unchanged writes. SQL triggers provide a safe baseline for product writes performed outside that path and keep FTS rows synchronized.

Migration 0084 removes the obsolete listing FTS index and guards projection/entity text updates against equal values. Price-only or observation-only changes must not rewrite search text or FTS. Applied migrations preserve earlier rollout steps, but the current searchable index is `product_search_entities_fts`.

The write path also avoids unchanged indexed-column assignments and filters equal search/candidate
rows before INSERT, preventing AUTOINCREMENT sequence writes from an otherwise no-op upsert.
`syncProductMetadata` retains `categoryClassification.catalogMatchedAt` when the materialized
decision is unchanged; `detailCheckedAt` still represents a meaningful negative-cache update.
Candidate review timestamps record a changed decision, while review-run rows record executions.
Candidate refresh reads bounded listing pages, batches manufacturer/model-key probes through the
existing expression indexes, and inserts bounded JSON row sets through the same difference guards.
This reduces D1 binding calls without loosening matching or rewriting unchanged candidates; batch
statement counts and billed reads/writes remain separate costs in the invocation accounting.
Migration 0087 guards equal deal-score updates, and terminal crawl cleanup touches only remaining
payloads. The Miniflare D1 tests in [Testing strategy](./testing-strategy.md#d1-write-budget-regressions)
measure these write paths, including index/trigger/sequence cost, without production quota.

### Price-index projections

Public search enters through `src/db/product-search-price-index-repository.ts` and loads summaries
with `src/db/knowledge-catalog-price-index-read.ts`. It reads `knowledge_catalog_price_indexes`,
including the persisted `recent_asking_median_yen`; it never calculates the trailing-90-day median
from samples during a search request. Product detail may separately load at most five listing-end
observations. Those observations are seller listing signals, not verified transaction prices.

Asking medians/min/max use **one latest retained quote per listing**. `asking_sample_count` remains the observation count for compatibility; `asking_listing_count`, `asking_shop_count` and `latest_asking_observed_at` describe independent evidence and freshness. Public price indexes require at least three independent listings. One listing discounted three times therefore remains one listing and cannot enable the badge. Listing-end observations retain their explicit sold-out/deactivated semantics. Unknown condition, accessory and sale-unit differences are not silently normalized into comparable prices; the UI states these limits.

`src/db/price-index-rollup.ts` owns the runtime expression, with its immutable snapshot in migration 0092's view and immediate triggers. Deferred batches use the same expression. `listing_basis_computed_at` must match `last_computed_at` before the new API publishes a summary, preventing an old Worker's partial rollup from masquerading as a current independent-listing aggregate. The admitted background cursor rebuilds existing rows; deployment does not aggregate all history. Admission counts the full sample scope the new rollup reads. The hourly backfill admits at most 500 observations per page to preserve its measured 20,000-row D1 read budget; a product above that allowance remains explicitly deferred.

The new `listing_deal_score` and index start empty and are maintained with same-value guards. Public `dealScore` sorting uses that persisted field and a versioned cursor namespace. It ranks the cheapest in-stock offer across all shops (falling back to an active offer); the card badge compares the currently visible filtered price. The sort label and badge explanation distinguish these scopes without introducing request-time historical aggregation.

`src/db/knowledge-catalog-price-index-recent-refresh.ts` owns a restartable keyset backfill and
expiry-driven refresh. `maintainRecentPriceIndexes` runs two sequential batches with independent
limits: up to 25 backfill products, then up to 25 due products. While initial backfill and expiry work
coexist, one hourly task can therefore select up to 50 products; this is not a combined 25-product
cap. Both batches remain subject to the shared general-Cron invocation budget. Sample changes and
age boundaries make products due; a cursor advances atomically with its projection
writes. Migrations 0078–0080 add the recent projection, avoid no-op refresh-marker writes, and allow
bulk backfill to defer/coalesce rollups. The ordinary per-product refresh still reads that product's
samples, so bounded product count is not a fixed bound on rows read for a large sample history.

Use `price_index_public_read_d1_usage`, `price_index_recent_refresh`, and per-task D1 accounting to
distinguish public projection reads from background aggregation. A delayed refresh keeps the stored
summary and its `last_computed_at`; it does not cause public traffic to rebuild the history.

### Multi-term FTS queries

User input is parsed by `src/search/fts-query.ts`; it is never concatenated directly as raw FTS syntax.

- terms of 3 or more characters use quoted FTS5 terms
- multiple FTS terms are combined with `AND`
- shorter terms, which cannot be useful trigram terms, are ANDed using parameterized `LIKE` predicates against the search projection
- embedded quotes are escaped by doubling before the term is quoted
- the parser caps the number of terms

For example, `TAD 1000` becomes an FTS5 query equivalent to:

```text
"TAD" AND "1000"
```

and matches model text such as `D1000MK2` through the trigram index.

Product search matches `product_search_entities_fts`, whose rows are entities. Each entity indexes canonical manufacturer terms, the canonical normalized model, canonical model terms including Knowledge Catalog aliases, and bounded seller evidence — the titles and normalized terms of up to three member listings — so a query phrased the way a retailer writes it still finds the product without that phrasing becoming canonical truth.

### Ranking

When the API caller does not request an explicit sort, text search applies a small deterministic preference before FTS5 `bm25`:

1. known manufacturer + normalized model exact match
2. normalized model exact match
3. exact canonical model
4. FTS5 rank
5. latest activity as a tie breaker

Ranking reads canonical entity columns only, so a product cannot climb the results merely by being listed in more shops.

When the caller explicitly selects `newest`, `oldest`, `updated`, `priceAsc`, or `priceDesc`, that sort remains authoritative. No separate ranking engine is introduced.

### Filters, sorting and pagination

Filters split by what they describe, and the split is load-bearing:

- **Product-level** — `manufacturer`, `category`, `facet`, `feature` — restrict the entity. A group category expands to its descendants at query time.
  - `category` matches the entity's *membership*, not its one representative category. A listing is one sale and may hold several products — a transport and a DAC sold together — so it belongs to every category its component products are in, and to the ancestors they share, once each. Membership is projected from the listings currently offering the entity into `product_search_entity_categories`, which is also what the category facet counts, so the number beside a category and the cards that category returns are the same set read twice rather than two calculations that can drift.
  - repeated `facet=<dimension>:<value>` selections are ORed within one dimension and ANDed between dimensions. `connector_a=xlr OR rca` plus `signal_type=analog`, for example, means `(xlr OR rca) AND analog`; each dimension is one product-level `EXISTS` over the entity's offers.
- **Offer-level** — `shop`, `inStock`, `minPrice`, `maxPrice`, `newOnly`, `priceDropped` — are evaluated inside one `EXISTS`, so they must all hold for the *same* offer. Satisfying `shop=A` with one listing and `maxPrice` with another shop's listing would be a wrong answer, not a lenient one.

When offer filters are active, the card summary — offer count, shop count, lowest price, activity — is recomputed over the matching offers, so a card can never contradict the filter that produced it.

Explicit sorting follows the same offer subset as the card whenever an offer filter changes the meaning of the sort key. Unfiltered sorts use indexed stored entity aggregates. With only `inStock=true`, price sorts use `lowest_in_stock_price_yen`, and date sorts use `newest_in_stock_listed_at` or `latest_in_stock_activity_at`. Migration 0098 backfills the two date fields once and adds partial ordering indexes for entities with in-stock offers. Guarded triggers on changed listing facts and offer memberships maintain these dates within the affected entities, including writes from an older Worker during rollout or rollback. Unchanged dates add no writes. These paths filter on the stored in-stock count before pagination; sold-out, unknown-stock and inactive offers cannot determine their date order. Additional offer filters such as shop or price range still require a request-scoped matching-offer aggregate to preserve the visible subset's ordering.

| `?sort=` | ordering |
| --- | --- |
| `newest` | newest offer publication/first-seen time, descending |
| `oldest` | the same aggregate ascending — the exact inverse, not a different column |
| `updated` | most recent meaningful listing activity across offers, descending |
| `priceAsc` / `priceDesc` | lowest offer price; the lowest **in-stock** price when `inStock=true`, so "cheapest first" never orders by a price nobody can buy |

The cursor records both the aggregate variant and, for request-scoped sorts, the offer-filter scope that defined it. A cursor therefore cannot resume under an ordering whose visible card values were calculated from a different offer subset. `items`, `hasMore`, `totalCount`, `totalPages` and cursor movement all operate on entities before any offer is loaded.

Offer summaries and representative offers are loaded in chunks of entity IDs to stay under D1's bind-parameter ceiling. Unfiltered responses skip the offer-aggregate loader; price summaries have their own bounded projection loader. There is no per-result offer lookup. This bounds statement fan-out by page size, but filtered sorting may still aggregate matching active listings and an exact total may inspect the matching set. See `test/remediation-query-plans.test.ts`; a bounded response is not proof of constant-cost SQL.

## Taxonomy v3: product types, facets, and capabilities

The three vocabularies answer different questions and must not be collapsed into one category tree:

| Axis | Question | Examples | Persistence / query |
| --- | --- | --- | --- |
| Category | What kind of product is it? | `SRC.DISC`, `PRC.DAC`, `CAB.ANALOG` | canonical leaf/ancestor membership; `?category=` |
| Facet | What orthogonal form or context describes it? | wireless, Bluetooth, XLR, studio | evidence-bearing `product_facet_facts`; `?facet=id:value` |
| Capability | What function can it perform? | DAC, network playback, phono input | existing `product_feature_facts`; `?feature=` |

Categories are deliberately limited to stable product types. Wireless versus wired, connector shape,
signal type, active versus passive, portability, application, and use case are facets. A built-in DAC
or network playback is a capability. This prevents the category tree from multiplying every product
type by every possible attribute combination.

Only canonical leaves are classifiable. Roots such as `SRC`, `PRC`, and `CAB` are public filter
groups, not classifier outputs. `unclassified` is an internal, non-filterable sentinel; taxonomy v3
has no canonical `other` product type. A multi-product listing keeps every component leaf in
`direct_category_ids`, derives its ancestor closure for membership, and chooses one deterministic
`primary_category_id` only as its representative label. Product Identity and price history continue
to identify the product/listing independently of that representative category.

Migration `0068_category_taxonomy_v3.sql` preserves legacy URLs, saved searches, overrides, and
stored rows through an explicit alias/migration registry. Deterministic legacy ids map directly;
ambiguous ids such as transport, XLR cable, and old `other` inspect title/category evidence and fall
back to `unclassified` rather than guessing. The migration records every decision in
`taxonomy_v3_migration_audit`, rebuilds category search membership, and backfills facet facts without
changing listing ids, Knowledge Catalog identity links, price history, or price-index samples. The
SQL facet backfill is only a compatibility baseline: migrated rows deliberately retain a stale
classifier version so the existing bounded remediation queue replays the complete facet vocabulary.

## Product Identity Resolution

### Canonical product model

The verified `knowledge_catalog_products` table is the canonical-product basis. HiFiScout does **not** create a second `canonical_products`, `master_products`, or similar overlapping product master.

`product_identity_resolutions` stores only the explainable relationship from a shop listing to a Knowledge Catalog product:

- matched catalog product, if any
- unresolved candidate, if any
- `match_method`
- `confidence`
- normalized model and model stem
- parsed variants
- matched fields
- veto reasons
- evaluation time

Migration 0017 initially seeded listings that already had canonical manufacturer and model fields as `backfill_pending` + `unresolved`. Migration 0020 closes the remaining coverage gap by inserting an explicit unresolved/backfill-pending row for every listing that still lacks a resolution. Normal crawls reevaluate those rows incrementally and only promote deterministic high-confidence matches. The migrations never bulk-merge production listings.

### Resolution order

The implemented resolution order is:

1. existing manufacturer normalization / canonical manufacturer ID
2. model extraction performed by the existing shop normalization path
3. identity model normalization
4. variant extraction
5. verified Knowledge Catalog exact model match
6. conservative Knowledge Catalog model aliases (including the existing official-source lookup variants)
7. deterministic fuzzy candidate generation
8. unresolved

Fuzzy matching never auto-links a listing. It can only produce a low-confidence candidate for investigation.

### Model normalization

Identity normalization is semantic before punctuation removal. Examples:

- `D1000MKII`
- `D1000 MK2`
- `D-1000 MKII`
- `D 1000 MK II`

normalize to the same identity key `D1000MK2`.

Standalone revision suffixes such as `II`/`III` are retained as revision information rather than silently discarded.

### Variant detection and Veto Rules

Meaningful suffixes/revisions are retained as identity information. The initial rule set covers at least:

- `MK1`, `MK2`, `MK3`, ... and Roman-numeral spellings
- standalone revisions (`II`, `III`, `IV`)
- `SE`
- `Signature`
- `Limited` / `Limited Edition`
- `TX`
- terminal `X` on model families where a numeric stem exists
- `Reference`
- `Anniversary`
- `Meta`
- `Pro`

A Veto Rule outranks aliases and fuzzy similarity. If two models have the same stem but different variant sets, they are not merged.

Examples that must remain separate include:

- `D1000` vs `D1000MK2`
- `D1000MK2` vs `D1000TX`
- `805 D4` vs `805 D4 Signature`
- `LS50` vs `LS50 Meta`
- `C1` vs `C1X`

Ambiguous exact-normalization collisions or ambiguous aliases are also left unresolved instead of selecting the first candidate.

The governing rule is that a false positive merge is more damaging than a false negative. An unresolved listing is valid system state.

### Duplicate catalog review

`knowledge_catalog_products` is unique on `(manufacturer_id, normalized_model)`, and catalog normalization keeps separators. One product can therefore hold two verified rows: `PMA-2500NE` beside `PMA2500NE`, `L-509 MK II` beside `L-509MKII`, or a canonical manufacturer id beside the fallback id the resolver produced before it learned that manufacturer. Listings then split across both rows and the same product appears twice in search.

`src/catalog/knowledge-catalog-identity.ts` holds the one rule that decides whether two catalog rows name the same product: the canonical manufacturer id from the resolver, plus `normalizeIdentityModel`. Promotion, manual admin writes, duplicate detection, and automatic convergence all ask that module, so none of them can decide "same product" differently from the others.

`GET /api/admin/knowledge-catalog/duplicates` on the **Access-protected admin Worker** reports those sets through internal RPC. Detection runs in two stages, because neither half can be done alone:

1. SQL buckets verified rows by a key that drops the separators and folds the `MARK`/`MK` revision spellings. The key is a deliberate over-approximation of the identity rule, and paging walks bucket keys rather than row ids so a set is never split across pages.
2. TypeScript re-keys each bucket with the identity rule and keeps only the sub-groups with more than one member.

A bucket that is too coarse therefore costs a discarded row, never a reported group: two manufacturers that share a model string fall apart in stage 2, and a model that normalizes to no identity at all is never reported.

### Preventing and converging duplicate catalogs

Writing is guarded at both ends.

Before inserting a catalog row, every writer looks the product up by logical identity rather than by the storage key. The unique index is read first because it answers the common case without a scan; only when it holds no verified row is the identity bucket scanned, and every row that scan returns is re-checked with the real identity rule. A promotion whose model differs from an existing catalog entry only in separators, revision spelling, or a legacy manufacturer id therefore converges onto that entry instead of creating a second one.

Rows written before that rule reached every writer are collapsed by the review run's finalizer, which converges a bounded number of duplicate sets per run using the same detection query the admin screen uses and the same reference move as the operator-confirmed merge. The survivor is a deterministic function of the set — most matched listings, then earliest verification, then lowest id — never row order, so repeating a pass never picks a different survivor. Each merge is one `db.batch`: aliases and sources are copied, candidates, verification attempts and identity resolutions are re-pointed, retention-safe price-index samples are re-pointed explicitly so `ON DELETE CASCADE` cannot take market evidence with the duplicate, and only then is the duplicate deleted. The survivor is left owed a remediation replay, which the same finalizer drains, so its newly inherited listings are re-resolved and their projections refreshed in the same pass. A converged catalog yields no duplicate sets, so re-running the pass — including after a partial failure — changes nothing.

`POST /api/admin/knowledge-catalog/products/{id}/merge` on the admin Worker supports operator-directed merges, including a survivor that carries no primary category, which automatic convergence deliberately leaves alone.

## Evidence Archive

### Archive decisions

`src/evidence/evidence-archive.ts` has an explicit allow-list of archiveable reasons. The crawler currently emits evidence for:

- parser failure / zero parsed products
- suspicious item-count validation failure
- general crawl validation failure
- unresolved category classification when a source page is available

The archive module also supports the same controlled mechanism for future integrations such as unknown manufacturer/category, HTML structure changes, material product-content changes, temporary debug snapshots, and Knowledge Catalog verification evidence.

No path archives every successful response.

### Security and size controls

Before upload:

- obvious credential-bearing `input`/`meta` values are redacted
- token/password/session/cookie/auth/CSRF-like key/value content is redacted
- only HTML body evidence is stored; response headers and browser sessions are not dumped
- evidence size is capped (`EVIDENCE_MAX_BYTES`, default 1,500,000 bytes)

The archive object key contains only controlled segments:

```text
evidence/{retention-class}/{shopKey}/{yyyy}/{mm}/{dd}/{eventId}.html
```

URLs and product titles are not inserted into object keys.

### Deduplication

The sanitized/capped content is hashed with SHA-256. Before upload, D1 is checked for a non-expired evidence row with the same shop, reason, and content hash. If it exists, the R2 write is skipped.

### Retention

R2 lifecycle rules are provisioned by the production deploy workflow using prefix-based policies:

- `evidence/short/`: 30 days
- `evidence/medium/`: 90 days
- `evidence/long/`: 365 days
- `product-audit-exports/`: 10 days (covers the 24-hour generation deadline plus 7-day download window)
- `knowledge-catalog-exports/`: 10 days (covers the same generation and download windows)

The application records `expires_at` in D1, and the existing daily retention cleanup removes expired evidence metadata in bounded batches. Object deletion itself is delegated to R2 lifecycle rules rather than a custom lifecycle engine.

### Failure semantics

Evidence archival is best-effort. Missing bindings, hashing/database errors, and R2 write failures are logged and returned as archive failures; they are not thrown into the product crawl update path. A crawler failure remains a crawler failure for its original reason, not because evidence could not be stored.

### Asynchronous admin CSV generation

The Access-protected Catalog Admin starts Product Audit and Knowledge Catalog CSV exports as
persistent D1 jobs instead of reading an entire dataset in one HTTP request. Both job kinds share
the existing `hifiscout-product-audit-export` Queue and DLQ. The physical name is retained for a
backward-compatible rollout; the message `kind` selects the consumer. Its single-concurrency
configuration is the aggregate CPU bound across both exports, so one job kind can wait behind the
other but the two expensive readers cannot run concurrently.

Each delivery processes one bounded page and enqueues its continuation with a delay. Each page
becomes a deterministic R2 chunk below a job-kind-specific prefix; a completed download streams
those already-generated chunks in order and performs no catalog joins or CSV re-encoding.
Lifecycle state remains in the separate `product_audit_export_jobs` and
`knowledge_catalog_export_jobs` tables so each domain keeps its own horizon and active-job
constraint without weakening the established Product Audit schema.

Product Audit jobs retain separate `active` and `all` scopes, capture a maximum listing-ID horizon,
and write 250-row chunks under `product-audit-exports/{jobId}/`. Knowledge Catalog jobs have no
scope and permit only one active export, capture a maximum catalog-product-ID horizon, and write
100-row chunks under `knowledge-catalog-exports/{jobId}/`. The smaller catalog page bounds the
additional category, alias, source, candidate, identity, and verification-attempt lookups.
Category, alias, source, and identity collections also have per-product scan limits. Category,
alias, and source count columns are named `*_count_capped`; the adjacent `*_truncated` flag
distinguishes an exact count from the cap-plus-one lower bound. Identity counts are explicitly
named `*_sampled`, because the exporter samples at most 101 identities before joining listing
activity, and `identity_sample_truncated` identifies larger sets.
Direct D1 text/JSON projections are length-bounded before they leave SQLite. CSV serialization also
enforces per-cell and per-row character budgets; `csv_fields_truncated` names any affected columns
instead of silently allowing a single pathological value to inflate an entire chunk. Oversized
`*_json` cells remain valid JSON sentinel objects with truncation metadata.

Each job uses cursor, chunk, and lease compare-and-swap fields for at-least-once Queue delivery.
Neither export is a transactional point-in-time snapshot: the ID horizon is fixed at creation, but
mutable fields and joins are read when each page runs, so the CSV intentionally reflects bounded,
eventually consistent interval semantics.

Both job kinds have a 24-hour generation deadline, five-second continuation delay, and 900-chunk
cap. That bounds Product Audit at 225,000 rows and Knowledge Catalog at 90,000 rows while keeping
the later streaming download below an explicit R2-operation bound. The general five-minute cron
re-enqueues stale cursors for both job tables, while compare-and-swap throttles prevent repeated
POST or polling requests from flooding the Queue. Completed exports are available through the
Access Worker for 7 days. Daily maintenance removes expired rows from both D1 job tables in bounded
batches, while independent 10-day R2 lifecycle rules remove their private chunks.

## Observability and capacity monitoring

Application-level structured logs expose:

- `identity_exact_match_count`
- `identity_alias_match_count`
- `identity_fuzzy_match_count`
- `identity_unresolved_count`
- `identity_veto_count`
- `identity_resolution_write_count`
- `evidence_archived_count`
- `evidence_archive_failure_count`
- `search_latency_ms`
- `search_result_count`
- `search_term_count` and `search_fts_term_count`
- `search_entity_total_count` when the caller asked for a total
- `matched_catalog_entity_count` and `unresolved_fallback_entity_count`, which show how much of a result page is confirmed cross-shop identity and how much is still standing in for itself
- `offer_summary_query_count`, the actual bounded number of chunked offer queries the response needed

Raw user search text is deliberately not logged; the fields above are counts and classifications.

Each crawl summary additionally carries `searchEntities` with the listings resynced, entities touched, and entities retired by that crawl. Entity sync runs after identity resolution, because which product a listing belongs to is decided by the resolution written in the step before it. A failure there logs `product_search_entity_sync_failure` and leaves the crawl successful: stale grouping is a read-model repair, not a reason to discard a completed collection.

`syncProductSearchEntities` is scoped strictly to the listings it is given and the identity peers they regroup. Single-seed peer discovery uses a direct indexed probe; multi-seed discovery materializes distinct manufacturer/model identities and evaluates category compatibility once per identity before the indexed peer lookup, so repeated members of one identity do not multiply the same correlated scan. Fallback lookup and pruning use the existing unique `entity_key` index with `l-<listing ID>` keys. Catalog entity upserts resolve requested listing IDs before looking up their verified catalog rows. Inactive-offer deletion uses one integer-primary-key equality per listing, inside the existing atomic projection batch. A fixed `IN` list alone is insufficient: stale statistics can make SQLite scan the entire offer table even for an empty deletion. SQL statement count grows with the listing chunk; binding round trips do not increase, and unchanged deletions write no rows.

The crawl's `membership_cleanup` stage walks bounded windows of `listing_projection_pending`, then checks shop, activity and membership by primary key. Its checkpoint is a `pending:<listing ID>` cursor; an older source-ID checkpoint restarts safely. A window containing only healthy or other-shop work still advances and consumes a chunk budget. Membership-only cleanup leaves the full projection token intact for the normal five-minute repair. The stage no longer searches retained inactive product history on every crawl. `auditInactiveSearchMemberships` is the daily safety net for legacy memberships without an obligation: it materializes a bounded membership window before looking up listings, persists its cursor, and never advances past failed or over-budget repairs. A full audit takes successive daily windows; normal deactivations use durable pending work.

Operational scripts and `src/db/data-platform-status-repository.ts` expose counts useful for migration/capacity decisions. The legacy `/api/admin/data-platform/status` public route is blocked by the outer Worker and must not be used as an operational access path. Counts include:

- total and active products
- price-history rows
- Knowledge Catalog rows and verified rows
- identity matched/unresolved/veto counts
- evidence metadata count
- crawl runs in the last 24 hours

Cloudflare already provides D1 platform analytics for database storage size, read/write query volume, rows read/written, and query latency. HiFiScout does not copy these time-series metrics into D1. Operators should use the Cloudflare D1 Metrics view / GraphQL Analytics API and Worker observability for platform error/timeout signals.

`src/db/read-accounting.ts` records rows read/written, attempted/measured statement counts, returned
rows, and D1 wall time. `batch()` is counted per result without double-counting wrapped statements.
Plain `first()`/`raw()` do not expose billing metadata to this wrapper; use `firstMeasured` for an
already bounded single-row query that must be metered. Missing metadata or a failed statement may
leave a lower-bound total. Neither returned rows nor D1 binding-call count substitutes for billed rows.

Parser performance has two complementary signals. CI runs sanitized, production-shaped HTML
fixtures without live seller requests and compares raw parse, catalog normalization, and page
discovery CPU against source-controlled same-process relative baselines. Absolute microseconds are
diagnostic only because hosted runner speed is not stable. In production,
`crawl_fetch_page_parsed` logs `htmlBytes`, `itemCount`, `rawParseMs`, `normalizeMs`, `discoverMs`,
and `parserPipelineMs` so expensive input shapes and stages can be identified. Cloudflare Workers
Observability remains authoritative: after rollout, verify `exceededCpu` stays at zero and compare
invocation CPU p95/p99 with the previous release before treating the parser change as healthy.

No current D1 product/storage limit is hard-coded into application logic. Capacity decisions should compare measured usage with the currently documented platform limit at operational-review time.

## Why no Vector DB

Product identity is dominated by structured distinctions where semantic similarity is dangerous. `D1000`, `D1000MK2`, and `D1000TX` are semantically very close but distinct products. Manufacturer normalization, model structure, variants, verified aliases, deterministic Veto Rules, and the Knowledge Catalog provide safer and explainable behavior.

A vector store can be reconsidered when HiFiScout has a real semantic-retrieval use case such as natural-language sound-character search or RAG over reviews/manuals. It is not part of identity resolution.

## Why no Graph DB

Current Product / Manufacturer / Category / Feature / Shop relationships fit the relational model. A graph database should only be reconsidered if multi-hop graph traversal over relationships such as `successor_of`, `compatible_with`, `same_series`, `recommended_with`, or `connects_to` becomes a primary product feature.

## PostgreSQL exit strategy

This change does not migrate to PostgreSQL. Reconsider PostgreSQL only when measured, sustained constraints justify it, for example:

- D1 capacity is materially approaching the then-current documented limit
- write contention is a recurring production problem
- crawl writes and user queries materially interfere with each other
- p95/p99 search latency is no longer acceptable after reasonable D1/index optimization
- the single-D1 architecture is a demonstrated bottleneck
- PostgreSQL-specific SQL/extensions provide concrete product value

The Repository boundary is deliberately preserved so that a future PostgreSQL implementation can replace storage adapters without rewriting identity/search domain rules.

## Deployment requirements

`wrangler.jsonc` binds `EVIDENCE_BUCKET` to the `hifiscout-evidence` R2 bucket. The production deployment workflow creates the bucket if necessary and reconciles the five HiFiScout-owned lifecycle rules before deploying the Worker. Both CSV job kinds intentionally reuse the existing serialized Product Audit Queue and DLQ; deployment does not create or rename a queue for Knowledge Catalog exports.

The Catalog Admin deployment is triggered only after a successful main Worker deployment and
checks out that exact deployment SHA. This keeps the Service Binding RPC contract aligned during
forward deploys and rollbacks; the main entrypoint also implements the shared `CatalogAdminRpc`
interface at compile time.

The Cloudflare API token used by deployment therefore needs the permission required to create/configure R2 buckets and lifecycle rules (`Workers R2 Storage Write`) in addition to the permissions already required by the Worker/D1 deployment.

## Regression coverage

Unit/regression tests cover:

- FTS query parsing and escaping
- `TAD 1000` using conjunctive FTS5 search instead of per-term product-table LIKE fallback
- manufacturer/search projection aliases
- model normalization and alias generation
- variant parsing/Veto behavior
- exact and ambiguous Product Identity matches
- fuzzy candidates remaining unresolved
- active-listing Identity denominator and missing-resolution coverage
- evidence archive allow-list, redaction, hash deduplication, and best-effort R2 failure behavior
- verified catalog grouping and guarded exact-identity fallback grouping, while unsafe unresolved/candidate models stay separate and searchable
- offer-level filters holding for one and the same offer, the card summary being recomputed from the offers that matched, and explicit sorting using that same offer subset
- product-unit totals, offsets, and keyset cursors, including cursors being scoped to the aggregate/filter semantics that minted them
- favorite product snapshots preserving category ancestors so group-category filters match the same products as server search
- a page of results costing a bounded number of statements instead of one lookup per result
- offline production-shaped parser fixtures enforcing relative CPU regression thresholds for raw
  parse, catalog normalization, and page discovery
- the migration backfill being the same derivation the incremental sync runs, not a second definition of grouping
- consistency reporting each read-model invariant separately, and the rebuild converging on re-run

`scripts/verify-search-integration.ts` covers what SQL-shape assertions cannot: it runs against a locally migrated D1 in CI to prove that the trigram index really resolves `TAD 1000` and that two shops' confirmed listings collapse into one entity while an unconfirmed listing stays separate.

Migrations are forward-only and run before replacement Worker code. Use additive schema changes
for mixed-version deployment, then retire obsolete structures only after callers have moved. Review
the currently deployed SHA and schema compatibility before a rollback.
