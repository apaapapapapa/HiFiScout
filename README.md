# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. It collects
factual seller listings, resolves product identity, and presents product-oriented search and offer
comparison through a React UI on Cloudflare Workers + D1.

> Broad public release should wait until each collector and the applicable site terms have been re-checked.

## Design principles

- Store factual listing data needed for search and link users to the original seller page.
- Do not republish seller images, descriptions, staff comments, or logos.
- User traffic never triggers seller crawling. Per-shop Durable Objects execute scheduled crawls
  with Alarm-based pacing and resumable steps.
- Respect `robots.txt`, authentication boundaries, rate limits, and shop-specific request delays.
- D1 owns structured facts and search projections; R2 holds bounded evidence and generated exports.
- Preserve shop-specific offers and listing price history while grouping safe product identities.

## Architecture

| Component | Responsibility | Source |
| --- | --- | --- |
| Public Worker | Static React UI, public HTTP API, Cron and non-crawl Queue entry points | `src/worker.ts`, `src/index.ts` |
| Crawl control | Reserve a dispatch generation and deliver it to one DO per shop; recover the same token | `src/scheduled.ts`, `src/crawler/dispatch.ts` |
| CrawlScheduler DO | Bounded fetch/parse/finalize steps and PREPARE / Alarm / FETCH pacing | `src/crawler/crawl-scheduler-do.ts` |
| Shop plugins and relay | Seller discovery/parsing and transport; optional Tokyo Lambda HTTP relay | `src/crawler/shops/index.ts`, `infra/audiounion-lambda/` |
| D1 / FTS5 | Listings, catalog identity, product entities/offers, price projections, durable work | `src/db/`, `migrations/` |
| Post-commit Queues | Knowledge Catalog verification and asynchronous CSV exports; independent of crawling | `src/queue.ts`, `wrangler.jsonc` |
| Admin Worker | Cloudflare Access authentication and internal `CatalogAdminService` RPC | `src/admin/entry.ts`, `wrangler.admin.jsonc` |
| GitHub Actions | CI, deployment, documentation publication, audits, and backups | `.github/workflows/README.md` |

See [Crawl orchestration](docs/crawl-orchestration.md) and
[Data platform architecture](docs/data-platform-architecture.md) for lifecycle and storage contracts.

## Sources of truth

| Concern | Source of truth |
| --- | --- |
| Registered shops, capabilities, transport, defaults | `src/crawler/shops/index.ts` |
| Deployed bindings and configuration | `wrangler.jsonc`, `wrangler.admin.jsonc` |
| Cron selection and maintenance cadence | `src/scheduled.ts` and registered shop definitions |
| Database schema | Ordered `migrations/*.sql` |
| Public search and price summaries | `src/http/public-routes.ts`, `src/db/product-search-price-index-repository.ts` |
| Product identity and exact fallback grouping | `src/catalog/product-identity.ts`, `src/db/product-search-exact-identity.ts` |
| Taxonomy, classification, remediation | `docs/data-quality.md`, `docs/data-quality-remediation.md`, `src/catalog/` |
| Public visual direction | `DESIGN.md` |
| Admin behavior | `docs/listing-admin.md`, `src/admin/contracts.ts` |
| Commands and toolchain | `package.json`, `package-lock.json`, `vite.config.ts` |
| Developer documentation | `docs/index.md` |
| AI contributor instructions and task map | `AGENTS.md`; `CLAUDE.md` imports it |

Prefer these sources over historical PR descriptions, completed migration plans, and production snapshots.

## Local development

Install the Vite+ version declared in `package.json`. Vite+ manages the Node.js and npm versions in
`devEngines`; use the root lockfile for reproducible installs.

```bash
vp install --frozen-lockfile
vp run db:migrate:local
vp run dev
```

`dev` builds both frontend bundles before starting Wrangler. Run all source pre-commit checks with
`vp run verify`; it applies format/lint fixes and runs the read-only checks, parser benchmark, and
Vitest suite. `vp run check` runs the gate without applying fixes.

| Task | Command |
| --- | --- |
| One unit-test file | `vp test run test/<name>.test.ts` |
| Build public/admin UI, Workers, and Lambda | `vp run build` |
| Scaffold a shop | `vp run create-shop -- --key <shop-key> --name "<name>" --base-url https://example.com --transport direct --interval 60` |
| Build developer documentation | `vp run docs:build` |

See [Adding shops](docs/adding-shops.md), [TypeScript development](docs/typescript.md), and
[Testing strategy](docs/testing-strategy.md). Generated browser/Worker/Lambda JavaScript is build output.

## Public API and administration

Primary public endpoints include:

- `GET /api/product-search` — product-level search/filter/sort with eligible offers and price summaries.
- `GET /api/product-search/:key` — one search entity and its offers.
- `GET /api/suggest` — search suggestions.
- `GET /api/products/:id/history` — listing-scoped observed price history.
- `GET /api/meta` — shop state and precomputed metadata counts, including `countsUpdatedAt`.
- `GET /api/health` — crawler-aware health status.
- `POST /api/product-correction-reports` — submit a bounded product correction report.

The [HTTP API reference](docs/reference/http-api.md) describes executable contract coverage; it is
not yet a complete inventory of every route. Read `src/index.ts` together with the router when
checking reachability: public `/api/admin/*` requests return 404 regardless of `ADMIN_TOKEN`.
The separate Access-protected admin Worker supports catalog/listing corrections and exports through
the Service Binding. Operational checks and manual replay use the maintained Actions/scripts.

## Operations and resource use

`last_success_at` records collection freshness; `last_projection_at` records completion of derived
work. A fresh collection can therefore coexist with trailing search projections. Durable work items
and cursors let maintenance resume incomplete projections without fetching the seller again.

General Cron serializes watchdog and maintenance work under one D1-call/wall-time budget, persisting
pending tasks across ticks. Normal identity repair consumes a dirty set; the full exact-identity scan
is a daily safety net. Public metadata and recent price medians read persisted projections. See the
data-platform and crawl guides for the remaining costs and measurement limits.

`Deploy Cloudflare` owns provisioning, migrations, Worker deployment, and the immediate smoke check.
Product Search/Identity/data-quality checks run in the separate `Production Operational Health`
workflow. Downstream workflows consume the exact SHA in the `deployment-identity` artifact.
A successful but quota-deferred/no-op deploy does not publish that artifact or change production.
See the [workflow responsibility map](.github/workflows/README.md) before diagnosing or changing CI/CD.

D1 migrations run before the replacement Worker. Add backward-compatible migrations; never edit an
applied migration. Evaluate actual D1 rows read/written, Workers CPU, DO usage, and Queue operations
before claiming that the application fits the free tier.
