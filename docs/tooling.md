# Documentation Tooling

HiFiScout's developer documentation is built from five complementary OSS toolchains.

| Tool | Responsibility | Pinned version |
| --- | --- | --- |
| TypeDoc + typedoc-plugin-markdown + typedoc-vitepress-theme | TypeScript/JSDoc source API reference for VitePress | 0.28.20 / 4.12.0 / 1.1.3 |
| Redocly CLI | OpenAPI 3.1 linting and static HTTP API reference | 2.47.0 |
| dependency-cruiser | Module dependency validation and visualization | 18.1.0 |
| SchemaSpy | D1/SQLite schema documentation and ER diagrams | 7.0.2 |
| VitePress | Unified static developer documentation site | 1.6.4 |

The command-line tools are version-pinned and invoked only by documentation scripts, so they do not
become part of the Cloudflare Worker runtime bundle.

TypeDoc, typedoc-plugin-markdown, typedoc-vitepress-theme, Redocly CLI, dependency-cruiser, and
SchemaSpy are pinned at their invocation site. VitePress is pinned by `package-lock.json` and run
from `node_modules` instead of being re-downloaded on every `docs:build`, `docs:dev`, and
`docs:preview`.

TypeDoc 0.28 and dependency-cruiser 18 support TypeScript through version 6, while the application
uses TypeScript 7. Their documentation commands therefore run with a pinned TypeScript 6.0.2
parser. Type checking remains the responsibility of `vp run typecheck`; these tools only convert or
inspect the source model.

## HTTP API contracts

`GET /api/product-search` and `GET /api/suggest` are the first endpoints migrated to executable route
contracts. Method, path, query constraints, and response schemas are consumed by both the Worker and
`scripts/docs/generate-openapi.ts`.

This makes `docs/public/generated/openapi.json` generated output rather than a hand-maintained source
file. Redocly validates the generated OpenAPI 3.1 document and builds
`docs/public/generated/openapi.html` for the VitePress site.

Generate and lint the HTTP API contract only:

```sh
vp run docs:openapi:check
```

Build the static Redoc reference as well:

```sh
vp run docs:openapi
```

## Commands

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

Validate source dependency rules without building documentation:

```sh
vp run docs:architecture:check
```

## Keeping command output small

AI coding agents re-read command output as context tokens on every subsequent turn, so successful
tooling should be quiet and failing tooling should be complete. Three repository settings implement
that, and none of them reduce diagnostic detail:

| Setting | Effect |
| --- | --- |
| `.npmrc` (`loglevel=warn`) | Drops the `npm notice run ...` preamble printed before every script |
| `--test-reporter=dot` in `test:unit` | A passing test run stays compact; failures still print assertion, diff, and stack |
| `scripts/run-quiet.ts` | Captures a child command's output and prints it only on a non-zero exit |

`vp run types:worker` is wrapped in `run-quiet.ts` because `wrangler types` re-prints the whole
generated `Env` interface on every invocation. Wrap further tooling the same way when it is noisy
on success:

```sh
tsx scripts/run-quiet.ts <command> [args...]
```

Together with the `verify` / `check` / `fix` aggregate scripts, a full green pre-commit run prints
well under a kilobyte.

## Generated files

The following paths are generated and ignored by Git:

- `docs/reference/api/`
- `docs/public/generated/`
- `docs/public/db/`
- `docs/.vitepress/dist/`
- `docs/.vitepress/.temp/`
- `.cache/docs/`

Do not edit these outputs manually. Update source code/JSDoc, route contracts, module imports,
migrations, or curated Markdown instead.

## CI

`.github/workflows/docs.yml` rebuilds all generated documentation for pull requests and pushes to
`main`. The workflow validates the module dependency graph, OpenAPI/Redoc output, TypeDoc/VitePress
source reference, and static report links. A successful run uploads the complete VitePress output as
the `developer-docs` workflow artifact.
