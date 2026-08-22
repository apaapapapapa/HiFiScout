# HiFiScout — Claude Code guide

HiFiScout is a Cloudflare Workers + D1 application for cross-shop used-audio search. Cron dispatches due shops to a Queue; the consumer uses shop plugins to crawl, normalize seller facts, resolve catalog identity, update D1/search projections, and archive bounded evidence.

Repository-wide rules live in `AGENTS.md`:

@AGENTS.md

## Commands

| Task | Command |
| --- | --- |
| Everything before a commit | `npm run verify` |
| Read-only CI-equivalent gate | `npm run check` |
| Apply format/lint fixes only | `npm run fix` |
| One unit-test file | `npx tsx --test test/<name>.test.ts` |
| Verbose unit tests | `npm run test:unit:verbose` |
| Local dev server | `npm run dev` |

Run `npm run verify` once near the end of a change instead of invoking formatter, lint, typecheck, and unit tests separately. Successful repository tooling is intentionally quiet; failures retain full diagnostics.

## Repository map

| Path | Contents |
| --- | --- |
| `src/index.ts` | Worker entry and runtime handlers |
| `src/http/` | routing, HTTP helpers, health/status endpoints |
| `src/api/` | API query/contracts |
| `src/crawler/` | dispatch, crawl loop, transports, shared crawler types |
| `src/crawler/shops/index.ts` | shop composition root and current shop inventory |
| `src/crawler/shops/` | concrete shop plugins |
| `src/catalog/` | categories, manufacturers, normalization, identity/catalog logic |
| `src/db/` | repositories and persistence types |
| `src/search/` | FTS/query helpers |
| `src/data-quality/` | quality evaluation and remediation runtime |
| `src/evidence/` | R2 evidence archive |
| `frontend/` | browser TypeScript |
| `test/` | unit/contract/query-plan tests |
| `e2e/` | deployed-environment Playwright tests |
| `migrations/` | ordered D1 migrations |
| `scripts/` | maintained repository/operations tooling |

## Where to start

| Task | Start here |
| --- | --- |
| Add/change a shop | `docs/adding-shops.md`, `src/crawler/shops/index.ts`, nearby adapter |
| Search/ranking/filters | `src/db/product-search-repository.ts`, `src/search/fts-query.ts`, `src/api/product-query.ts` |
| Schema change | new file in `migrations/`; never edit an applied migration |
| Data-quality rules | `docs/data-quality.md`, `src/data-quality/` |
| Current data remediation | `docs/data-quality-remediation.md` |
| Architecture/storage | `docs/data-platform-architecture.md` |
| Test placement | `docs/testing-strategy.md` |
| Evidence limits | `docs/r2-evidence-safety.md` |

## Context discipline

- Prefer the source-of-truth table in `README.md`; do not reconstruct current shop/configuration state from old PRs or snapshots.
- Read symbols/sections, not whole large files. In particular, grep large `types.ts` files and remediation documents before opening them wholesale.
- Do not read generated output (`package-lock.json`, `dist/`, `.generated/`, `public/*.js`, `admin-public/*.js`, `docs/public/`) as implementation source.
- Do not run documentation generators just to understand the code; inspect source, JSDoc, migrations, and curated docs.
- Review with `git diff --stat` first, then inspect only relevant paths.
- For CI failures, inspect failed jobs/logs rather than downloading complete successful workflow logs.
- Completed migration plans, dated operational snapshots, and one-off workflow helpers should not remain as parallel sources of truth. Git history is the archive.
