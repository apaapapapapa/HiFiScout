# HTTP API Reference

HiFiScout generates its OpenAPI 3.1 description from the same route contracts used by the Worker.
The generated specification is therefore an artifact of the executable HTTP contract rather than a
second hand-maintained API definition.

<a href="../generated/openapi.html" target="_self">Open the Redoc HTTP API reference</a>

The machine-readable description is also available as
<a href="../generated/openapi.json" target="_self">OpenAPI JSON</a>.

## Contract source of truth

The first migrated endpoints are:

- `GET /api/product-search`
- `GET /api/suggest`

Their method, path, query constraints, response schemas, and operation metadata live in
`src/api/public-route-contracts.ts` plus the shared query metadata exported by
`src/api/product-query.ts` and `src/api/suggest-query.ts`.

The Worker dispatches those routes through `src/http/public-routes.ts`. The documentation generator
imports the same contracts through `scripts/docs/generate-openapi.ts`, so path or query changes do
not require a separate OpenAPI edit.

The migration is intentionally incremental. Existing endpoints stay on the legacy router until they
are moved to a route contract; new public JSON endpoints should use a route contract by default.

## Validation

Generate and lint the OpenAPI description:

```sh
vp run docs:openapi:check
```

Generate the description, lint it with Redocly, and build the static Redoc reference:

```sh
vp run docs:openapi
```

The full documentation build runs this automatically:

```sh
vp run docs:build
```
