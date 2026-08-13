# Documentation Tooling

HiFiScout's developer documentation is built from four complementary OSS toolchains.

| Tool | Responsibility | Pinned version |
| --- | --- | --- |
| TypeDoc + typedoc-plugin-markdown | TypeScript/JSDoc API reference for VitePress | 0.28.20 / 4.12.0 |
| dependency-cruiser | Module dependency validation and visualization | 18.1.0 |
| SchemaSpy | D1/SQLite schema documentation and ER diagrams | 7.0.2 |
| VitePress | Unified static developer documentation site | 1.6.4 |

The command-line tools are version-pinned and invoked only by documentation scripts, so they do not become part of the Cloudflare Worker runtime bundle.

TypeDoc 0.28 supports TypeScript through version 6, while the application uses TypeScript 7. The API documentation command therefore runs TypeDoc with a pinned TypeScript 6.0.2 parser. Type checking remains the responsibility of `npm run typecheck`; TypeDoc only converts the exported API model to Markdown.

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
