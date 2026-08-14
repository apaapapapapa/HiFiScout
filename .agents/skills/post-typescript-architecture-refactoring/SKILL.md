---
name: hifiscout-post-typescript-architecture-refactoring
description: Project-specific guidance for Phase 2.6 refactoring after the TypeScript migration, covering production code, tests, architecture boundaries, and CI enforcement before Phase 3 Shop Platform work.
---

# HiFiScout Post-TypeScript Architecture Refactoring

Use this skill for Phase 2.6: Post-TypeScript Architecture Refactoring after the JavaScript-to-TypeScript migration is complete.

The goal is not cosmetic file splitting. Use the stronger type information to remove duplicated production paths, restore explicit architecture boundaries, simplify tests, and prepare the codebase for Phase 3 Shop Platform / Shop Adapter standardization.

## Operating rules

- Follow `AGENTS.md` first.
- Work from the current `main`; never trust stale file sizes, SHAs, test counts, or handoff notes.
- Cover both production source and test source. A refactor is incomplete if tests still exercise obsolete implementations or duplicate contracts.
- Preserve externally visible behavior unless the task explicitly includes a behavior change.
- Prefer small, behavior-preserving refactors with regression coverage over rewrites.
- Do not introduce a framework merely to make modules smaller. Keep the existing platform choices unless a separate decision approves a migration.
- Do not weaken TypeScript, runtime validation, data-quality safeguards, crawler safety, or CI to make a refactor easier.
- Do not treat a large file as a defect by itself. Split only along stable responsibilities or architecture boundaries.
- Before deleting an old path, prove which implementation is used by production and move all relevant tests to that production path.
- For implementation work, use a feature branch and PR to `main`; merge only after required checks are green, then verify the post-merge `main` pipeline. If the merged pipeline fails because of the change, fix it and return `main` to green.

## Baseline analysis

Before editing, inspect the current dependency graph and the current versions of the hotspots below. Reconfirm whether each finding still exists.

Useful checks include:

```sh
npm ci
npm run typecheck
npm run docs:architecture:check
npm test
```

Also inspect imports/usages rather than inferring reachability from filenames. Identify:

- duplicate exported functions with the same responsibility;
- production code that is no longer referenced by runtime entrypoints;
- tests that import a different implementation than production;
- DB row types leaking into API contracts;
- frontend copies of backend DTO types;
- generic crawler/orchestrator code branching on a concrete shop key;
- versioned implementations that form an inheritance/fallback chain;
- large orchestration modules mixing policy, infrastructure, persistence, and domain decisions;
- repeated D1/network/DOM test doubles;
- Playwright tests that can be expressed deterministically below the browser layer.

## Priority order

Apply the work in the following order unless current code inspection shows the dependency has already been removed.

### P0. Consolidate Product Search and remove dead production paths

Start with `src/db/products.ts`, `src/db/product-search-repository.ts`, their callers, and their tests.

Required end state:

- There is exactly one production implementation of product-list search/query behavior.
- `/api/products` tests exercise the same search repository used by the Worker.
- Obsolete `listProducts`/cursor/query implementations are removed rather than left as compatibility copies.
- Tests formerly attached to the obsolete implementation are migrated to the production implementation before deletion.
- Product writes, history reads, and product search are separated when they have distinct responsibilities; use names such as `product-write-repository.ts`, `product-history-repository.ts`, and `product-search-repository.ts` when that matches the current design.
- Extract query parsing/cursor helpers only when doing so removes duplication or makes them independently testable.

Treat a passing test against unreachable production code as a defect, not as useful coverage.

### P0. Establish explicit API contracts separate from persistence rows

Do not let D1 row shapes define public HTTP contracts by structural coincidence.

Required end state:

- Define explicit shared API DTOs/contracts for product lists, product history, metadata, and other cross-runtime payloads that currently have duplicated backend/frontend shapes.
- Map `ProductRow` and other snake_case persistence rows to API/domain DTOs at the repository or HTTP boundary.
- Avoid defining an API item as `Omit<ProductRow, ...>` when that makes schema changes silently alter the API.
- Frontend code consumes the shared contract types instead of maintaining handwritten copies of backend response interfaces.
- Keep runtime validation for HTTP/JSON/localStorage/external inputs. Shared TypeScript types do not validate untrusted data.
- Prefer explicit selected columns or explicit mappers where `SELECT *` would unnecessarily couple the API to future migrations.

The intended direction is:

```text
D1 row -> repository/domain mapper -> API DTO -> frontend
```

not:

```text
D1 row == API DTO == frontend copy
```

### P0. Remove shop-specific logic from generic crawler/orchestration code

This is a prerequisite for Phase 3 Shop Platform work.

Inspect `src/crawler/run.ts`, Worker scheduling/dispatch code, and related modules for concrete shop-key branches such as `adapter.key === "..."`.

