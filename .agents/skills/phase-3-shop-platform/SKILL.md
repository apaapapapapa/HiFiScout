---
name: hifiscout-phase-3-shop-platform
description: Project-specific guidance for Phase 3 Shop Platform / Shop Adapter standardization, making shop onboarding declarative and keeping discovery, parsing, availability, transport, quality, identity, persistence, search, and evidence behind stable platform boundaries.
---

# HiFiScout Phase 3: Shop Platform / Shop Adapter Standardization

Use this skill for Phase 3 work that standardizes how HiFiScout integrates shops.

Phase 3 starts after the TypeScript migration and the post-migration architecture cleanup. The objective is not to invent a crawler framework for its own sake. The objective is to make a new shop a bounded plugin implementation instead of another reason to modify generic crawler, scheduling, persistence, quality, identity, search, or evidence code.

The target operating model is:

```text
shop definition
  -> discovery
  -> transport
  -> seller-fact parsing
  -> central normalization
  -> manufacturer/model/category resolution
  -> product identity
  -> persistence
  -> search projection
  -> evidence + data quality
```

A normal new shop should primarily contribute metadata/configuration, discovery rules, parser logic, availability mapping, representative fixtures, and tests.

## Operating rules

- Follow `AGENTS.md` first.
- Work from the current `main`; reconfirm the current adapter contract, registry, generic crawler flow, config, tests, and docs before editing.
- Preserve current externally visible behavior unless the task explicitly changes product semantics.
- Do not weaken robots handling, request pacing, relay/browser security, data-quality checks, evidence capture, identity resolution, runtime validation, TypeScript strictness, or CI to simplify the platform.
- Prefer explicit TypeScript contracts and capability composition over shop-key conditionals.
- Do not introduce a third-party crawler framework unless a separate architectural decision approves it.
- Keep adapters free of D1, R2, FTS/search indexing, product-identity persistence, and cross-shop orchestration.
- Do not make an adapter responsible for canonical catalog policy. It should report seller facts and bounded hints/evidence; shared catalog code owns canonical decisions.
- Do not move all optional behaviors into one ever-growing `ShopAdapter` interface. Model stable universal behavior plus explicit opt-in capabilities when responsibilities differ.
- Migrate existing shops incrementally with characterization tests. Do not rewrite every parser at once.
- For implementation work, use a feature branch and PR to `main`; merge only after required checks are green, then verify the post-merge `main` pipeline. If the merged pipeline fails because of the change, fix it and return `main` to green.

## Current baseline to inspect

At the start of Phase 3, inspect rather than assume the current state of at least:

```text
src/crawler/types.ts
src/crawler/run.ts
src/crawler/dispatch.ts
src/crawler/schedule.ts
src/crawler/fetch.ts
src/crawler/relay.ts
src/crawler/browser.ts
src/crawler/inventory-recheck.ts
src/crawler/normalize.ts
src/crawler/shops/index.ts
src/crawler/shops/*.ts
src/catalog/**
src/db/**
src/data-quality/**
src/evidence/**
scripts/create-shop.ts
docs/adding-shops.md
test/shop-contract.test.ts
test/schedule.test.ts
.dependency-cruiser.json
wrangler.jsonc
```

The repository already has useful platform pieces: `ShopAdapter`, `ShopPlugin`, `ShopDefinition`, a plugin registry, transport kinds, category normalization, inventory recheck capability, a shop generator, centralized persistence, data quality, identity, and evidence. Phase 3 should consolidate these pieces into one coherent extension model rather than replace working abstractions unnecessarily.

## Definition of a shop plugin

A shop plugin describes what is genuinely specific to one seller. Keep that boundary narrow.

A normal plugin may own:

- stable identity: key, display name, canonical base URL;
- operational metadata: enabled/interval/request-delay/max-page configuration and optional dedicated schedule;
- discovery/listing entrypoints and pagination rules;
- parser logic that converts seller HTML into seller facts;
- seller category/manufacturer aliases when they are factual mapping hints;
- seller availability text/status mapping;
- transport selection from supported platform transports;
- optional detail-page category evidence extraction;
- optional inventory-recheck page classification;
- optional diagnostic extraction whose payload is opaque to the platform;
- representative sanitized fixtures and shop-local tests.

A shop plugin must not own:

