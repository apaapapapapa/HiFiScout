# Testing strategy

HiFiScout follows a test pyramid: most behavior is verified in-process with Vitest through Vite+, while browser E2E coverage is intentionally small and runs only against a deployed development environment.

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

Use the Vite+ Vitest runner and in-memory fakes to verify boundaries between modules: Worker route handlers with fake D1 responses, repository SQL behavior through a D1-shaped fake, crawler orchestration with mocked fetch/browser adapters, and the common shop contract.

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

```sh
cd e2e
npm install --no-package-lock
vp exec playwright install chromium
E2E_BASE_URL=https://hifiscout.raha3415kohei.workers.dev npm test
```

`E2E_BASE_URL` can point at another deployed development environment. The checked-in default is the existing workers.dev environment.

## CI policy

The normal `CI` workflow runs migrations, `scripts/verify-search-integration.ts` against that locally migrated D1, the fast Vite+ unit-test suite (Vitest), and Wrangler dry-run validation. It does not install a browser.

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