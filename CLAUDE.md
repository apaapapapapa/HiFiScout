# HiFiScout — guide for Claude Code

Cloudflare Worker + D1 cross-shop search for used hi-fi gear. Cron dispatches due shops to a Queue;
the queue consumer crawls, parses, normalizes, resolves product identity, and writes D1. The Worker
also serves `/api/*` and static assets. The UI is plain TypeScript in `frontend/`, bundled by
esbuild into `public/*.js`.

Repository rules (pre-commit checks, TypeScript-only source policy) live in AGENTS.md:

@AGENTS.md

## Commands

| Task | Command |
| --- | --- |
| **Everything before a commit** | `npm run verify` |
| Auto-fix only (format + lint --fix) | `npm run fix` |
| Read-only gate — exactly what CI runs | `npm run check` |
| One test file | `npx tsx --test test/<name>.test.ts` |
| Test names instead of dots | `npm run test:unit:verbose` |
| Local dev server | `npm run dev` |

`npm run verify` runs `fix` then `check` (lint → format:check → check:no-js-source → typecheck →
unit tests) and prints roughly 700 bytes when everything passes. Run it **once** at the end of a
change instead of invoking the five underlying commands separately — that costs five tool round
trips and about 50 KB of output for the same information.

Failures are still reported in full: the dot test reporter prints the assertion, diff, and stack
for every failing test, and `scripts/run-quiet.ts` replays all suppressed output on a non-zero exit.

## Repo map

| Path | Contents |
| --- | --- |
| `src/index.ts` | Worker entry: `fetch`, `scheduled`, `queue` handlers |
| `src/http/` | Router, response helpers, status endpoints |
| `src/api/` | API contracts, product query, search keys |
| `src/crawler/` | Crawl loop (`run.ts`), `dispatch.ts`, transports (fetch/robots/relay/browser), normalization |
| `src/crawler/shops/` | One adapter per shop plus `registry.ts` — shops are plugins |
| `src/catalog/` | Categories, manufacturers, product identity/normalizer, `knowledge-verification/` |
| `src/db/` | One repository per aggregate; `types.ts` holds row and domain types |
| `src/search/fts-query.ts` | D1 FTS5 query construction |
| `src/evidence/` | R2 evidence archive |
| `src/data-quality/` | Quality evaluator and thresholds |
| `frontend/` | Browser TypeScript, bundled into `public/*.js` |
| `test/` | Node test-runner unit and contract tests, one file per concern |
| `e2e/` | Playwright; requires a deployed environment, not run locally by default |
| `migrations/` | D1 SQL migrations, applied in order |
| `infra/audiounion-lambda/` | Tokyo relay used by Audio Union and Hifido |
| `scripts/` | Repo tooling (scaffolding, doc generation, checks) |

## Where to look first

Read the listed file before searching — these answers are already written down.

| Task | Start here |
| --- | --- |
| Add or change a shop | `docs/adding-shops.md`, then `src/crawler/shops/registry.ts` and a nearby adapter. A normal shop needs no edits to `run.ts`, `dispatch.ts`, or a repository. |
| Search, ranking, or filters | `src/db/product-search-repository.ts`, `src/search/fts-query.ts`, `src/api/product-query.ts` |
| Schema change | Add a new file to `migrations/`; never edit an applied migration |
| Data quality rules | `docs/data-quality.md`, `src/data-quality/` |
| Architecture / storage boundaries | `docs/data-platform-architecture.md` |
| Where a test belongs | `docs/testing-strategy.md` |
| Evidence archive limits | `docs/r2-evidence-safety.md` |

## Token discipline

Context is the scarce resource in this repo; these are the cheap habits that matter here.

- Run `npm run verify` once. Do not run `format`, `lint`, `typecheck`, and `test` as separate calls.
- Do not run `npm run docs:generate`, `docs:build`, or `docs:dev` to answer a question. They
  download pinned toolchains through `npx` and emit large output. Source code, JSDoc, and
  `migrations/*.sql` are the source of truth — read those.
- `.agents/skills/*/SKILL.md` are archived records of completed migration phases (~1,850 lines
  total). Read them only when asked about that phase's history.
- `src/db/types.ts`, `src/catalog/types.ts`, and `src/crawler/types.ts` are 500–1,000 lines each.
  Grep for the symbol you need instead of reading them whole.
- Generated paths are denied to `Read` in `.claude/settings.json` (`package-lock.json`, `dist/`,
  `.generated/`, `public/*.js`, `docs/public/`). Nothing in them is a source of truth.
- Reviewing a change: `git diff --stat` first, then `git diff -- <path>` for the files that matter.
- Reading CI: `gh run view <id> --log-failed`, never `--log`.
