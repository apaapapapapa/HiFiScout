# Data platform architecture: D1 search, product identity, and R2 evidence

Status: Accepted

## Decision

HiFiScout keeps Cloudflare D1 as the system of record for structured product data. R2 is used only for large, unstructured diagnostic/verification evidence. Product search stays on D1 FTS5. Product identity is deterministic and explainable and uses the verified Knowledge Catalog as its canonical-product basis.

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

### R2: unstructured evidence only

R2 stores HTML evidence that is useful for parser/crawl/classification/Knowledge Catalog investigation. D1 stores only metadata and the R2 object key; HTML is never stored in D1.

Normal successful crawl HTML is not archived.

## Product search

Since Phase 4 the user-facing unit of search is a **product**, not a seller listing. Three shops listing the same amplifier produce one result with three offers, and every count, filter, sort and page boundary is defined over products.

### Search entities

`product_search_entities` is the product-level read model. Each row is one **search entity**, which is either:

- a confirmed Knowledge Catalog product (`entity_kind = 'catalog'`, public key `c-<catalog id>`); or
- a single unresolved listing standing in for itself (`entity_kind = 'unresolved_listing'`, public key `l-<listing id>`).

The fallback kind is mandatory rather than a nicety: identity coverage is incomplete, and without it a listing the catalog has not confirmed would silently stop being findable. Public keys are namespaced because catalog ids and listing ids overlap numerically and must never be mistaken for each other.

`product_search_entity_offers` maps each active listing to exactly one entity. `listing_product_id` is the table's primary key, so duplicate membership is impossible by schema rather than by convention.

Grouping is decided only by Product Identity Resolution: a listing joins a canonical entity when its resolution is `matched` against a verified `knowledge_catalog_products` row. Candidates, fuzzy suggestions, equal titles and equal model stems never merge two shops — variants such as `MK2`, `SE` and `Meta` therefore stay separate for exactly as long as the identity layer says they are different products. Search never runs a second grouping engine of its own.

An entity exists only while it holds at least one active offer, which is what retires a fallback entity when its listing becomes confirmed and what retires a canonical entity when every shop has sold out.

`src/db/product-search-entity-sql.ts` holds the single definition of that derivation. The crawler's incremental sync, the deterministic rebuild (`POST /api/admin/product-search/rebuild`) and the migration backfill all execute the same statements — scoped or unscoped — so the repair path cannot disagree with the live path.

`GET /api/admin/product-search/consistency` reports drift per invariant: active listings with no membership, memberships pointing at inactive listings, entities with no offers, fallback entities whose listing is now matched, catalog entities whose product is no longer eligible, stale offer-count aggregates, and FTS index integrity. The deploy pipeline fails on any of them rather than leaving a product quietly unsearchable.

### Search projection

`product_search_projection` decouples listing search vocabulary from the physical shape of `products` and feeds the seller evidence folded into each entity's search terms. Its FTS5 external-content table is `product_search_fts` with the trigram tokenizer.

The projection contains:

- canonical manufacturer ID
- canonical/raw manufacturer names and deterministic manufacturer aliases
- source model
- identity-normalized model
- deterministic model presentation aliases
- title
- canonical/raw category terms and existing category search aliases

The crawler refreshes only the listings whose inputs actually moved in the current crawl: the ones it inserted, changed, reactivated, or deactivated. Title-derived feature facts follow the same delta: they are written by the listing write itself, for those listings only, because a title that did not move cannot have produced different facts, and the drift a rule change leaves on untouched listings belongs to the resumable remediation worker rather than to a whole-inventory pass on every crawl. `metadata_json` deliberately does not follow that delta — the change-detection behind it never compares metadata, and some metadata exists only in the freshly parsed listing (`categoryClassification.detailCheckedAt`, the negative cache for detail-page fetches, is written precisely when the check left every column alone). `syncProductMetadata` is handed the whole observed set and computes its own delta against the stored JSON. A listing the seller re-reported unchanged projects to exactly what is already stored, so re-deriving the whole inventory every time bought nothing and made the cost of a routine crawl track the size of the shop. Stale resolver versions and Knowledge Catalog edits are replayed by the remediation queue, which is a resumable worker of its own rather than something hidden inside a normal crawl. The repository compares the calculated projection with the persisted one and skips unchanged writes. SQL triggers provide a safe baseline for product writes performed outside that path and keep FTS rows synchronized.

Migration 0017 deliberately retained the old `products_fts` table because production migrations run before the replacement Worker is deployed. After all application search callers had moved to `product_search_fts`, migration 0020 removed the retired `products_fts` virtual table and its three `products_fts_*` triggers. D1 therefore maintains only the active search index and no longer pays duplicate FTS write/storage cost.

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

