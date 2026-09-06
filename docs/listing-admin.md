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

The **全情報ZIPを生成** action produces ZIP volumes containing **all columns and all retained rows** of the
product/catalog table families. Both entry points include the other domain as cross-reference
context. The listing `active` scope filters only the `products` table; related tables and catalog
context remain complete. Use `all` for all listings, including inactive/sold-out listings.

The inventory is defined in `src/export/complete-csv.ts`: `products`, `product_*`,
`knowledge_catalog_*`, `data_quality_remediation_*`, price history, evidence archive, listing
projection obligations, taxonomy migration audit and CSV import change receipts. Export job state and physical FTS indexes
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
The continuation stores the original evidence row ID, object key, ETag, size and byte offset.
Deleting the metadata row or changing its object key cannot redirect a copy already in progress.

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

These table CSVs use their stored database schema and the manifest's reversible encoding. They are
audit archives, not the versioned `edit_*` CSV contract for bulk corrections. Use **編集用CSVを生成** for the separate versioned edit contract; never upload a raw table
CSV as an edit file. The POST body selects `format: "complete"` or `format: "csv"`. Omitting
`format` retains CSV behavior for older admin Workers during rollout. An active job is reused
within each scope regardless of format; wait for it to complete before generating another format.

The shared archive implementation is in `src/export/complete-archive.ts`. It reuses the existing
Queue lease/CAS/retry flow; immutable R2 chunks also preserve cursor state after a crash. For the
complete format, the public `afterId` field is a chunk sequence, not a listing/catalog identifier.
`archivePartCount` lists the required ZIP volumes, selected by the optional `?part=1` download
parameter. Migration `0094_complete_csv_exports.sql` keeps old jobs compatible via their format.

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

The two editable exports and the result CSV share the same reversible formula/apostrophe encoding.
Canonical source columns are reserved before diagnostic text/JSON consumes the catalog row budget.
Editable before-images retain up to 4,096 characters per field, matching the import envelope; new
names/models still obey their shorter domain limits. Existing tabs/newlines can be corrected or left
unchanged, but new control characters cannot be introduced. If a canonical before-image contains
`[truncated]` (including NUL-bearing or over-limit stored values), that row cannot be safely updated
from this CSV: use individual editing and regenerate it. Other unchanged rows remain no-op rows.

1. Choose the edited CSV (at most 100 MiB) and select **差分を確認**.
2. Review the before/after values and row-level validation results. Unchanged rows are not submitted
   for updating. Invalid IDs, duplicate rows, duplicate catalog identities, or stale originals block
   the update button; correct the file or generate a fresh export.
3. Select **更新を実行** only after reviewing the complete validation results. Keep the screen open
   while updates and related listing/search projection changes run.
4. Download the result CSV if needed. If interrupted, choose the same edited CSV (or the result CSV)
   and run **差分を確認** again. Already-applied edits are skipped and pending projection work resumes.

If the current page is still open, an interrupted update retains its operation IDs and can use
**更新を再開** directly. An Access login failure offers **別タブでログインを確認**; authenticate there,
then return to the original page to resume without parsing and previewing the file again. A lost
response reuses the same durable operation ID. Only CSV preview/apply retry temporary network or
502/503/504 failures, at most twice with backoff; authentication failures and conflicts stop promptly.
Refreshing/closing the original page still requires selecting the CSV again.

Updates are atomic **per changed row**, not across the whole file. The server revalidates at apply
time and transactionally guards the current revision together with the mutation and durable receipt.
A concurrent change stops processing without overwriting the newer values; earlier successful rows
remain applied. There is no automatic whole-file rollback. If catalog edits alter the originals of a
separately exported listing file, regenerate that listing export before making further corrections.

`POST /api/admin/csv-import/preview` accepts at most 20 changed rows and 256 KiB of UTF-8 JSON;
the browser splits batches by both limits. `apply` accepts one row with a
revision and operation UUID. Both use the existing Access, same-origin, JSON size, and Service Binding
boundaries. `admin_csv_import_changes` retains before/after values and a durable related-listing cursor.
Catalog identity corrections retain removed alias/source evidence in that receipt, retire the old
identity evidence, and replay affected matched/candidate listings in pages of at most 10, including
inactive retained listings. Explicit listing overrides continue to win. Re-uploading an unchanged CSV
does not create receipts or rewrite products.

Empty reference/discovery phases are skipped within the same request, without writing intermediate
cursors. A catalog correction with no related listings therefore completes in one apply request
instead of four. Nonempty work remains limited to one page of 10 listings per request; full pages
still yield and persist their cursor. This reduces HTTP round trips and D1 receipt reads/writes;
it does not increase the page size or run a whole import in one Worker invocation.

Access validation caches only public signing keys and imported cryptographic keys. It checks the
signature, issuer, audience and expiry on every request. Concurrent key loads are coalesced, and an
unknown key can refresh the cache with a 30-second cooldown for rotation. A key-service outage or
timeout fails closed with `cloudflare_access_unavailable` (503), separately from an invalid/missing
login's `cloudflare_access_required` (403). The `admin_access_key_service_unavailable` event contains
no tokens or identity data. Older deployments returned the same 403 for these different causes.
See [Cloudflare's JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Admin redeploys preserve the running Worker's Access configuration while provisioning Access, then
publish the configured replacement once. The unconfigured, access-denied bootstrap is used only
when paginated Worker discovery confirms that no admin Worker exists. Discovery/provisioning errors
stop deployment and leave an existing Worker in place; they must not be interpreted as absence.
Publishing a bootstrap on every redeploy would temporarily reject otherwise valid CSV sessions.

Listing edits preserve untouched compatibility/canonical manufacturer IDs, category closure, direct
membership and search aliases. Name/lifecycle-only catalog edits need no listing projections,
candidate discovery or reclassification; model spelling changes still refresh existing references.
Category propagation skips already-equal values and explicit
listing category overrides; identity discovery advances its bounded scanned-ID cursor even when every
row in a page was already refreshed. Failed projection work still resumes from its durable receipt/token.

## Verification

CI applies all D1 migrations and then runs `scripts/verify-listing-admin-overrides.ts`. The integration check simulates a crawler attempting to overwrite a corrected listing and verifies that canonical values remain manually corrected while raw seller evidence still updates.
