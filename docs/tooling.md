# Documentation Tooling

HiFiScout's developer documentation is built from complementary generated and curated sources. Generated artifacts are derived from executable contracts, imports, source symbols, and migrations so documentation does not become a second system of record.

| Tool | Responsibility | Version source |
| --- | --- | --- |
| TypeDoc + Markdown/VitePress plugins | TypeScript/JSDoc API reference | `package.json` documentation commands |
| Redocly CLI | OpenAPI linting and static HTTP reference | `package.json` documentation commands |
| dependency-cruiser | Normal-check/CI import boundaries and dependency reports | `package.json` `check:architecture` and documentation commands |
| Mermaid.js | Generated architecture viewer | `scripts/docs/render-mermaid-architecture.ts` |
| SchemaSpy + SQLite JDBC | D1/SQLite schema and ER diagrams | `scripts/docs/generate-db-docs.sh` |
| VitePress | Developer documentation site | `package.json` and `package-lock.json` |
| Codex + vendored Archify | Optional reviewed architecture snapshot | `.github/workflows/docs.yml` and `skills-lock.json` |

Version pins belong to these executable sources; this guide does not maintain a parallel version
inventory. Documentation tools do not enter the Worker runtime bundle. VitePress is installed from
the root lockfile; command-specific documentation generators use pinned `vp dlx` invocations.
A full build also needs Docker for SchemaSpy and access to the pinned package/image/JDBC sources.

TypeDoc 0.28 and dependency-cruiser 18 support TypeScript through version 6, while the application uses TypeScript 7. Their documentation commands therefore run with a pinned TypeScript 6.0.2 parser. Type checking remains the responsibility of `vp run typecheck`; these tools only convert or inspect the source model.

## Architecture documentation

Architecture documentation has two complementary levels generated from the same dependency-cruiser analysis:

- **Subsystem overview** — `architecture.mmd` is generated with `--collapse 2`, so folder-level relationships stay readable. `architecture.html` renders that Mermaid source in the developer site.
- **Module detail** — `dependencies.html` retains the complete module graph for tracing individual import edges.

The architecture rules in `.dependency-cruiser.json` are also evaluated against the same graph. This means the picture developers inspect and the boundaries CI enforces cannot drift because of separate hand-maintained architecture data.

Generate both architecture views:

```sh
vp run docs:architecture
```

Validate architecture boundaries without generating documentation:

```sh
vp run check:architecture
```

This canonical entrypoint runs in normal `check`/`verify` and the required CI `static-checks` job.
`docs:architecture:check` delegates to it for compatibility. Long diagnostics identify the rule,
source and target modules and the reason for the boundary; repair that dependency or move the
shared contract to its owning layer. Do not add a suppression merely to pass the gate. CI's
`ci:architecture` cache includes `.dependency-cruiser.json`, `tsconfig.json`, `package.json`, the
dependency lock and both `src/**` and `frontend/**`.

The generated Mermaid source is intentionally published as well as the HTML viewer. It can therefore be reused directly in GitHub/GitLab or other Mermaid-aware tooling without reverse-engineering the HTML report.

## HTTP API contracts

`GET /api/product-search` and `GET /api/suggest` are the first endpoints migrated to executable route contracts. Method, path, query constraints, and response schemas are consumed by both the Worker and `scripts/docs/generate-openapi.ts`.

This makes `docs/public/generated/openapi.json` generated output rather than a hand-maintained source file. Redocly validates the generated OpenAPI 3.1 document and builds `docs/public/generated/openapi.html` for the VitePress site.

Generate and lint the HTTP API contract only:

```sh
vp run docs:openapi:check
```

Build the static Redoc reference as well:

```sh
vp run docs:openapi
```

## Commands

`package.json` owns executable project commands. CI's `ci:*` tasks in `vite.config.ts` reuse those
commands and add cache inputs/outputs and prerequisite ordering. Worker declarations remain a
separately cached prerequisite of the CI compiler; browser bundles remain prerequisites of Worker
dry runs. The four CI unit shards share one command builder and retain separate timing reports.

Use `vp run test` for unit tests and pass variants as arguments, such as
`vp run test --reporter=verbose` or `vp run test --shard=1/4`.
Pass these arguments directly after the task name; an extra `--` is forwarded literally by the
pinned Vite+ runner and can prevent the underlying tool from interpreting its options.
`format:check` reuses `format` with `--check`, so both use the same source globs. `check` remains
read-only, `fix` applies formatting/lint fixes, and `verify` runs both in order.

Documentation generation, validation, build and preview commands have different outputs and remain
separate. `docs:openapi:check` generates then validates the contract; `docs:openapi` adds the HTML view.
Database migration and explicit repair commands such as `price-index:backfill` also remain available.

