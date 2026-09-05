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

## CSV export, edit, and import

In the catalog tab, open the CSV export section. Generate and download either the registered-product
audit CSV or the knowledge-catalog CSV, edit the `edit_*` columns, and save as UTF-8 CSV. Keep the
original columns, target ID, and `csv_original` unchanged. Exports generated before the import feature
was deployed must be regenerated; diagnostic columns alone are not an import format.

| Target | Editable CSV columns |
| --- | --- |
| Registered product | `edit_manufacturer_id`, `edit_model`, `edit_primary_category_id` |
| Catalog | `edit_manufacturer_id`, `edit_canonical_model`, `edit_canonical_name`, `edit_primary_category_id`, `edit_lifecycle_status` |

Use verified manufacturer IDs, classifiable canonical category IDs (shown in the console), and
`unknown`, `active`, or `discontinued` for lifecycle status. Empty listing manufacturer/model values
explicitly make those fields unresolved; catalog required fields and categories cannot be cleared.
Changing a catalog primary category replaces its category membership with that leaf and its ancestors.
Name or identity edits alone preserve secondary categories. Seller titles, raw evidence, prices, stock,
and deletion are outside this import contract.

1. Choose the edited CSV (at most 100 MiB) and select **差分を確認**.
2. Review the before/after values and row-level validation results. Unchanged rows are not submitted
   for updating. Invalid IDs, duplicate rows, duplicate catalog identities, or stale originals block
   the update button; correct the file or generate a fresh export.
3. Select **更新を実行** only after reviewing the complete validation results. Keep the screen open
   while updates and related listing/search projection changes run.
4. Download the result CSV if needed. If interrupted, choose the same edited CSV (or the result CSV)
   and run **差分を確認** again. Already-applied edits are skipped and pending projection work resumes.

Updates are atomic **per changed row**, not across the whole file. The server revalidates at apply
time and transactionally guards the current revision together with the mutation and durable receipt.
A concurrent change stops processing without overwriting the newer values; earlier successful rows
remain applied. There is no automatic whole-file rollback. If catalog edits alter the originals of a
separately exported listing file, regenerate that listing export before making further corrections.

`POST /api/admin/csv-import/preview` accepts at most 20 changed rows; `apply` accepts one row with a
revision and operation UUID. Both use the existing Access, same-origin, JSON size, and Service Binding
boundaries. `admin_csv_import_changes` retains before/after values and a durable related-listing cursor.
Catalog identity corrections retain removed alias/source evidence in that receipt, retire the old
identity evidence, and replay affected matched/candidate listings in pages of at most 10, including
inactive retained listings. Explicit listing overrides continue to win. Re-uploading an unchanged CSV
does not create receipts or rewrite products.

## Verification

CI applies all D1 migrations and then runs `scripts/verify-listing-admin-overrides.ts`. The integration check simulates a crawler attempting to overwrite a corrected listing and verifies that canonical values remain manually corrected while raw seller evidence still updates.
