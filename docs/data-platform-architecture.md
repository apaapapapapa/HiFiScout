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
- Listing -> Knowledge Catalog product identity resolutions
- R2 evidence metadata

The existing Repository boundary remains the storage boundary. Domain logic must not depend directly on a D1-specific API where a repository already owns persistence. This keeps a future D1 -> PostgreSQL repository replacement possible without introducing a large ORM/DAO framework now.

### R2: unstructured evidence only

R2 stores HTML evidence that is useful for parser/crawl/classification/Knowledge Catalog investigation. D1 stores only metadata and the R2 object key; HTML is never stored in D1.

Normal successful crawl HTML is not archived.

## Product search

### Search projection

`product_search_projection` decouples search vocabulary from the physical shape of `products`. Its FTS5 external-content table is `product_search_fts` with the trigram tokenizer.

The projection contains:

- canonical manufacturer ID
- canonical/raw manufacturer names and deterministic manufacturer aliases
- source model
- identity-normalized model
- deterministic model presentation aliases
- title
- canonical/raw category terms and existing category search aliases

The crawler refreshes only listings observed in the current crawl. The repository compares the calculated projection with the persisted one and skips unchanged writes. SQL triggers provide a safe baseline for product writes performed outside that path and keep FTS rows synchronized.

The legacy `products_fts` table is intentionally retained during this migration. Production migrations run before the new Worker is deployed, so dropping the old index in the same migration would create a rollout window in which the old Worker could fail.

### Multi-term FTS queries

User input is parsed by `src/search/fts-query.js`; it is never concatenated directly as raw FTS syntax.

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

### Ranking

When the API caller does not request an explicit sort, text search applies a small deterministic preference before FTS5 `bm25`:

1. known manufacturer + normalized model exact match
2. normalized model exact match
3. exact title
4. FTS5 rank
5. latest activity as a tie breaker

When the caller explicitly selects `newest`, `oldest`, `updated`, `priceAsc`, or `priceDesc`, that sort remains authoritative. No separate ranking engine is introduced.

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

Existing listings are initially seeded as `backfill_pending` + `unresolved`. They are reevaluated incrementally by normal shop crawls. The migration never bulk-merges existing production listings.

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

## Evidence Archive

### Archive decisions

`src/evidence/evidence-archive.js` has an explicit allow-list of archiveable reasons. The crawler currently emits evidence for:

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

The application records `expires_at` in D1, and the existing daily retention cleanup removes expired evidence metadata in bounded batches. Object deletion itself is delegated to R2 lifecycle rules rather than a custom lifecycle engine.

### Failure semantics

Evidence archival is best-effort. Missing bindings, hashing/database errors, and R2 write failures are logged and returned as archive failures; they are not thrown into the product crawl update path. A crawler failure remains a crawler failure for its original reason, not because evidence could not be stored.

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

`wrangler.jsonc` binds `EVIDENCE_BUCKET` to the `hifiscout-evidence` R2 bucket. The production deployment workflow creates the bucket if necessary and reconciles the three HiFiScout-owned lifecycle rules before deploying the Worker.

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
- evidence archive allow-list, redaction, hash deduplication, and best-effort R2 failure behavior

The migration is designed to be forward-only, keep existing production product rows intact, preserve the legacy FTS index during rollout, and incrementally converge existing listings through normal crawler runs.
