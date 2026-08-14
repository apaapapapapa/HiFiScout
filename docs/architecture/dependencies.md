# Module Dependencies

HiFiScout uses dependency-cruiser to analyze ES module imports under `src/` and `frontend/`.

<a href="../generated/dependencies.html" target="_self">Open the generated interactive dependency report</a>

## CI architecture check

Every rule in `.dependency-cruiser.json` has `error` severity, so `npm run docs:architecture:check` fails the build instead of reporting advice. The rules encode boundaries that are already load-bearing:

- **Acyclic** — first-party dependencies under `src/` and `frontend/` must stay acyclic.
- **Contract boundary** — `src/api/contracts.ts` may depend only on the catalog type vocabulary, `frontend/` may reach `src/` only through that one file, and `src/` never imports `frontend/`. The browser bundle therefore shares the HTTP contracts and nothing else.
- **Domain above storage** — `src/catalog/` must not import `src/db/`, and repositories must not import the crawler or the HTTP layer.
- **Shops stay plugins** — generic code composes shops through `src/crawler/shops/index.ts`; an adapter cannot reach persistence, search, evidence, HTTP, or the API except the activity-policy vocabulary; and catalog/repository code never imports shops.
- **Knowledge Catalog separation** — the crawler and the verification pipeline meet through the database rather than each other's types, and `src/knowledge-catalog/policy.ts` keeps I/O out of its retry, lease, and promotion decisions.
- **Product search grouping has one definition** — `src/db/product-search-entity-sql.ts` may import nothing from `src/`. It is the single SQL definition of what a search entity is, executed by the crawler's incremental sync, the admin rebuild, and the migration backfill; a dependency on a repository or the catalog is exactly what would let those three start disagreeing about grouping.

Each rule carries a `comment` describing the failure it prevents, and that text is what the check prints on a violation. Add new rules the same way: state the regression, not the restriction.

dependency-cruiser parses the TypeScript sources with its own pinned `typescript@6.0.2`, supplied through the `npx --package` invocation in the `docs:architecture*` scripts. dependency-cruiser 18.1.0 does not yet accept the project's `typescript@7` compiler, and without a compatible parser it silently cruises zero modules instead of failing.

## Generation

```sh
npm run docs:architecture:check
npm run docs:architecture
```

The first command fails on configured architecture violations. The second produces the self-contained HTML report embedded in the VitePress output.
