# Registered Product Admin

The Access-protected admin Worker exposes `/listing-admin` for correcting canonical fields on seller listings.

## Editable fields

- Canonical manufacturer ID
- Effective model used by search and Product Identity
- Primary category

Seller-owned evidence remains read-only in this console: title, price, stock status, source URL, and all `raw_*` values.

## Persistence contract

Edits are stored in `product_admin_overrides`. A later crawler write may refresh seller evidence, but the database re-applies the explicit operator correction before downstream projections are rebuilt. Category membership is likewise kept on the manually selected category closure while an override exists.

After a save, the admin path refreshes dependencies in this order:

1. listing search projection
2. Product Identity resolution
3. product-search entity membership and aggregates

Manual canonical changes are also recorded in `data_quality_remediation_events` so the before/after identity and search-entity state remains auditable.

## Verification

CI applies all D1 migrations and then runs `scripts/verify-listing-admin-overrides.ts`. The integration check simulates a crawler attempting to overwrite a corrected listing and verifies that canonical values remain manually corrected while raw seller evidence still updates.