Required end state:

- Generic crawler execution does not know individual shop names for diagnostics, pagination, scheduling, parsing, or availability behavior.
- Move shop-specific diagnostics and behavior behind adapter/plugin hooks or declarative adapter metadata.
- Move shop-specific schedule policy to adapter/definition metadata or a dedicated scheduling policy layer instead of adding more shop-name conditionals.
- Keep common steps common: fetch -> parse -> normalize -> classify/enrich -> identity -> persist -> search projection -> evidence/quality.
- Add contract tests that make it difficult for a new shop to require modifying generic crawler logic.

Do not over-generalize a one-off behavior into a complex framework. Add the smallest stable adapter extension point that removes the concrete-shop dependency.

### P1. Replace version-inheritance Knowledge Source Verifiers with composable strategies

Inspect `knowledge-source-verifier.ts` and `knowledge-source-verifier-v*.ts`.

Current-version numbers may intentionally differ from filenames; do not treat that alone as a bug.

Required end state:

- Verification version remains rollout/state metadata, not a class/module inheritance hierarchy.
- Reusable HTML decoding, visible-text extraction, model matching, bounded config parsing, fetch/cache behavior, and source-definition logic live in shared modules rather than being copied between versions.
- Manufacturer-specific discovery/category exceptions live in manufacturer strategies/adapters, not the generic verifier.
- The verifier evaluates ordered `VerificationStrategy`-like components and preserves existing precedence/fallback semantics.
- Add characterization tests before deleting old verifier layers, especially for manufacturer-specific edge cases and fallback ordering.
- Remove old version modules only after all production callers and tests have moved to the composed implementation.

A reasonable shape is:

```text
src/catalog/knowledge-verification/
  verifier.ts
  pipeline.ts
  html.ts
  model-matching.ts
  source-registry.ts
  strategies/
    generic-official-site.ts
    official-index.ts
    direct-product-page.ts
    manufacturer/*.ts
```

Adapt the exact layout to the current code rather than forcing these names.

### P1. Split Knowledge Catalog verification queue orchestration

Inspect `src/knowledge-catalog-verification-queue.ts` and repository collaborators.

Separate pure policy from infrastructure and orchestration. Candidate responsibilities include:

- retry/backoff policy;
- retryability classification;
- verifier construction;
- job processing;
- dispatch;
- finalization;
- queue handler/wiring.

Required end state:

- Pure retry and scheduling policies can be tested without D1, Queue, or fetch fakes.
- Persistence stays in repository modules.
- Queue message handling coordinates operations rather than owning every decision.
- Lease/dead-letter/finalization semantics are covered by behavior tests before restructuring.

### P1. Decompose the frontend by responsibility and move deterministic behavior out of Playwright

Inspect `frontend/app.ts` and related browser entrypoints.

Keep Vanilla TypeScript unless a separate task explicitly approves a frontend framework migration.

Good extraction candidates include:

- API client and response guards;
- shared API contracts;
- application state;
- favorites/localStorage;
- filters and serialization;
- URL state;
- pagination calculation;
- product rendering/view helpers;
- history dialog behavior;
- DOM helpers and bootstrap wiring.

Required end state:

- Pure behavior such as pagination numbers, filter serialization, favorites matching/sorting, activity calculation, and URL-state transformations is unit-testable without a browser.
- DOM/event wiring stays thin and delegates to those functions.
- Avoid introducing a large global state abstraction solely for organization.

### P2. Reduce `src/index.ts` to a composition root

Move HTTP routing, scheduled-event handling, queue routing, and maintenance orchestration into focused modules when those responsibilities are still concentrated in `src/index.ts`.

Target shape conceptually:

```ts
export default {
  fetch: handleHttp,
  scheduled: handleScheduled,
  queue: handleQueue,
};
```

The exact exports must continue to satisfy Cloudflare Workers runtime requirements.

### P2. Improve test architecture

Refactor tests together with production code.

#### D1 fakes

- Keep `QueryableDatabase` narrow.
- Replace repeated hand-written `prepare/bind/all/run/batch` capture fakes with small reusable test helpers where multiple tests have the same plumbing.
- Do not build a giant general-purpose D1 emulator. Prefer behavior-focused helpers such as a statement-capture fake with injectable result selection.

#### SQL tests

- Keep SQL-shape assertions when SQL structure is part of the contract: index usage, bind bounds, ordering, cursor predicates, safety guards, or required joins.
- Do not use regex assertions on internal SQL text as a substitute for domain behavior tests.
- Separate repository SQL-shape tests from higher-level behavior tests so harmless formatting/refactoring does not break unrelated tests.

#### Test pyramid

Follow `docs/testing-strategy.md`:

- pure transformations/decisions -> Node unit tests;
- module/repository/Worker boundaries -> component/contract tests with fakes;
- deployed browser/runtime wiring and a small number of critical user journeys -> Playwright.

