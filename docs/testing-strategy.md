# Testing strategy

HiFiScout follows a test pyramid: most behavior is verified in-process with Vitest. Browser component tests run against a local fixture gallery; deployed-environment E2E remains small and checks public user flows after deployment.

## Pyramid

### 1. Unit tests — default and largest layer

Run with `vp run test` or `vp run test:unit`, or as part of `vp run verify`. A single file runs with
`vp test run test/<name>.test.ts`.

The default reporter is `dot`: a passing run prints compact progress instead of one line per test, and
failing tests still print their assertion, diff, and stack in full. `vp run test:unit:verbose` uses
Vitest's verbose reporter when you need to read passing test names.

Keep parsing, normalization, category inference, query construction, scheduling decisions, guards, and shop-specific mapping rules here. Prefer pure functions and deterministic fixtures. Stub network, browser, queue, and D1 boundaries rather than exercising remote services.

A regression should be added at this layer whenever the bug can be reproduced without a deployed Worker. This is the preferred layer for almost all parser and catalog-classification defects.

### 2. Component / contract tests — small middle layer

Use Vitest and in-memory fakes to verify boundaries between modules: Worker route handlers with fake D1 responses, repository SQL behavior through a D1-shaped fake, crawler orchestration with mocked fetch/browser adapters, and the common shop contract.

Do not call retailer sites from CI. Remote shop availability, anti-bot behavior, rate limits, and regional routing are operational concerns and should be covered by health/observability rather than deterministic CI tests.

If a component test grows into a full browser or remote-service test, split the domain logic out and move the assertions down to unit tests.

### 3. Browser components — local fixture gallery

The separate browser component suite uses `e2e/playwright.components.config.ts`, `e2e/components/`,
and `playwright/gallery/`. Its mocked API fixtures exercise React UI behavior without a deployed
Worker or seller network calls. Run it with
`vp exec playwright test --config e2e/playwright.components.config.ts`; Playwright starts the gallery
server. This is the `component` job in CI, distinct from deployed E2E. Public catalog cases cover initialization retry, loading/empty states, mobile draft application and focus, detail retries, favorite persistence, and responsive layout. Admin cases cover dirty-form close guards and merge confirmation. Price parsing and request timeout/cache behavior stay in Vitest.

### 4. E2E — minimal deployed smoke layer

Playwright lives in `e2e/` so Chromium and the Playwright runner are not dependencies of the fast unit-test job.

The E2E suite validates only critical wiring that smaller tests cannot prove:

- the deployed page loads and can call `/api/meta` and `/api/product-search`;
- the catalog UI initializes successfully from live API responses;
- changing a shop filter propagates the selected value to `/api/product-search` and refreshes the UI;
- a product listed by several shops renders as one card, and opening it fetches `/api/product-search/:key` and shows each shop's offer with its own link.

Tests against live data deliberately avoid assertions such as a specific product, price, manufacturer, or result count being present. Catalog data changes continuously. Routed fixtures cover deterministic grouping, taxonomy, URL-state, and permalink cases; the grouping SQL itself is verified below the browser layer.

## Running E2E locally

From the repository root:

```sh
vp install --frozen-lockfile
vp exec playwright install chromium
E2E_BASE_URL='https://your-deployed-worker.example' vp run test:e2e
```

Set `E2E_BASE_URL` to the environment you intend to verify. The checked-in fallback is in
`e2e/playwright.config.ts`; a workers.dev hostname alone does not establish that it is a development
environment.

## CI policy

The `CI` workflow runs source/toolchain checks, the sharded Vitest suite, parser performance checks,
local D1 migrations, `scripts/verify-search-integration.ts`,
`scripts/verify-listing-admin-overrides.ts`, React component browser tests, and build/dry-run checks.
The `component` job installs Chromium on a cache miss and saves the browser cache on main for
post-deploy E2E. Japanese screenshot fonts come from a checksum-pinned Ubuntu Noto CJK package and
are cached as font files, avoiding apt repository updates on every run. Unit-test jobs need no browser.
Short source/type/parser/build checks share one runner; expensive suites remain parallel. See
`.github/workflows/ci.yml` and `vite.config.ts` for the required job graph and task-cache inputs.

