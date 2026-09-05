# Testing strategy

HiFiScout follows a test pyramid: most behavior is verified in-process with Vitest, while browser E2E coverage is intentionally small and runs only against a deployed development environment.

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

### 3. E2E — minimal smoke layer

Playwright lives in `e2e/` so Chromium and the Playwright runner are not dependencies of the fast unit-test job.

The E2E suite validates only critical wiring that smaller tests cannot prove:

- the deployed page loads and can call `/api/meta` and `/api/product-search`;
- the catalog UI initializes successfully from live API responses;
- changing a shop filter propagates the selected value to `/api/product-search` and refreshes the UI;
- a product listed by several shops renders as one card, and opening it fetches `/api/product-search/:key` and shows each shop's offer with its own link.

Tests against live data deliberately avoid assertions such as a specific product, price, manufacturer, or result count being present. Development data changes continuously, so those assertions would create flaky tests without increasing confidence in application wiring. The cross-shop grouping flow is the exception and uses routed fixtures, because the point of that test is what the browser does with a multi-offer product — the grouping SQL itself is proven by the repository unit tests.

## Running E2E locally

From the repository root:

```sh
vp install --frozen-lockfile
vp exec playwright install chromium
E2E_BASE_URL=https://hifiscout.raha3415kohei.workers.dev vp run test:e2e
```

`E2E_BASE_URL` can point at another deployed development environment. The checked-in default is the existing workers.dev environment.

## CI policy

The normal `CI` workflow runs migrations, `scripts/verify-search-integration.ts` against that locally migrated D1, the fast Vitest suite, and Wrangler dry-run validation. It does not install a browser.

The search integration check exists because two behaviors cannot be proven by asserting on generated SQL: that the FTS5 trigram index actually resolves a query like `TAD 1000`, and that two shops' confirmed listings really collapse into one search entity while an unconfirmed listing stays on its own. Those are properties of the database, so they are verified against a real one.

The `E2E` workflow runs after a successful `Deploy Cloudflare` workflow, so it checks the version that was actually deployed instead of racing the deployment. It can also be started manually with an alternate base URL. A single Chromium worker is used to keep cost, duration, and nondeterminism low.

## Post-Phase-4 remediation regression coverage

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

`remediation-search-integration` is the only suite that runs against the real migrated schema
in-process, through `test/helpers/migrated-sqlite.ts`. Reach for that helper when the behaviour under
test lives in the schema — an FTS index, a trigger, a CHECK, a uniqueness constraint — rather than in
the SQL a repository emits. Everything else is cheaper to prove with `captureDatabase`.

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

`test/d1-write-budget.test.ts` runs the production repositories against an isolated Miniflare D1
with every checked-in migration. It asserts on workerd's `meta.rows_written`, which includes
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

Page-level D1 checkpoints and daily listing freshness remain part of the recovery/availability
contract. Moving them to DO/R2 requires a separate design that preserves resumable fetch/parse,
complete-inventory publication and idempotent finalization, and budgets the destination's operations
as well as D1 writes. Reducing duplicate/same-value writes is the first step; migration alone is not
a quota reduction.