Move mocked-API browser tests downward when the browser itself is not required to detect the regression. Keep browser tests for DOM/accessibility/history behavior that genuinely requires a browser.

### P2. Reorganize large type barrels only after implementation boundaries stabilize

Large files such as `src/catalog/types.ts`, `src/db/types.ts`, and `src/crawler/types.ts` may be intentionally leaf-like to avoid dependency cycles.

Do not split them first.

After the production modules have stable bounded contexts, move types with those contexts when doing so preserves one-directional dependencies, for example category, identity, knowledge verification, crawler contracts, or persistence rows.

Keep these principles:

- persistence row types remain snake_case schema mirrors;
- domain/API types remain separate;
- untrusted input types remain permissive enough for runtime narrowing;
- type-only imports must not create architecture cycles.

### P2. Turn dependency-cruiser into an architecture guard

The current acyclic rule is a baseline, not the final architecture policy.

After boundaries are established, encode high-confidence rules in `.dependency-cruiser.json`. Candidate rules include:

- catalog/domain code must not depend on DB infrastructure;
- DB repositories must not depend on crawler orchestration;
- one shop adapter must not import another shop adapter;
- generic crawler code must not import concrete shop modules except through the adapter registry/composition point;
- frontend code must not depend on server persistence modules.

Only enforce rules that reflect the implemented architecture. Do not encode aspirational boundaries that the current design cannot consistently satisfy.

### P3. Tighten TypeScript after structural refactoring

Only after the preceding structural work is stable, evaluate stricter compiler options in a separate focused change. Candidates include:

```json
{
  "noUncheckedIndexedAccess": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true
}
```

Evaluate `exactOptionalPropertyTypes` separately because HiFiScout intentionally distinguishes absent properties from present-but-undefined values in several parsing/normalization paths.

Do not enable a flag and then silence its findings with broad assertions.

## Safe sequencing

For a full Phase 2.6 execution, prefer sequential PRs/workstreams rather than one repository-wide rewrite:

1. product search consolidation + API contracts;
2. crawler/shop boundary cleanup;
3. frontend modularization + test-layer cleanup;
4. knowledge verifier strategy composition;
5. knowledge verification queue split;
6. Worker composition-root cleanup;
7. type relocation after boundaries stabilize;
8. dependency-cruiser rules;
9. stricter TypeScript flags.

If a workstream is already complete, verify and skip it. If two changes are tightly coupled and a separate PR would create a broken intermediate state, keep them together and explain why.

For each workstream:

1. establish characterization/regression coverage for behavior that could be lost;
2. introduce the new boundary alongside the old path when necessary;
3. move production callers;
4. move tests to the production path;
5. delete the obsolete path;
6. run full validation;
7. merge only when green;
8. verify the post-merge `main` pipeline before starting the next high-risk workstream.

## Validation

For JavaScript/TypeScript changes, run all repository-required checks from `AGENTS.md`, including:

```sh
npm run format
npm run format:check
npm run lint
npm test
npm run typecheck
npm run check:no-js-source
npm run docs:architecture:check
npm run build
```

Run relevant focused tests repeatedly while refactoring rather than waiting for the full suite.

When search/persistence behavior changes, also run the local migration/search integration validation required by CI when applicable.

Do not call a workstream complete while its PR checks are red or while the post-merge `main` workflow is failing because of that workstream.

## Completion criteria

Phase 2.6 is complete when all applicable conditions hold:

- product search has one production implementation and tests target it;
- persistence rows no longer implicitly define frontend/API contracts;
- generic crawler/orchestration code contains no avoidable concrete-shop behavior branches;
- Knowledge Source verification is composed from reusable strategies instead of chained version implementations;
- queue orchestration has separated policy, processing, and persistence responsibilities;
- frontend deterministic logic is modular and unit-testable;
- Playwright is limited to behavior that meaningfully requires browser/deployed wiring;
- `src/index.ts` acts primarily as a composition root where practical;
- duplicated test fakes and obsolete test paths are removed;
- type modules reflect stable bounded contexts without introducing cycles;
- dependency-cruiser enforces the high-confidence architecture rules established by the refactor;
- any chosen stricter TypeScript options pass without blanket suppressions;
- all local validation, PR checks, and the post-merge `main` pipeline are green.

## Report

For each completed workstream report:

- branch and commit SHA;
- PR number/URL and merge SHA;
- production modules changed or deleted;
- tests moved/added/deleted and which test layer they now occupy;
- dead/duplicate production paths removed;
- architecture boundaries added or enforced;
- `typecheck`, lint, unit-test, no-JS, architecture, build, and relevant integration results;
- PR check state;
- post-merge `main` pipeline state;
- remaining Phase 2.6 workstreams and any deliberate deferrals.