Explicit sorting follows the same offer subset as the card whenever an offer filter changes the meaning of the sort key. In those cases the page query joins one request-scoped aggregate over the matching offers and orders by that aggregate. Unfiltered sorts continue to use the indexed stored entity aggregates. `priceAsc` / `priceDesc` with only `inStock=true` is also served by the stored `lowest_in_stock_price_yen` aggregate, because that column already represents exactly that subset.

| `?sort=` | ordering |
| --- | --- |
| `newest` | newest offer publication/first-seen time, descending |
| `oldest` | the same aggregate ascending — the exact inverse, not a different column |
| `updated` | most recent meaningful listing activity across offers, descending |
| `priceAsc` / `priceDesc` | lowest offer price; the lowest **in-stock** price when `inStock=true`, so "cheapest first" never orders by a price nobody can buy |

The cursor records both the aggregate variant and, for request-scoped sorts, the offer-filter scope that defined it. A cursor therefore cannot resume under an ordering whose visible card values were calculated from a different offer subset. `items`, `hasMore`, `totalCount`, `totalPages` and cursor movement all operate on entities before any offer is loaded.

Offer summaries and representative offers are loaded in chunks of 40 entity ids to stay under D1's bind-parameter ceiling. At the maximum `limit=100`, a filtered list response therefore costs at most eight statements: an optional count, the entity page, up to three offer-aggregate chunks and up to three representative-offer chunks. Unfiltered responses skip the aggregate loader. The query count is bounded by page size, not result cardinality, and there is no per-result offer lookup.

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

`GET /api/admin/knowledge-catalog/duplicates` reports those sets. Detection runs in two stages, because neither half can be done alone:

1. SQL buckets verified rows by a key that drops the separators and folds the `MARK`/`MK` revision spellings. The key is a deliberate over-approximation of the identity normalizer, and paging walks bucket keys rather than row ids so a set is never split across pages.
2. TypeScript re-keys each bucket with `normalizeIdentityModel` and the manufacturer resolver — the same pair Product Identity matches on — and keeps only the sub-groups with more than one member.

A bucket that is too coarse therefore costs a discarded row, never a reported group: two manufacturers that share a model string fall apart in stage 2, and a model that normalizes to no identity at all is never reported. Detection only proposes. Merging stays the existing operator-confirmed `POST /api/admin/knowledge-catalog/products/{id}/merge`, which moves the losing row's aliases, sources, verification attempts, and identity resolutions onto the surviving catalog and then replays it.

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

`syncProductSearchEntities` is scoped strictly to the listings it is given and the identity peers they regroup. Retiring the memberships of listings that disappeared is a shop-wide question, and answering it inside every call made the cost of a chunk depend on the size of the shop; it is the crawl's own `membership_cleanup` stage, which walks the same set in bounded chunks after the entity refresh and reports as `membership_cleanup` in the crawl summary.

`GET /api/admin/data-platform/status` (ADMIN_TOKEN protected) reports bounded D1 counts useful for migration/capacity decisions:

- total and active products
- price-history rows
- Knowledge Catalog rows and verified rows
- identity matched/unresolved/veto counts
- evidence metadata count
- crawl runs in the last 24 hours

Cloudflare already provides D1 platform analytics for database storage size, read/write query volume, rows read/written, and query latency. HiFiScout does not copy these time-series metrics into D1. Operators should use the Cloudflare D1 Metrics view / GraphQL Analytics API and Worker observability for platform error/timeout signals.

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
- only a matched resolution against a verified catalog product merging two shops, with unresolved listings staying searchable as fallback entities
- offer-level filters holding for one and the same offer, the card summary being recomputed from the offers that matched, and explicit sorting using that same offer subset
- product-unit totals, offsets, and keyset cursors, including cursors being scoped to the aggregate/filter semantics that minted them
- favorite product snapshots preserving category ancestors so group-category filters match the same products as server search
- a page of results costing a bounded number of statements instead of one lookup per result
- the migration backfill being the same derivation the incremental sync runs, not a second definition of grouping
- consistency reporting each read-model invariant separately, and the rebuild converging on re-run

`scripts/verify-search-integration.ts` covers what SQL-shape assertions cannot: it runs against a locally migrated D1 in CI to prove that the trigram index really resolves `TAD 1000` and that two shops' confirmed listings collapse into one entity while an unconfirmed listing stays separate.

The migrations are forward-only. Migration 0017 preserved the old FTS stack only for its rollout window; migration 0020 removes it after all callers have migrated and backfills any listing missing an Identity resolution row without merging products. Migration 0021 is purely additive for the same reason — migrations run before the replacement Worker is deployed, so the listing search structures stay untouched and keep serving traffic while the product entity tables fill in.
