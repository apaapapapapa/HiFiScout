# Registered Product Admin

The Access-protected admin Worker exposes `/listing-admin` for correcting canonical fields on seller listings.

`wrangler.admin.jsonc` deploys `src/admin/entry.ts`. The Worker verifies the Cloudflare Access JWT
and calls `CatalogAdminService` through the `CATALOG_ADMIN` Service Binding; it has no direct D1
binding. The public Worker's `/api/admin/*` paths return 404 even with an `ADMIN_TOKEN`. Configure
Access through the admin deployment workflow rather than trying a static token in the browser.

The React console starts in `frontend/admin-console.tsx`; listing behavior lives in
`frontend/admin-listings.tsx`. Catalog editing, duplicate review, correction reports, and asynchronous
CSV exports are separate capabilities in the same admin surface and its RPC contract.

## Complete data exports

New export requests produce ZIP volumes containing **all columns and all retained rows** of the
product/catalog table families. Both entry points include the other domain as cross-reference
context. The listing `active` scope filters only the `products` table; related tables and catalog
context remain complete. Use `all` for all listings, including inactive/sold-out listings.

The inventory is defined in `src/export/complete-csv.ts`: `products`, `product_*`,
`knowledge_catalog_*`, `data_quality_remediation_*`, price history, evidence archive, listing
projection obligations and taxonomy migration audit. Export job state and physical FTS indexes
are excluded; their source projections are included. General crawl/session and site-operational
tables are outside this product/catalog export. New columns, including generated columns, are
discovered using D1 `PRAGMA table_xinfo`; new tables in these families are discovered automatically.

Each table has its own directory of numbered CSV parts. Every part repeats the complete column
header. There are no alias/source/category/history sample caps, text/JSON truncation, or overall
row/chunk count caps. Pages use an indexed cursor and a byte budget in the **same SQL statement**,
so a concurrent large update cannot make an already-sized page consume unlimited Worker memory.
One large row is exported whole. Tables with a single primary key and `WITHOUT ROWID` are also
supported; an unsupported cursor/schema fails explicitly instead of omitting the table.

Each CSV adds a SQLite type-tag column, described in `manifest.json`. This makes NULL, empty text,
empty BLOB, numeric-looking text and numbers distinguishable. Integers are formatted inside SQLite
to avoid JavaScript precision loss. Text uses reversible backslash/NUL and spreadsheet-formula
escaping. Newlines and long values are preserved; JSON columns remain the exact stored strings.
Import columns as text in a spreadsheet if its automatic conversions would change the values.

Retained R2 evidence objects are copied into the export in bounded binary parts. Concatenating a
file's parts in byte-offset order restores the original object; the manifest identifies its source
key, ETag, byte offset and total size. An already missing/expired object produces an explicit
`unavailable.json` entry. An object that changes/disappears during a multi-part copy fails the
generation rather than mixing versions. External seller pages are not fetched during export.

Large exports have multiple ZIP downloads. **Download every displayed volume** for the full dataset.
Each volume reads at most 200 R2 chunks, independently of total export size, and includes a manifest
with its volume number, total volumes, complete table inventory/schema, filenames, row counts,
checksums and decoding instructions. ZIP entries are streamed; missing chunks abort the download
before a valid ZIP footer can be written. Generation retains the existing 24-hour deadline and
completed exports remain downloadable for seven days. Quota/deadline failures are failures, never
successful partial exports.

This is a live paginated audit export, **not a transactionally consistent database backup**. Cursor
horizons are captured before table reads, but updates/deletes during generation can be reflected.
Run after writes settle when comparing data across tables. Schema changes during generation fail
explicitly; regenerate using the new schema. Existing pre-upgrade CSV jobs keep their original
codec and downloads; the UI labels those attachments as the old format.

The shared archive implementation is in `src/export/complete-archive.ts`. It reuses the existing
Queue lease/CAS/retry flow; immutable R2 chunks also preserve cursor state after a crash. For the
complete format, the public `afterId` field is a chunk sequence, not a listing/catalog identifier.
`archivePartCount` lists the required ZIP volumes, selected by the optional `?part=1` download
parameter. Migration `0093_complete_csv_exports.sql` keeps old jobs compatible via their format.

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
