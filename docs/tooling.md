# Documentation Tooling

HiFiScout's developer documentation is built from four complementary OSS tools.

| Tool | Responsibility | Pinned version |
| --- | --- | --- |
| documentation.js | TypeScript/JSDoc API reference | 14.0.0 |
| dependency-cruiser | Module dependency validation and visualization | 18.1.0 |
| SchemaSpy | D1/SQLite schema documentation and ER diagrams | 7.0.2 |
| VitePress | Unified static developer documentation site | 1.6.4 |

The command-line tools are version-pinned and invoked only by documentation scripts, so they do not become part of the Cloudflare Worker runtime bundle.

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
- `.cache/docs/`

Do not edit these outputs manually. Update source code/JSDoc, module imports, migrations, or curated Markdown instead.

## CI

`.github/workflows/docs.yml` rebuilds all generated documentation for pull requests and pushes to `main`. A successful run uploads the complete VitePress output as the `developer-docs` workflow artifact.
