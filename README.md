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

Requires Node.js 22+.

```bash
npm ci
npm run db:migrate:local
npm run build:frontend
npm run dev
```

Run all pre-commit checks with one command:

```bash
npm run verify
```

`npm run verify` applies formatting/lint fixes, then runs the read-only gate (`lint`, `format:check`, TypeScript-only source check, `typecheck`, and unit tests). See `AGENTS.md` for repository rules used by coding agents.

Useful commands:

```bash
npm run test:unit
npm run typecheck
npm run build
npm run create-shop -- <shop-key>
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

`main` is deployed through `.github/workflows/deploy.yml`. CI is defined in `.github/workflows/ci.yml`; deployed-environment E2E is separate. D1 migrations are applied in order and applied migration files must never be edited.

Operational workflows that remain in the repository must represent repeatable production operations, not one-time migration steps. Completed one-off workflows and their helper scripts should be removed once the permanent runtime path replaces them; Git history remains the archive.

D1 Time Travel is the first-line point-in-time recovery mechanism. `.github/workflows/backup.yml` also exports D1 on a schedule and may copy backups to R2 when configured.

## Documentation policy

Keep documentation small and current:

- update a canonical guide instead of adding another status document;
- delete completed migration plans and dated production snapshots once their durable invariants are represented in code/tests/current docs;
- avoid copying shop lists, schedules, schema details, or configuration values that already have a canonical source file;
- use Git history and PRs for historical implementation detail.

Developer documentation is published from `docs/`; `docs/.vitepress/config.mts` lists the curated navigation. Generated API/schema/dependency output is not hand-edited.