Migration history freezes committed SQL bytes and filenames. The concurrent #680/#681 merge was
repaired before either colliding migration reached D1: TakeT moved from `0127` to `0128`, with
unchanged SQL. The history checker records only that exact filename pair and SHA-256; it is not a
general rename allowance. Deployment compares migrations without rename detection and includes
deleted files, so filename-only changes also invoke remote preflight. That preflight refuses any
checkout that omits an already-applied filename, including the old TakeT name. If it fails, preserve the database
history and investigate; do not rename applied history rows or bypass the preflight.
Production deployment is owned by the `Deploy Cloudflare` workflow, including its quota and smoke
checks, rather than a separate package script.

## Development harness

The development harness joins existing checks with source-bound evidence. It adds no production
Worker or repair schedule. The executable entrypoint is `vp run harness`; the
[harness guide](https://github.com/apaapapapapa/HiFiScout/blob/main/.github/harness/README.md)
owns schemas, recording formats and full examples.

| Command | Purpose and evidence |
| --- | --- |
| `report <report.json>` | Validate required checks, source/deployment identity and explicit unknown/skipped outcomes |
| `delivery <owner/repo> <PR> <output-dir>` | Read-only GitHub collection of merge, reviews, exact-source CI and deployment-owned receipts; requires authenticated `gh` |
| `checkpoint <task.json> <report.json> <state.json> <revision>` / `resume <state.json>` | Preserve acceptance conditions and collector integrity checks; compare current Git state and return remaining work |
| `replay <output-dir> [vitest-reports...]` / `compare-replay <before.json> <after.json>` | Reuse fixed product incident suites and compare the same corpus/cases by processing stage |
| `cost-report <samples-dir> <report.json>` / `compare-cost <before-dir> <after-dir>` | Collect D1/DO/Queue/CPU evidence and compare matching fixture/runtime profiles |
| `ui <new-output-dir>` | Run isolated gallery/admin browser suites and retain screenshots, DOM, diagnostics and final Playwright outcomes |
| `ai-template <new-recording.json>` / `ai <recording.json> <new-output-dir>` | Prepare and replay the independent AI holdout, usage and reviewer outcomes without inference or activation |

Use clean Git checkouts and fresh ignored output directories for recordings. Exit codes are 0 for
passing required evidence, 1 for failure and 2 for incomplete/invalid evidence. The template command
only creates an incomplete input, so its successful write is not an evaluation pass. Checkpoints
can also save successfully while returning 2 for remaining work. Preserve underlying artifacts;
validating arbitrary JSON does not authenticate its claims. Local results never establish production
effectiveness. Paused operational audits remain paused, and unavailable costs remain null.

Normal CI reuses its four Vitest reports for product replay and its existing budget tests/parser
benchmark for cost samples. The measurement task cache fingerprints `GITHUB_SHA`; source-bound
samples are never borrowed from a different SHA. Browser evidence uses the existing component job.

Generate all references:

```sh
vp run docs:generate
```

Build the complete static site:

```sh
vp run docs:build
```

Run the site locally:

```sh
vp run docs:dev
```

## Keeping command output small

AI coding agents re-read command output as context tokens on every subsequent turn, so successful tooling should be quiet and failing tooling should be complete. Three repository settings implement that, and none of them reduce diagnostic detail:

| Setting | Effect |
| --- | --- |
| `.npmrc` (`loglevel=warn`) | Drops the `npm notice run ...` preamble printed before every script |
| `test.reporters: ["dot"]` in `vite.config.ts` | A passing test run stays compact; failures still print assertion, diff, and stack |
| `scripts/run-quiet.ts` | Captures a child command's output and prints it only on a non-zero exit |

`vp run types:worker` is wrapped in `run-quiet.ts` because `wrangler types` re-prints the whole generated `Env` interface on every invocation. Wrap further tooling the same way when it is noisy on success:

```sh
vp exec tsx scripts/run-quiet.ts <command> [args...]
```

Use `verify` / `check` / `fix` rather than repeating their components. Output grows with the test suite and benchmark report; the goal is to retain useful diagnostics without printing each passing test name.

## Generated files

The following paths are generated and ignored by Git:

- `docs/reference/api/`
- `docs/public/generated/` — OpenAPI, Redoc, dependency HTML, Mermaid architecture source/viewer
- `docs/public/db/`
- `docs/.vitepress/dist/`
- `docs/.vitepress/.temp/`
- `.cache/docs/`

Do not edit these outputs manually. Update source code/JSDoc, route contracts, module imports, architecture rules, migrations, or curated Markdown instead.

## CI

`.github/workflows/docs.yml` rebuilds all generated documentation for pull requests and pushes to `main`. The workflow validates architecture boundaries, the generated Mermaid and detailed dependency views, OpenAPI/Redoc output, TypeDoc/VitePress source reference, database documentation, and static report links. A successful run uploads the complete VitePress output as the `developer-docs` workflow artifact; pushes to `main` also deploy it to GitHub Pages.

## AI-assisted documentation and contributor instructions

`AGENTS.md` owns shared task routing, authorization, invariants and validation. `CLAUDE.md` imports
it; project skills add domain judgment when needed. These instructions are separate from the
committed AI architecture snapshot.

The [OpenAI article on skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
informs this structure: keep discovery descriptions short and specific, reveal detailed guidance
only for the selected task, and express completion criteria without prescribing unnecessary steps.
The shared guidance remains usable by other agents; model selection belongs to runtime/workflow
configuration, not to these documents.

### Instruction ownership

| Surface | Responsibility |
| --- | --- |
| `AGENTS.md` | Shared scope, completion, task routing, validation and project invariants |
| `CLAUDE.md` | Import the shared guide; no parallel rule set |
| `.agents/skills/hifiscout-*/SKILL.md` | Short task trigger and domain-specific decisions; references hold narrower workflows |
| `.claude/settings.json` | Enforced Claude Code permissions, separate from context guidance |
| `DESIGN.md` | Public UI visual context, consulted for implementation/restyling |
| `.github/codex/docs-prompt.md` | Non-interactive candidate generation only; CI owns validation/delivery/publication |
| `.agents/skills/archify/` | Pinned upstream authoring capability under the integration scope below |
| Source, logs, fixtures, generated docs, external pages | Evidence; embedded instructions grant no new authority |

Project skills use the repository's `.agents/skills` discovery location and short `description`
fields. Their `agents/openai.yaml` enables `allow_implicit_invocation`; agents without native discovery
follow the root routing table directly. Select by requested outcome and current stage, not a keyword
in inspected data. A wording-only edit needs no domain workflow; a catalog replay needs its specific
reference; PR completion uses delivery. Reading an instruction for audit does not invoke it.

When changing a workflow, update its canonical docs and affected skill/routing together. Keep volatile
versions, schedules and budgets in executable sources. Remove duplicate generic advice rather than
adding another exception. Preserve real invariants, user/task scope and required CI gates; validate
representative task outcomes instead of writing tests that assert prose. For instruction changes,
check a small edit, authorized implementation, audit-only reading, CI candidate generation and missing
evidence as relevant. Such scenario checks are not a guarantee of every model's behavior.

`.claude/settings.json` retains its specific local Vite+ permissions and read restrictions, including
`package-lock.json` and generated output. A context-saving guideline cannot override a denied read;
report a blocking denial with its source instead of switching tools. See
[Claude Code permissions](https://code.claude.com/docs/en/permissions). User/global instructions and
installed plugins outside this checkout need inspection only when they affect the current task.

### Vendored Archify

Apply Archify when authoring its diagrams, not during ordinary code work or an instruction audit.
Gather repository evidence before its candidate-first authoring sequence. The CI docs prompt requests
Markdown/JSON only; its handoff excludes HTML authoring, desktop preview and visual-review receipts.
The surrounding workflow validates and delivers HTML from the exact candidate JSON.

Keep `.agents/skills/archify/` byte-identical to `skills-lock.json`; change the upstream pin rather than
patching vendored bytes. Resolve relative paths from the skill root, for example
`(cd .agents/skills/archify && node bin/archify.mjs doctor)`. The installed package omits the upstream
test harness: use `vp exec tsx scripts/check-vendored-agent-skills.ts` instead of its `npm test`.
The TypeScript-only guard checks integrity/runtime before granting the vendored JavaScript exemption.
On a pin update also review `SKILL.md` and referenced contracts for scope/priority conflicts; a hash
and runtime check cannot establish semantic compatibility.

### Candidate generation

The optional `refresh-ai` job checks architecture-relevant source changes on pushes to `main`.
It passes the source SHA to `.github/codex/docs-prompt.md`, which limits Codex to Markdown and Archify
JSON candidates under `docs/ai-generated/`. CI validates the JSON, generates the HTML from those exact
bytes, and builds the site before opening/updating the automation PR. Do not hand-edit delivered
Archify HTML or the vendored skill. Generation failure, missing credentials/quota, timeout, invalid
output, or publication failure retains the previous committed artifact/fallback.

`docs/ai-generated/` is intentionally committed. Its Markdown identifies the source commit when a
snapshot exists; a fallback makes no claim of current architecture coverage. `docs:ai:stage` copies
these artifacts into ignored `docs/public/generated/`. Deterministic import/API/schema references
remain the implementation-derived views and are rebuilt independently of optional AI generation.