CI runs four unit-test shards using measured per-file weights in
`.github/config/unit-test-weights.json`, plus a small per-file import allowance.
The sequencer schedules long files first and deterministically assigns
every discovered test exactly once; new tests receive a conservative default weight. CI preserves
the JSON timing reports for seven days and summarizes job duration separately from time before
the first step. Compare equivalent revisions and cache states; parallel job seconds do not add up
to elapsed CI time.

To refresh weights, download all four `unit-timings-*` artifacts and run
`vp exec tsx scripts/ci/update-test-weights.ts <shard-1-report> <shard-2-report> <shard-3-report> <shard-4-report>` from the repository
root. The updater requires passing reports covering every current test file. Alternatively collect
one complete local report with
`vp test run --reporter=json --outputFile=.generated/unit-timings.json` and pass that file. Review
the resulting weights as configuration; they affect scheduling, never which tests are selected.

Documentation-only comparisons skip application suites while retaining the source/toolchain checks
and required `fan-out` result. An uncertain comparison runs everything. Migration safety always
uses a fresh D1 for application changes, independently of the documentation site's schema cache.

The search integration check exists because two behaviors cannot be proven by asserting on generated SQL: that the FTS5 trigram index actually resolves a query like `TAD 1000`, and that two shops' confirmed listings really collapse into one search entity while an unconfirmed listing stays on its own. Those are properties of the database, so they are verified against a real one.

The `E2E` workflow runs after `Deploy Cloudflare`, consuming its `deployment-identity` artifact and
checking out that deployed SHA. A deferred/no-op deployment without the artifact skips E2E. Manual
runs can select an alternate base URL. A single Chromium worker keeps resource use and nondeterminism
low. Production asynchronous data/Queue checks belong to `Production Operational Health`.

## Remediation regression coverage

The remediation work has a fixed regression checklist. Each group has a home, so a new rule is added
next to the ones it belongs with instead of starting a parallel suite:

| Area | Tests |
| --- | --- |
| Manufacturer resolution and alias replay | `manufacturer-resolver`, `manufacturer-repository`, `manufacturer-alias-admin` |
| Model resolution rules | `model-resolver`, `model-repository` |
| Model resolution per shop shape | `model-resolver-shop-inputs` |
| Knowledge Catalog candidates, priority, catalog-driven replay | `knowledge-catalog`, `knowledge-catalog-remediation`, `knowledge-catalog-candidate-selection` |
| Identity safety (revisions, aliases, fuzzy, ambiguity) | `product-identity`, `product-identity-versioning` |
| Replay, versioning and the remediation queue | `data-quality-remediation-queue`, `data-quality-remediation-service`, `data-quality-remediation-sweep` |
| Search behaviour after a remediation changes identity | `remediation-search-integration` |
| Schema and backfill | `*-migration` tests, one per migration |

`remediation-search-integration` and other schema/FTS/performance suites use the real migrated schema
in-process, through `test/helpers/migrated-sqlite.ts`. Reach for that helper when the behaviour under
test lives in the schema — an FTS index, a trigger, a CHECK, a uniqueness constraint — rather than in
the SQL a repository emits. Use `captureDatabase` when the contract can be proven with a D1-shaped
fake, and avoid asserting only on SQL strings when database behavior is the requirement.

## Placement rules for new tests

Choose the lowest layer that can detect the failure:

1. Pure transformation or decision -> unit test.
2. Interaction between HiFiScout modules or an infrastructure adapter -> component/contract test with fakes.
3. Browser-to-deployed-Worker wiring or a critical user journey -> Playwright E2E.

Do not add E2E coverage merely because a bug was discovered through the UI. First reproduce the underlying behavior at unit or component scope; add E2E only if a browser/deployment boundary was part of the defect.

