# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. It crawls configured shops on a schedule, normalizes seller facts, resolves product identity, and exposes a product-oriented search API/UI on Cloudflare Workers + D1.

> Broad public release should wait until each collector and the applicable site terms have been re-checked.

## Design principles

- Store only factual listing data needed for search: shop, manufacturer, model/title, category, condition, price, stock state, source URL, and observation timestamps.
- Do not republish seller images, descriptions, staff comments, or logos.
- Always link users to the seller's original product page.
- User traffic never triggers seller crawling; scheduled work is dispatched through Cloudflare Queues.
- Respect `robots.txt`, authentication boundaries, rate limits, and shop-specific request delays.
- Treat D1 as the system of record; R2 stores bounded evidence artifacts.
- Group search results by resolved product identity, while preserving shop-specific offers and price history.

## Architecture

```text
Browser
  ├─ static UI
  └─ /api/* ── Worker ── D1 / FTS5
                         ├─ listings + price history
                         ├─ product identity + search entities
                         ├─ catalog / data-quality state
                         └─ crawl state

Cron ── dispatcher ── Cloudflare Queue ── shop plugin ── normalize / resolve / persist
                                           │
                                           └─ relay transport when a shop requires it

R2 ── evidence archive
GitHub Actions ── CI / deployment / operational audits / backups
```

The shop platform is plugin-based. Runtime shop definitions, enabled adapters, transport choices, and defaults are composed in `src/crawler/shops/index.ts`; do not duplicate that inventory in documentation.

## Sources of truth

| Concern | Source of truth |
| --- | --- |
| Registered shops and plugin capabilities | `src/crawler/shops/index.ts` |
| Shop onboarding contract | `docs/adding-shops.md` |
| Production Worker configuration | `wrangler.jsonc` / `wrangler.admin.jsonc` |
| Database schema | ordered files in `migrations/` |
| Product search | `src/db/product-search-repository.ts`, `src/search/fts-query.ts` |
| Product identity / catalog | `src/catalog/` |
| Data-quality rules | `src/data-quality/`, `docs/data-quality.md` |
| Current remediation work | `docs/data-quality-remediation.md` |
| Architecture / storage boundaries | `docs/data-platform-architecture.md` |
| Tests and E2E policy | `docs/testing-strategy.md` |
| Evidence limits | `docs/r2-evidence-safety.md` |
| Admin behavior | `docs/listing-admin.md` and admin source/tests |

Prefer these sources over historical PR descriptions, completed migration plans, or old production snapshots.

## Local development

Requires Vite+ 0.2.9. Vite+ manages the project's Node.js 22 toolchain and npm version.

```bash
vp env use 22
vp install
vp run db:migrate:local
vp run build:frontend
vp run dev
```

Run all pre-commit checks with one command:

```bash
vp run verify
```

`vp run verify` applies formatting/lint fixes, then runs the read-only gate (`lint`, `format:check`, TypeScript-only source check, `typecheck`, and unit tests). See `AGENTS.md` for repository rules used by coding agents.

Useful commands:

```bash
vp run test:unit
vp run typecheck
vp run build
vp run create-shop -- <shop-key>
```

The application is TypeScript-only. Generated JavaScript in `public/`, `admin-public/`, `dist/`, and `.generated/` is build output, not source of truth.

## API

Primary endpoints:

- `GET /api/product-search` — product-level search/filter/sort with shop offers.
- `GET /api/product-search/:key` — one search entity and its eligible offers.
- `GET /api/products/:id/history` — listing-scoped observed price history.
- `GET /api/meta` — current shop/configuration metadata used by the UI.
- `GET /api/health` — crawler-aware health status.
- `GET /api/admin/product-search/consistency` — product-search projection consistency.
- `POST /api/admin/product-search/rebuild` — deterministic product-search read-model rebuild.
- `POST /api/admin/crawl?shop=<shop-key>` — enqueue a forced crawl for an enabled shop.

Read the route/API source before adding hard-coded request or response examples to documentation; contracts evolve faster than prose.

## Operations

`main` is deployed through `.github/workflows/deploy.yml`. That workflow owns resource provisioning, migrations, Worker deployment, and the immediate runtime smoke check. Deeper Product Search, Product Identity, and data-quality invariants run afterward in `.github/workflows/production-operational-health.yml`, so a production data-state incident cannot rewrite an already successful Worker deployment as if it never happened. CI is defined in `.github/workflows/ci.yml`; deployed-environment E2E is separate. D1 migrations are applied in order and applied migration files must never be edited.

