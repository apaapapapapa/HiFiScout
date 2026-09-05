# Registered Product Admin

The Access-protected admin Worker exposes `/listing-admin` for correcting canonical fields on seller listings.

`wrangler.admin.jsonc` deploys `src/admin/entry.ts`. The Worker verifies the Cloudflare Access JWT
and calls `CatalogAdminService` through the `CATALOG_ADMIN` Service Binding; it has no direct D1
binding. The public Worker's `/api/admin/*` paths return 404 even with an `ADMIN_TOKEN`. Configure
Access through the admin deployment workflow rather than trying a static token in the browser.

The React console starts in `frontend/admin-console.tsx`; listing behavior lives in
`frontend/admin-listings.tsx`. Catalog editing, duplicate review, correction reports, and asynchronous
CSV exports are separate capabilities in the same admin surface and its RPC contract.

## Editable fields

- Canonical manufacturer ID
- Effective model used by search and Product Identity
- Primary category
- Presentation color / finish, kept separate from model identity

Seller-owned evidence remains read-only in this console: title, price, stock status, source URL, and all `raw_*` values.

Categories must be classifiable taxonomy v3 leaves. An unresolved listing starts with no valid
category selection; the internal `unclassified` sentinel and legacy `other` are not manual targets.

## Persistence contract

Edits are stored in `product_admin_overrides`. A later crawler write may refresh seller evidence, but the database re-applies the explicit operator correction before downstream projections are rebuilt. Category membership is likewise kept on the manually selected category closure while an override exists.

After a save, the admin path refreshes dependencies in this order:

1. listing search projection
2. Product Identity resolution
3. product-search entity membership and aggregates

Manual canonical changes are also recorded in `data_quality_remediation_events` so the before/after identity and search-entity state remains auditable.

## Verification

CI applies all D1 migrations and then runs `scripts/verify-listing-admin-overrides.ts`. The integration check simulates a crawler attempting to overwrite a corrected listing and verifies that canonical values remain manually corrected while raw seller evidence still updates.
