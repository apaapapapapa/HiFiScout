# Repository instructions for AI coding agents

HiFiScout is a TypeScript/React application on Cloudflare Workers + D1. Per-shop `CrawlScheduler`
Durable Objects own crawling; Queues serve Knowledge Catalog verification and asynchronous exports.

## Sources of truth and task map

Read current code and configuration before changing behavior. Historical issues, migration comments,
and AI-generated snapshots describe the revision at which they were written, not necessarily `main`.
Start with the relevant row rather than loading every document.

| Task | Entry points |
| --- | --- |
| Runtime and bindings | `src/worker.ts`, `src/index.ts`, `wrangler.jsonc`, `wrangler.admin.jsonc` |
| Crawl scheduling, recovery, pacing | `docs/crawl-orchestration.md`, `src/scheduled.ts`, `src/crawler/crawl-scheduler-do.ts` |
| Shop adapter | `docs/adding-shops.md`, `src/crawler/shops/index.ts`, nearby adapter and tests |
| Search, grouping, price index, D1 cost | `docs/data-platform-architecture.md`, `src/db/product-search-price-index-repository.ts`, `src/db/product-search-exact-identity.ts` |
| Classification, identity, remediation | `docs/data-quality.md`, `docs/data-quality-remediation.md`, `src/catalog/resolution-versions.ts` |
| Public UI | `DESIGN.md`, `frontend/app.tsx`, `frontend/public-app.tsx`, `frontend/public-components.tsx` |
| Admin UI, authentication, RPC | `docs/listing-admin.md`, `src/admin/entry.ts`, `src/admin/access.ts`, `src/admin/contracts.ts`, `frontend/admin-console.tsx` |
| Schema | Ordered `migrations/*.sql`; add a migration, never edit one already applied |
| Test placement and performance coverage | `docs/testing-strategy.md`, `test/`, `e2e/` |
| CI, deployment, operational checks | `.github/workflows/README.md` and the responsible workflow/scripts |
| Documentation | `docs/index.md`, `docs/tooling.md`, `docs/.vitepress/config.mts` |

## Validation

Use the project-pinned Vite+ toolchain. Versions and commands are defined in `package.json`,
`package-lock.json`, and `vite.config.ts`; do not introduce a second package manager or lockfile.

| Task | Command |
| --- | --- |
| Install locked dependencies | `vp install --frozen-lockfile` |
| Required before committing TypeScript/source/config changes | `vp run verify` |
| Read-only gate | `vp run check` |
| Format/lint fixes only | `vp run fix` |
| One unit-test file | `vp test run test/<name>.test.ts` |
| Verbose unit tests when diagnosing | `vp run test:unit:verbose` |
| Local development | `vp run db:migrate:local`, then `vp run dev` |
| Documentation changes | `vp run docs:build` |

`verify` applies format/lint fixes, then runs lint, format checking, the TypeScript-only source guard,
type checking, the parser performance benchmark, and unit tests. Run this aggregate once after the
change instead of repeating its component checks. Inspect and include formatter changes before
committing; CI autofix is a fallback, not a substitute. Run additional build/integration/browser
checks when the changed boundary needs them; documentation-only changes need the documentation
build rather than new application tests. Report any check that could not run.

## Architectural invariants

- Keep first-party application, test, script, infrastructure, and tooling source TypeScript-only.
  Do not commit `.js`, `.mjs`, `.cjs`, or `.jsx` source/config. Keep strict typing and runtime
  validation at external boundaries; see `docs/typescript.md`.
- Crawl dispatch tokens fence one logical generation. Recovery re-delivers the same token to the
  per-shop DO. Seller pacing uses PREPARE / Alarm / FETCH; do not restore crawl Queue lanes, a
  second D1 execution lease, or sleep-based pacing.
- Keep work proportional to changed listings, dirty identities, or bounded current work. Preserve
  durable cursors, idempotency, and budget-aware finalization. Public metadata and price summaries
  read persisted projections; do not move full-catalog/history aggregation into request paths.
- Evaluate D1 changes with `rows_read`, `rows_written`, statement count, and query plans. A small
  result or fewer binding calls does not prove fewer billed rows; local SQLite is not a billing or
  Workers CPU measurement. Preserve same-value write guards, decision timestamps, and filtered
  INSERTs that avoid AUTOINCREMENT writes; use the existing Miniflare D1 write-budget tests.
- Verified catalog matches and guarded exact-identity fallback grouping are distinct paths. Never
  merge fuzzy/candidate models or discard revision/accessory evidence to improve grouping counts.
- Taxonomy v3 separates product categories, facets, and capabilities. `unclassified` is the internal
  sentinel; old `other` and legacy category IDs are compatibility inputs, not new canonical output.
- Preserve raw seller evidence and explicit admin overrides. Do not republish seller images,
  descriptions, comments, or logos.
- Public `/api/admin/*` routes return 404. The separate Access-protected admin Worker uses the
  `CatalogAdminService` Service Binding; internal legacy router handlers do not imply public access.
- Read `DESIGN.md` before implementing or substantially restyling public UI. Preserve usability and
  accessibility when a visual reference conflicts with them, and explain non-obvious deviations.

## Context and documentation discipline

- Use `rg` to locate symbols and read relevant sections of large files. Start review with
  `git diff --stat`, then inspect affected paths. Read failed CI jobs instead of full successful logs.
- Generated `dist/`, `.generated/`, browser bundles, `docs/public/`, and `docs/reference/api/` are not
  implementation sources. Read the lockfile only for dependency/version work; it is authoritative
  for the resolved dependency graph, not application behavior.
- Do not run documentation generators merely to understand code. Run them to validate a docs
  change. Distinguish deterministic generated references from committed AI snapshots and their
  source-commit metadata.
- Update canonical docs with a behavior change. Link to current sources for shop inventories,
  schedules, configuration, schema, and tool versions instead of copying evolving lists or values.
- Replace completed migration plans and dated operational snapshots with durable invariants and
  maintained runbooks. Git history is the archive. Verify recurring responsibilities before removing
  operational automation; a documentation cleanup alone does not authorize removing runtime paths.
- Successful tooling should be concise and failures diagnostic. For noisy new tooling, use
  `vp exec tsx scripts/run-quiet.ts <command> [args...]` when appropriate.

## Vendored Archify

Keep `.agents/skills/archify/` byte-identical to `skills-lock.json`; update the upstream pin rather
than patching vendored files. Resolve its `SKILL.md` paths from `.agents/skills/archify`, for example
`(cd .agents/skills/archify && node bin/archify.mjs doctor)`. The installed artifact excludes the
upstream repository test harness, so use `vp exec tsx scripts/check-vendored-agent-skills.ts` rather
than its `npm test`. The TypeScript-only source guard verifies integrity and runtime before granting
the vendored JavaScript exemption.

## Delivery

For ordinary implementation requests, create a PR to `main`, address review comments, merge after
required checks pass, and verify the resulting pipelines. Follow an explicit task-specific scope
when it limits publication (for example, the CI documentation generator only authors candidates).
Do not equate a green deploy job with a new deployment: confirm its `deployment-identity` artifact,
then inspect downstream checks for that deployed SHA. A quota-deferred/no-op deployment leaves
the previous production version in place; report that state accurately.