## Free-tier performance regressions

`assertNoGrowingTableScans` checks both table scans and full index walks. Index use alone does not prove a bound. An intentional scan needs a statement-specific allowance describing its cost; catalog tables receive no implicit exemption. Limited unfiltered ordered walks also assert that no sort precedes the limit. Known request-scoped offer sorting still aggregates matching active listings and is recorded explicitly in `remediation-query-plans` (follow-up #484), rather than being called constant-cost.

Frontier tests cover all-empty and late-hit page sets at 100, 1,000 and 10,000 pages and require the nonempty partial index. Metadata tests prove public reads remain two small queries as listings grow, and that fresh or failed snapshot refreshes behave correctly. Search-write tests run the crawler path against real migrated SQLite and compare projection writes and FTS storage through price-only and real text changes. Invocation-budget tests include failed calls, batch accounting, admission before writes, deadline yields, lease fencing and continuation on later ticks. Daily and monthly catalog dispatch tests exhaust the budget after job insertion and at successful Queue dispatch, proving incomplete runs are closed and successful runs are not dispatched again. Reserved finalization remains metered and cannot exceed the invocation's total call cap.

These are structural/behavioral gates. Local SQLite changes, query plans and wall time are not Cloudflare billed rows or Workers CPU measurements. Confirm D1 rows read/written, Queue operations, Durable Object usage and CPU failures in production after rollout.

## D1 write budget regressions

`test/d1-write-budget.test.ts`, `test/d1-crawl-checkpoint-budget.test.ts` and
`test/d1-crawl-collection-budget.test.ts` run the production repositories against isolated
Miniflare D1 databases with every checked-in migration. Each test creates and disposes its own
database through `test/helpers/d1-write-budget.ts`, so the independent scenarios can run on
different CI shards. They assert on workerd's `meta.rows_written`, which includes
secondary indexes, triggers and AUTOINCREMENT's internal sequence. A logical `changes = 0` or a
small `batch()` count alone does not prove a zero-write replay. These tests use local fixtures and
consume no production Cloudflare quota.

The fixed scenarios cover repeated catalog classification (including 100 clock-only metadata
changes), catalog and unresolved exact-group search replay, candidate refresh, real price changes
with history, and completion of pending correction provenance when membership is unchanged.
Read budgets accompany the write assertions to catch optimizations that trade writes for scans.

Catalog metadata retains its decision time while its classification evidence is unchanged; detail
negative-cache times remain meaningful changes. Product updates assign only changed columns.
Search and candidate upserts filter equal rows before INSERT so AUTOINCREMENT is not advanced.
Candidate `last_reviewed_at` records the last materialized decision; the review-run record captures
each scan's execution time. Terminal crawl cleanup clears only payloads that are still present.

Collection progress tests interrupt the DO execution write after the D1 page commit, recreate the
scheduler, and require recovery without another seller fetch. Fetch/parse/404 receipts, early-end
coverage, failed transactions, legacy sessions and generation mismatch use the real migrated schema.
Progress shares the existing DO command write and Alarm; the test counts both operations.

The Miniflare collection fixture includes session/page creation, ten nonempty fetch/parse steps and
the final D1 summary checkpoint: legacy progress bills 134 rows, DO progress 96 rows. In that fixture
the formula is `4 + 13P` versus `6 + 9P`, saving `4P - 2` billed D1 rows for P nonempty pages. This is
collection staging only, not total crawl writes; listing publication, retention, retries and DO
duration retain their own costs. Daily listing freshness and page payloads remain in D1.

Public-cache tests require canonical URLs and clean headers at the internal entrypoint, a rate-limit
check even for a cached URL, no caching of validation/rate-limit/admin errors, and the existing
30-second freshness. Regional cache sharing and concurrent miss collapse are platform behavior,
not simulated production measurements. Follow [Crawl orchestration](./crawl-orchestration.md) for
progress rollout/rollback and [Data platform architecture](./data-platform-architecture.md) for the
Workers Cache boundary.