- D1 schemas or repository queries;
- generic crawl-run lifecycle;
- product identity resolution;
- canonical manufacturer/category policy;
- FTS/search projection;
- R2 evidence retention policy;
- global quality metric definitions;
- generic retry/lease/queue policy;
- HTTP API behavior;
- UI behavior;
- conditional behavior for another shop.

## Stable contract and capabilities

### Universal contract

Keep the universal adapter contract small. Every registered shop should provide the minimum needed for the platform to run it, conceptually:

```ts
interface ShopPlugin {
  definition: ShopDefinition;
  discover(context: DiscoveryContext): Iterable<CrawlTarget> | AsyncIterable<CrawlTarget>;
  parse(input: ParseInput): SellerProduct[];
}
```

Do not force these exact names if current code has a cleaner migration path, but maintain the responsibility split.

The universal contract should answer only:

1. what shop is this;
2. what targets should be crawled;
3. what seller facts were found.

Everything else should either be platform behavior or a named capability.

### Capability composition

Prefer explicit optional capabilities such as:

```text
DynamicPaginationCapability
DetailCategoryEvidenceCapability
InventoryRecheckCapability
PageDiagnosticsCapability
CustomScheduleCapability
PartialCoverageCapability
```

A capability should exist because the platform has a distinct lifecycle step, not because one shop has a uniquely named flag.

Avoid boolean/config proliferation such as adding a new generic property whenever a parser needs a one-off workaround. If two options jointly describe a stable policy, model the policy as a typed object with clear semantics.

## Discovery and pagination

Standardize discovery independently from parsing.

Required end state:

- A crawl target has a stable URL and may carry typed shop-local context required by parsing.
- Generic crawler code does not know whether a target came from a fixed listing, numbered pagination, cursor-like pagination, category list, feed, or dynamic discovery.
- Pagination continuation is expressed through the discovery/pagination capability, not through shop-key branches in `run.ts`.
- Coverage must be explicit. Distinguish complete coverage, partial coverage, and unknown coverage because deactivation semantics depend on it.
- Dynamic discovery must have platform-enforced bounds so a broken parser cannot create an unbounded crawl.
- Duplicate target suppression belongs to the platform.
- URL validation must keep targets on the shop's allowed origin/path policy unless a capability explicitly permits otherwise.

Do not make `parse()` secretly mutate a global queue or fetch the next page itself.

## Transport

Treat HTTP acquisition as a platform service.

Supported transport strategies may remain `direct`, `relay`, and `browser` unless current requirements justify another stable strategy.

Required end state:

- adapters select a transport/capability declaratively;
- generic transport code owns robots checks, user agent, timeout, pacing, response-size limits, retryable transport failures, and secret/config validation;
- relay authentication and browser bindings do not leak into parsers;
- a shop cannot bypass pacing by creating its own unbounded fetch loop inside parser/discovery code;
- transport failures are represented distinctly from parse-empty and coverage-empty outcomes;
- transport observability attributes the failure to the shop and target without teaching transport code shop names.

A specialized upstream service such as the Audio Union relay/Lambda may remain, but the crawler must consume it through a general transport boundary rather than a concrete-shop branch.

## Seller-fact parsing and central normalization

Parser output should contain seller facts, not persistence rows and not final cross-shop identity.

Prefer a dedicated `SellerProduct` / `ParsedListing` type that contains fields such as:

```text
sourceId
sourceUrl
title
rawManufacturer
manufacturer hint
model hint
rawCategory
category hint
conditionText
priceYen
availability evidence/status
shop-specific factual metadata
```

Required end state:

- every shop parser produces the same seller-fact contract;
- central normalization owns whitespace/currency/common text cleanup that is not seller-specific;
- canonical manufacturer/category resolution stays shared;
- product identity resolution happens after normalization, never inside a shop parser;
- parser output cannot accidentally include D1 row-only fields;
- shop metadata remains bounded factual JSON and does not become a dumping ground for duplicated editorial content.

Keep raw seller values when they are useful evidence. Do not erase the original category/manufacturer text after mapping it to a canonical value.

## Availability standardization

Availability is shop-specific evidence with a shared canonical outcome.

Required end state:

- define one canonical availability vocabulary used by persistence/search/filtering;
- each shop maps its seller-specific labels/markup to that vocabulary at the adapter boundary;
- ambiguous or contradictory seller evidence must remain distinguishable from confirmed in-stock/out-of-stock states;
- rules such as “商談中 counts as available” or “absence of 売り切れ means available” belong to that shop's availability mapping/tests, not generic crawler code;
- listing availability and optional detail-page recheck use compatible canonical outcomes;
- generic inventory recheck owns candidate selection, timing, retry/failure accounting, and deactivation; the shop supplies only URL validation and page classification when needed.

Do not infer `in_stock` from parse success alone.

## Configuration and scheduling

Shop operational configuration should be declarative and colocated with the shop definition.

Required end state:

- adding a normal shop does not require editing a hand-maintained union of environment-variable names in generic type code;
- generated Worker environment types remain the source of truth where possible;
- shop config parsing validates positive intervals, delays, page limits, and required transport configuration centrally;
- dedicated cron schedules are metadata/policy, not `if (shopKey === ...)` branches;
- shared due-shop dispatch remains generic;
- `wrangler.jsonc`, schedule metadata, and tests cannot silently drift apart.

Prefer deriving env names from the shop definition or a typed config object over duplicating the same key in multiple files.

## Registry and composition root

The registry should be the only deliberate place where concrete shop modules are composed into the runtime.

Required end state:

- one canonical registry exists;
- remove compatibility aliases such as `SHOP_ADAPTERS` after callers migrate to the canonical registry;
- generic crawler modules import platform contracts/registry APIs, not individual shop modules;
- one shop module never imports another shop module;
- the registry validates duplicate keys and invalid definitions at startup/test time;
- plugin definitions are immutable after registration;
- normalization wrapping or other universal decoration happens once at registration/platform composition, not independently in each adapter.

Do not turn the registry into a large switch statement.

## Common crawl pipeline

A successful Phase 3 architecture should make the common sequence visible in code and tests:

```text
resolve plugin/config
  -> discover bounded targets
  -> fetch through platform transport
  -> parse seller facts
  -> normalize catalog fields
  -> classify/enrich manufacturer/model/category
  -> resolve product identity
  -> persist product/history
  -> update search projection
  -> store evidence
  -> evaluate data quality
  -> finalize crawl state / coverage / recheck
```

The exact order may differ where current invariants require it. Preserve transactional and deactivation semantics. The key requirement is that a shop cannot silently replace one of these shared stages with its own copy.

## Data quality, evidence, and observability

Phase 3 must preserve the Phase 2 standard: “the crawler ran” is not the success criterion; correct data is.

Required end state:

- common metrics remain comparable across shops;
- per-shop threshold overrides are configuration, not duplicated evaluator implementations;
- parse failure, zero results, abnormal item-count change, unknown availability, manufacturer/category/identity gaps, and insufficient evidence remain observable;
- shop diagnostics may enrich a crawl-run message but remain opaque to generic orchestration;
- evidence capture uses the common archive policy and cannot be disabled ad hoc by a parser;
- partial/unknown coverage is propagated into deactivation and quality decisions correctly.

If a new shop requires a new quality concept that applies to all shops, add it to the platform. If it is merely explanatory seller-specific context, keep it as diagnostic metadata.

## Shop generator

`scripts/create-shop.ts` should become the supported happy path for adding shops.

By Phase 3 completion, generating a normal shop should create or update everything mechanically required for registration without leaving hidden manual type/config work.

A generated shop should include:

- typed shop definition/plugin skeleton;
- selected transport;
- discovery/parser placeholders;
- availability mapping placeholder when appropriate;
- sanitized fixture location;
- contract/unit test skeleton;
- registry registration through the supported mechanism;
- configuration declaration/defaults through the supported mechanism.

The generator must never silently enable an empty parser in production.

Keep `docs/adding-shops.md` aligned with the generated code. Documentation examples must use current TypeScript/source conventions.

## Testing strategy

### Platform contract tests

Create tests that run against every registered shop and verify invariants such as:

- unique non-empty key and display name;
- valid base URL;
- valid operational config/default bounds;
- transport is supported and configured consistently;
- discovery targets are valid/bounded;
- parser returns the shared seller-fact shape;
- canonical normalization runs through the platform boundary;
- no plugin can mutate frozen definition metadata;
- coverage/deactivation semantics are explicit;
- optional capabilities satisfy their capability contract.

### Shop tests

Each shop should have representative sanitized fixtures covering its meaningful variants:

- normal listing;
- sold/out-of-stock/negotiating/unknown availability where applicable;
- pagination termination or discovery variants;
- malformed/empty page behavior;
- seller category/manufacturer normalization evidence;
- any detail-page inventory/category capability.

Test seller-specific rules at the shop boundary. Do not require a browser test to prove a pure HTML parser rule.

### Platform tests

Test generic lifecycle behavior once with synthetic plugins rather than repeating it for every real shop. Cover:

- complete vs partial vs unknown coverage;
- dynamic pagination bounds and deduplication;
- transport failure vs empty parse;
- normalization before identity/persistence;
- quality/evidence hooks;
- configuration and scheduling;
- inventory recheck lifecycle.

Use Playwright only for deployed/browser behavior that cannot be validated below the browser layer.

## Architecture enforcement

After the boundaries exist, encode them in dependency-cruiser or focused static checks.

High-value rules include:

- generic crawler/platform modules may not import concrete `shops/*` modules except the registry/composition root;
- one concrete shop may not import another concrete shop;
- shop modules may not import DB repositories, search projection, evidence persistence, or HTTP API modules;
- frontend may not import shop parser implementations;
- catalog/domain code must not import concrete shops;
- shop-specific keys must not appear in generic orchestration conditionals.

Avoid brittle text scans where dependency rules or typed contracts can express the invariant more accurately.

## Migration sequence

Use an incremental migration. A recommended order is:

1. Characterize the current seven-shop behavior and generic lifecycle before structural changes.
2. Define the target seller-fact, plugin-definition, discovery, transport, availability, coverage, and capability contracts.
3. Make the registry/composition root canonical and remove concrete-shop imports from generic orchestration.
4. Standardize configuration/scheduling so shop onboarding is definition-driven.
5. Standardize discovery/pagination and coverage semantics.
6. Standardize parser output and central normalization boundary.
7. Standardize availability and inventory-recheck capabilities.
8. Move diagnostics/quality overrides to explicit capability/config boundaries.
9. Migrate existing shops one at a time, keeping behavior tests green after each shop.
10. Upgrade `create-shop` and `docs/adding-shops.md` to the final contract.
11. Remove compatibility aliases, obsolete flags, duplicated helpers, and dead code only after all callers/tests use the platform path.
12. Add architecture guards and a generator smoke test so the design does not regress.

When choosing migration order, use representative complexity rather than filename order: migrate one simple direct shop first, then one dynamic-pagination shop, one relay shop, one browser shop if currently used, and one shop with inventory/detail capabilities. This proves the contract before migrating every adapter.

## Phase 3 completion criteria

Phase 3 is complete only when all of the following are true:

- There is one canonical shop-plugin/platform contract and registry.
- Every existing shop runs through the same generic crawl lifecycle.
- Generic orchestration contains no concrete-shop behavior branches.
- A normal new shop does not require edits to `run.ts`, `dispatch.ts`, persistence, identity, search, evidence, or data-quality implementations.
- Shop-specific code is substantially limited to definition/config metadata, discovery/pagination, parser/availability logic, optional declared capabilities, fixtures, and tests.
- Direct/relay/browser acquisition is handled behind shared transport interfaces.
- Coverage semantics prevent accidental deactivation when a shop provides partial or unknown inventory coverage.
- Canonical catalog normalization, product identity, persistence, search projection, evidence, and data quality remain centralized.
- Shop environment/config registration no longer requires duplicating names across unrelated generic type unions.
- `create-shop` produces a valid TypeScript scaffold for the final contract and does not leave undocumented registration steps.
- `docs/adding-shops.md` matches the final implementation.
- Architecture guards prevent concrete shops from leaking back into generic modules.
- Existing shop behavior is protected by fixture/contract tests.
- All required repository validation and CI checks pass.

## Validation

Before publishing implementation changes, run the checks required by `AGENTS.md`, plus Phase 3 architecture checks relevant to the change. The expected baseline set is:

```sh
npm ci
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run check:no-js-source
npm run docs:architecture:check
npm test
npm run build
```

Run focused shop/contract tests during migration, but do not substitute them for the full suite before merge.

For changes affecting deployed crawling, also verify the relevant GitHub Actions workflows and the post-merge `main` pipeline. A merged commit with a failed crawl/deploy pipeline is not a completed Phase 3 change.
