# Documentation Tooling

HiFiScout's developer documentation is built from four complementary OSS toolchains.

| Tool | Responsibility | Pinned version |
| --- | --- | --- |
| TypeDoc + typedoc-plugin-markdown | TypeScript/JSDoc API reference for VitePress | 0.28.20 / 4.12.0 |
| dependency-cruiser | Module dependency validation and visualization | 18.1.0 |
| SchemaSpy | D1/SQLite schema documentation and ER diagrams | 7.0.2 |
| VitePress | Unified static developer documentation site | 1.6.4 |

The command-line tools are version-pinned and invoked only by documentation scripts, so they do not become part of the Cloudflare Worker runtime bundle.

TypeDoc, dependency-cruiser, and SchemaSpy are pinned at their invocation site because they cannot share the application's TypeScript 7 dependency. VitePress has no such conflict, so it is pinned by `package-lock.json` and run from `node_modules` instead of being re-downloaded on every `docs:build`, `docs:dev`, and `docs:preview`.

TypeDoc 0.28 and dependency-cruiser 18 support TypeScript through version 6, while the application uses TypeScript 7. Their documentation commands therefore run with a pinned TypeScript 6.0.2 parser. Type checking remains the responsibility of `npm run typecheck`; these tools only convert or inspect the source model.

## Commands

Generate all references:

```sh
npm run docs:generate
```

Build the complete static site:

```sh
npm run docs:build
```

Run the site locally:

```sh
npm run docs:dev
```

Validate source dependency rules without building documentation:

```sh
npm run docs:architecture:check
```

## Keeping command output small

AI coding agents re-read command output as context tokens on every subsequent turn, so successful
tooling should be quiet and failing tooling should be complete. Three repository settings implement
that, and none of them reduce diagnostic detail:

| Setting | Effect |
| --- | --- |
| `.npmrc` (`loglevel=warn`) | Drops the `npm notice run ...` preamble printed before every script |
| `--test-reporter=dot` in `test:unit` | A passing 467-test run prints ~2.8 KB instead of ~47 KB; failures still print assertion, diff, and stack |
| `scripts/run-quiet.ts` | Captures a child command's output and prints it only on a non-zero exit |

`npm run types:worker` is wrapped in `run-quiet.ts` because `wrangler types` re-prints the whole
generated `Env` interface on every invocation. Wrap further tooling the same way when it is noisy
on success:

```sh
tsx scripts/run-quiet.ts <command> [args...]
```

Together with the `verify` / `check` / `fix` aggregate scripts, a full green pre-commit run prints
well under a kilobyte.

## Generated files

The following paths are generated and ignored by Git:

- `docs/reference/api.md`
- `docs/public/generated/`
- `docs/public/db/`
- `docs/.vitepress/dist/`
- `docs/.vitepress/.temp/`
- `.cache/docs/`

Do not edit these outputs manually. Update source code/JSDoc, module imports, migrations, or curated Markdown instead.

## CI

`.github/workflows/docs.yml` rebuilds all generated documentation for pull requests and pushes to `main`. A successful run uploads the complete VitePress output as the `developer-docs` workflow artifact.