Crawler dispatch state is interpreted through `src/crawler/crawl-lifecycle.ts`. The persisted queue reservation and execution lease form the explicit `idle` / `queued` / `executing` lifecycle; watchdog recovery must re-send the same logical child rather than replacing its dispatch identity.

A crawl reports its progress as stages (`src/crawler/crawl-stages.ts`). Every stage logs `crawl_stage_start` and then `crawl_stage_complete` with its input count and duration, so a `crawl_stage_start` with no completion identifies where an invocation died — a Queue invocation killed at the platform's wall-clock limit runs no catch or finally block and leaves no exception behind. Runs left `running` past the execution lease are closed by `recoverStalledCrawlRuns` on the general cron, which also records the interruption against shop health so an abandoned crawl degrades the shop and applies the normal backoff instead of looking merely busy.

Derived work survives that interruption. Immediately after the listing write, a crawl records the listings whose inputs actually moved and the stages it still owes (`crawl_run_work_items`, `crawl_run_stages`); each stage is marked done as it finishes. From that point the seller never has to be visited again, so `resumeInterruptedCrawlRuns` on the general cron can finish the projections in bounded chunks, in dependency order, reading only persisted listings. The pending work is durable before any of it is attempted, so the sweep is the dispatch — there is no window in which a run is owed a continuation that was never sent. A chunk's cursor advances only after its own writes commit, so an invocation killed between the two replays exactly that chunk against idempotent stages, and a run whose shop has since started a newer crawl is retired rather than finished — after that newer run has adopted whatever the older one never projected, so retiring it discards only work that has already been taken over.

The crawl that owns the work and the sweep that inherits it run the same bounded runner, under one per-invocation time budget measured from the top of the crawl. Stopping on that budget is an ordinary outcome rather than a failure: the remaining chunks are already durable, so the crawl hands them to the sweep instead of gambling on the platform's wall-clock limit. Only the delta is projected — a listing the seller re-reported unchanged derives to what is already stored, and resolver-version and catalog replays belong to the remediation queue. Retiring the memberships of listings that disappeared is shop-wide rather than run-scoped, so it is its own bounded final stage instead of a whole-shop pass inside every chunk.

Inventory freshness and search consistency are separate watermarks. `last_success_at` says when a shop's listings were last collected; `last_projection_at` says when its derived work last finished, and only whoever finished it advances it — the crawl when it drains its stages inline, the sweep when it finishes them later. A crawl that deferred its remaining chunks or lost a stage therefore reports fresh listings without claiming search has caught up, and `/api/health` grades the gap against the same interval factors as staleness: brief trailing is ordinary, a gap that keeps growing reports `projection_delayed` and then `projection_stale`. The watermark only moves forward, so the sweep completing an older generation after a newer crawl cannot invent a regression.

Queue lanes remain scheduling hints. `crawl_workload_observations` keeps a high-water record of what each shop's crawls actually cost — peak inventory, and how often one had to hand derived work to the sweep — so a shop that turns out to be large is scheduled as large from its own history rather than from a declaration nobody updated. The marks only ever move up, so a lane cannot flap. Nothing about chunking, checkpointing or completion depends on the classification: a shop left in the wrong lane still finishes through the same continuations.

Operational workflows that remain in the repository must represent repeatable production operations, not one-time migration steps. Completed one-off workflows and their helper scripts should be removed once the permanent runtime path replaces them; Git history remains the archive.

D1 Time Travel is the first-line point-in-time recovery mechanism. `.github/workflows/backup.yml` also exports D1 on a schedule and may copy backups to R2 when configured.

## Documentation policy

Keep documentation small and current:

- update a canonical guide instead of adding another status document;
- delete completed migration plans and dated production snapshots once their durable invariants are represented in code/tests/current docs;
- avoid copying shop lists, schedules, schema details, or configuration values that already have a canonical source file;
- use Git history and PRs for historical implementation detail.

Developer documentation is published from `docs/`; `docs/.vitepress/config.mts` lists the curated navigation. Generated API/schema/dependency output is not hand-edited.