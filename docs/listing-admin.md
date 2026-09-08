# Registered Product Admin

The Access-protected admin Worker exposes the console at `/`; registered products use
`/#listings`. Retired `/listing-admin` and `/catalog-admin` entry points return 404.

`wrangler.admin.jsonc` deploys `src/admin/entry.ts`. The Worker verifies the Cloudflare Access JWT
and calls `CatalogAdminService` through the `CATALOG_ADMIN` Service Binding; it has no direct D1
binding. The public Worker's `/api/admin/*` paths return 404 even with an `ADMIN_TOKEN`. Configure
Access through the admin deployment workflow rather than trying a static token in the browser.

The React console starts in `frontend/admin-console.tsx`; listing behavior lives in
`frontend/admin-listings.tsx`. Catalog editing, duplicate review, correction reports, and asynchronous
CSV exports are separate capabilities in the same admin surface and its RPC contract.

For local authenticated browser testing, run `vp run test:e2e:admin` after installing Chromium with
`vp exec playwright install chromium`. The suite uses the real built console and Worker authentication
with a test-only Access issuer and in-memory RPC state; it does not require a real login or change
production Access settings. See [Testing strategy](./testing-strategy.md#local-authenticated-admin-coverage)
for fixtures, rejection/recovery cases and the boundary this suite covers.

## Task workspaces

The console uses a persistent sidebar on desktop and a labelled native task selector on mobile.
The workspaces are product catalog (`/` or `/#catalog`), registered products (`/#listings`),
correction reports (`/#reports`), duplicate review (`/#duplicates`), unverified candidates
(`/#candidates`), CSV import/export (`/#csv`), offer-fact replay (`/#maintenance`), crawl controls (`/#crawls`), and background jobs (`/#jobs`). Browser
Back/Forward and direct links select the corresponding workspace. Navigation preserves already
loaded searches and in-progress CSV input within the open console; it does not persist private
admin data in browser storage. Each workspace has a distinct page title and an active menu label.

The task selector and sidebar show work counts for correction reports (all unresolved `open` and
`in_review` reports, regardless of age), duplicate catalog **groups**, and candidates whose review
status is `pending`. Counts are independent of workspace search filters: 0–99 display numerically,
and 100 or more display as `99+`. Unavailable or incomplete counts display `—`, never a false zero.
They refresh after report actions, catalog creation/verification/merges and CSV changes, and when
returning to the window or changing workspaces after a minute. There is no idle polling.

`GET /api/admin/work-counts` is Access protected and uses the Service Binding. Status-indexed
subqueries read at most 100 reports/candidates each. A trigger-maintained projection retains only
members of non-singleton identity buckets; a keyset request reads at most 201 projected catalog
members. The server applies the shared identity normalizer, and the browser counts each true
duplicate group once across pages, stopping at 100 groups. Buckets shared by different manufacturers
are not counted as duplicates. Catalog-wide aggregation is confined to the migration backfill,
not navigation requests. Multi-page counts are eventually consistent with concurrent changes.

Catalog, candidate, duplicate and export queries start when their workspace is first opened.
Listing search and replay are also loaded independently. A failed metadata request has an inline
retry. Deep-link filters are passed directly to React state before the first search; a listing link
can supply `shopKey` and `scope` without `q`. Returning to a loaded workspace does not refetch its
unchanged search. Export status polling runs only while the CSV workspace is visible. Started
server export and submitted CSV jobs continue independently of the browser.

Search results emphasize product identity and the primary editing actions. Raw seller evidence
remains in the listing editor. Editors use a side panel with a sticky heading and save
controls, before/after values, inline save errors, and protection against closing during a save.
Explicit merge-by-ID is a secondary disclosure requiring the existing identity preview and
confirmation. CSV input presents file selection, diff review, and apply as three labelled steps;
the complete ZIP and versioned editable CSV remain distinct formats.

## Seller offer decisions

The listing row's **出品条件** action opens the title, original condition label and seller-derived
facts alongside separate manual decisions. The editor can confirm presence, explicit absence, or
unknown, and can remove a decision with **自動判定に戻す**. Unknown is an intentional override;
removing a decision restores the retained seller evidence. Only changed fields are submitted.

`GET/PATCH /api/admin/listings/:id/offer-facts` uses the same Access-protected entry and Service
Binding as listing edits. PATCH accepts at most the declared offer-fact vocabulary with a 4 KiB
JSON body and enforces the existing same-origin policy. Each patch commits atomically; repeating
the same decision writes no rows and retains its observation time. Seller facts, listing identity,
price history and catalog classification are preserved. The public search reads manual authority
directly, without triggering catalog-wide projection work.

## Bounded offer-fact replay

**出品条件の再処理・充足率** processes retained listing fields without contacting sellers. One request
handles at most 25 listings; the optional 500-listing action sends at most 20 sequential requests.
**全商品を再処理** confirms and submits a durable job, including inactive listings. After the
submission is accepted, closing the tab does not stop processing. Open **バックグラウンド処理** to
check saved progress or pause/resume it; one in-flight bounded step may finish after a pause.
The job resumes the saved cursor and pins the extraction-rule version. New listings receive facts
through the ordinary writer. A processing error or three consecutive steps without progress stops
the job for review. The 25/500 actions retain their bounded foreground request limits.

Each step atomically claims its expected cursor, verifies the source-field snapshot, writes facts
under a unique step token, and records coverage. A concurrent caller or changed source snapshot
cannot advance or write stale facts. A failed transaction rolls back its cursor and facts together.
Observation dates use the original listing's `last_seen_at`, not the date of replay; manual decisions
survive. Completed steps and unchanged seller facts retain existing write guards.

Coverage is a retained snapshot of active listings processed in this run, grouped separately by shop
and category. It counts explicit positive or negative evidence for condition, included items,
warranty, and sale unit. It is partial until completion and is not a live inventory denominator.
Review these gaps and sample the seller evidence before promoting filters more widely. The
`offer_fact_replay_step` log records D1 reads, writes and statement counts for each bounded step.
`GET/POST /api/admin/offer-facts/replay` is Access protected; POST takes only an empty JSON object,
and the client cannot supply a cursor or override the server's batch size.

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

Listing edits and new catalog entries offer a manufacturer-name picker. Its Access-protected
`/api/admin/manufacturers` read delegates to `CatalogAdminService.listManufacturers` and searches
only verified registry entries and their verified aliases. Search text never becomes a selected
identity automatically. Pages contain at most 50 entries and use an ID cursor; changing the query
starts over, failed requests can be retried, and stale responses cannot replace current choices.
The lookup reads manufacturer/alias tables, never aggregates products or creates registry entries.
Substring searches can scan the manufacturer registry; page size is not a constant-read claim.
The public Worker still returns 404 for this and every other admin API.

Clearing a listing's manufacturer explicitly stages an unresolved manual override. Catalog creation
retains the existing direct name/ID input under a secondary disclosure for identities outside the
verified picker; this does not mark the manufacturer verified or change the creation contract.
Listing and catalog editors show current and saved values inline before submission. Color/finish
previews use the HTTP parser's canonical spelling, and unknown color inputs must be corrected.
Seller-owned evidence stays visible and read-only; saving still uses the existing override and
projection sequence below, without an additional confirmation dialog.

## Persistence contract

Edits are stored in `product_admin_overrides`. A later crawler write may refresh seller evidence, but the database re-applies the explicit operator correction before downstream projections are rebuilt. Category membership is likewise kept on the manually selected category closure while an override exists.

After a save, the admin path refreshes dependencies in this order:

1. listing search projection
2. Product Identity resolution
3. product-search entity membership and aggregates

Manual canonical changes are also recorded in `data_quality_remediation_events` so the before/after identity and search-entity state remains auditable.

## CSV export, edit, and import

Open **CSV入出力** from the task menu. Generate and download either the registered-product
audit CSV or the knowledge-catalog CSV, edit the `edit_*` columns, and save as UTF-8 CSV. Keep the
original columns, target ID, and `csv_original` unchanged. Exports generated before the import feature
was deployed must be regenerated; diagnostic columns alone are not an import format.

The same catalog CSV also accepts **new catalog rows**. Append a row, leave `catalog_product_id`
and `csv_original` empty, and fill all five catalog `edit_*` columns below. Other columns on the
new row can be empty. Set `edit_lifecycle_status` to `unknown` when the lifecycle is not known.
Use a registered, verified manufacturer ID or a canonical ID from the trusted code manufacturer
registry. For a new catalog row, a missing manufacturer from that registry is created with
`code_bootstrap` provenance in the same transaction as the product. Preview remains read-only.
Existing manufacturer names, provenance, timestamps, and verification decisions are preserved;
pending/rejected manufacturers and unknown IDs still block import. Seller spellings and the mere
presence of existing catalog products do not qualify an unknown manufacturer for this fallback.
Existing-row corrections still require a registered, verified manufacturer when changing its ID.
The import does not create seller listings. Existing rows still require their unchanged ID and
original snapshot.

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
2. Review the new-row/correction counts, before/after values, and row-level validation results. Unchanged rows are not submitted
   for updating. Invalid IDs, duplicate rows, duplicate catalog identities, or stale originals block
   the update button; correct the file or generate a fresh export.
3. Select **更新を実行** (or **登録・更新を実行** when adding catalog rows) after reviewing validation.
   Keep the page open until all confirmed rows have been sent and the job is accepted. Updates then
   continue on the server, including related listing/search projections.
4. Open the linked **バックグラウンド処理** to read saved progress and row results, pause/resume,
   or retry failed targets. **確認結果CSVをダウンロード** contains the preview, not background results.

New entries become manually verified catalog products, with a generated ID, category closure,
canonical model alias, and a `manual_verified` source naming the import operation. These records
and the durable receipt commit in one transaction. The job result table shows the assigned ID. Durable inputs and receipts retain the original
creation intent so interrupted additions resume with the same operation ID. Generate a fresh edit export to correct an added entry later.

Duplicate additions are checked across the entire file, including unchanged existing rows and
manufacturer/model spelling variants under the shared catalog identity rules. Database checks
use a bounded indexed identity bucket, revalidate at apply time, and guard that bucket inside the
write transaction. More than 50 candidates blocks insertion for review. A registered product with
exactly the same editable values is skipped (or resumes its pending CSV creation); a different
or rejected entry with the same identity is reported with its existing ID and is never silently
overwritten/revived. Resubmitting an applied creation writes nothing. Discovery of matching
seller listings uses the existing durable cursor, at most 10 listings per request, including
retained inactive listings and preserving explicit listing overrides.
Completing a creation records the catalog remediation watermark for that creation's verification
generation together with the applied receipt, so catalog finalization does not repeat the work.
A later verification retains its own pending remediation work.

An interrupted **upload** retains the job and row operation IDs in the open page; **送信を再開**
checks the server offset before resending. An Access failure offers **別タブでログインを確認**; log in
there and return to retry. Submitted jobs no longer depend on the browser session. If the page
closed before submission finished, cancel the incomplete upload in the job list and select the CSV
again. A fully uploaded job can be started from that list even if its start response was lost.

Updates are atomic **per changed row**, not across the whole file. The server revalidates at apply
time and transactionally guards the current revision together with the mutation and durable receipt.
A concurrent change is recorded as a failed target without overwriting newer values; successful rows
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
## Model relationships and series

The Catalog table's **機種の関係** action opens an independent editor for successor links,
verified variants and ordered series memberships. Select the related model from the existing
verified-catalog search and choose an existing source for either endpoint, or enter a manual
verification note. Candidate and rejected decisions are distinct from verified decisions. A
missing or changed source, or a passed review deadline, is shown as **再確認待ち**. The explicit
re-verification action records a new decision time; an unchanged ordinary save is disabled.

The Access-protected `GET/POST /api/admin/knowledge-catalog/products/:id/model-facts` endpoint
returns current facts, up to 40 source choices and the most recent 20 audit events. POST requires
a same-origin JSON body of at most 8 KiB and the current optimistic version for edits. The reviewer
comes from the verified Access subject, never a submitted actor field. The Service Binding
validates the write contract again. There is no corresponding public admin route.

Deletion keeps a removed decision and its audit. Catalog merges/deletions are blocked while
current model relationships need review; after explicit removal, old model-fact rows may be
cleaned up with the catalog product while the audit remains. Relation editing never merges
identities or creates catalog products for presentation colours.

## Listing diagnosis

Each registered listing has a **判定理由** inspector. It reads the retained seller fields, current
normalization/resolution, explicit overrides, catalog match/candidate and rejection evidence, and
stored search membership. Manual overrides are identified separately; historical automatic decisions
that were not retained are never reconstructed or presented as facts.

The Access-protected `GET /api/admin/listings/:id/diagnosis` uses primary-key joins for one listing
and a capped exact-identity index lookup for 20 active peers (plus one continuation indicator). It
does not crawl, resolve, repair, count all products or scan the catalog. Peer membership is a
comparison snapshot, not proof that two listings should be merged. The inspector loads on demand
and offers retry on failure; it never polls in the background.

## Change history and guarded restoration

Catalog and listing rows offer **変更履歴**, combining up to 25 recent editor changes, CSV receipts
and retained resolver events. Reads use per-target time indexes (at most 26 rows per source), without
inventory counts or a global history scan. Older records remain in complete exports. Existing CSV
before-images are reused; changed individual edits add one atomic journal row. Unchanged repeated
listing overrides write nothing. Historical resolver events are shown as reference-only because
they do not retain the complete editable state.

**この値へ戻す** previews one field against the current value and rejects a later edit, a same-value
ABA cycle, an incomplete import or a now-invalid value. Applying the preview uses the existing
CSV revision/transaction guard and resumable projection receipt. Colour restoration uses the same
listing writer with an atomic snapshot guard and idempotent operation journal. A restoration is a
new manual decision, not removal of an override or a database rollback. Other fields and retained
seller evidence are preserved. Catalogue creation receipts without a before-image cannot be used
as delete operations. Model relationship/specification decisions retain their own existing editors.

The Access-protected history API supports `GET /api/admin/change-history?kind=listing&id=...`,
`POST /api/admin/change-history/restore-preview`, and the colour apply endpoint
`POST /api/admin/change-history/restore-color`. Other restored fields use the existing CSV apply
endpoint. Each step is bounded; keep the dialog open until projection completion, or reuse the
same in-memory operation after a network failure. Public admin routes remain unavailable.

## Bulk corrections from search results

Select explicit listing rows (or the current page, at most 50) and choose **一括修正** to change a
manufacturer, model or category. A new search or page navigation clears the selection. The dialog
keeps a snapshot of selected targets and displays each before/after value and validation result
before an explicit apply action. Empty manufacturer/model input is an intentional unresolved override.

Preview uses the existing bounded CSV validation batches; apply uses the same revision guard,
durable receipt and projection continuation as CSV import. Concurrent edits are excluded and failed
requests retain their operation IDs for safe retry. Applied rows are skipped on resume. Stop takes
effect after the current request; results remain visible while the dialog is open. Opening the
dialog adds no inventory scans, counts or polling, and only selected rows are validated or changed.

## Durable background processing

`AdminJobs` is a separate SQLite-backed Durable Object reached through the Access-protected
`POST /api/admin/jobs` service-binding API. One coordinator serializes admin work; it has no role
in per-shop crawl dispatch. Commands support create, append, start, pause, resume, failed-only retry,
cancel, list and bounded result pages. The **バックグラウンド処理** workspace reads these saved
summaries on demand, with no idle polling; result pages can filter failures using the state index.

CSV targets retain the confirmed before-image, revision and operation ID. Uploads use at most 20
rows and 256KiB per request, with exact offset/content verification for repeated delivery. A job
cannot start until every declared row has been received. The processing-data limit is 128MiB;
the existing source CSV limit remains 100MiB. At most three uploading, queued, running or paused
jobs are admitted. No D1 writes occur during upload or job-list reads.

Each alarm performs at most five existing CSV apply/continuation steps, or one offer-fact replay
batch of at most 25 listings. The same D1 snapshot guards and receipts prevent stale overwrites
and repeated changes after a lost job checkpoint. A transport/quota failure stops that job before
the remaining rows are attempted. Other row conflicts are recorded individually; failed-only retry
uses the retained revisions and never silently refreshes stale input. Replay pins its rule version
and stops after three no-progress steps. Pause/cancel received during a D1 request remains in
effect after that bounded step finishes. Resume preserves its stored cursor.

The job index and counters are stored with the coordinator; viewing them never counts products or
scans D1 history. Lists return 25 summaries and result pages return 50 rows using time/target indexes.
Successful rows immediately discard their input payload. Remaining result details expire after seven
days and are deleted in chunks of at most 1,000 rows; small summaries and canonical D1 correction
receipts remain. A paused/uploading job whose details expired must be uploaded again. Metadata reads
do not run jobs, poll, or repair data. Alarms and explicit control actions own continuation.

## Operations dashboard

**負荷・稼働状況** (`/#operations`) loads on first entry and explicit refresh. It reads two fixed R2
summaries, the existing small shop-state overview, and at most 25 stored background-job summaries.
It never aggregates inventory, catalog or correction-history tables. D1 values describe observed
SQL groups; hourly missing/provisional/limited coverage and collection dates remain visible.
Native Worker invocation statuses include CPU exhaustion, with separate unavailable indicators.
These native aggregates cannot attribute usage or CPU failures to a shop. A separate failure list
filters saved shop failures and recent CSV/replay jobs by process and shop, and links to their
existing controls. SQL rankings filter by statement kind without additional requests.

The serving public Worker version comes from runtime metadata. The saved status of main distinguishes
D1-quota deferral from completed deployment workflows, including successful no-op runs. SQL summaries
older than eight hours and runtime summaries older than one hour are labelled stale. The dashboard
does not enable paused production health checks. See [the snapshot collection contract](./d1-sql-observation.md#admin-dashboard-snapshots).

## Extraction preview

**抽出テスト** (`/#extraction`) accepts up to 20 retained listing IDs and/or entered seller titles.
The listing diagnosis panel links to a prefilled sample. Submission compares stored fields, current
extraction, an optional draft manufacturer alias (global or one shop), and proposed values retaining
manual authority. The draft is never saved. Conflicting verified aliases remain ambiguous, so the
preview does not quietly reassign another manufacturer's spelling.

The Access-protected `POST /api/admin/extraction-preview` accepts at most 128KiB. It reads selected
primary keys and a reference alias dictionary capped before filtering at 1,001 rows; more than
1,000 dictionary rows is rejected rather than calculating with incomplete evidence. No inventory
count, seller fetch, D1 mutation, catalog match, or projection update occurs. The manufacturer and
model resolvers are compiled once per batch. Retained non-title category evidence uses the same
pure helper as remediation; title evidence is recalculated with current rules. Stored fields over
the preview bounds or missing products produce individual sample errors.

Rule versions and the observation time accompany results. The proposed values are explicitly before
catalog rematching; existing manual decisions remain visible. Changing input clears the old comparison.

### メーカー別名の適用範囲

メーカー照合と型番からのメーカー表記除去は、同じ別名辞書とショップ範囲を使う。
全ショップ共通の別名は既存テーブル、ショップ固有の別名は
`knowledge_catalog_shop_manufacturer_aliases` に保存する。同じメーカー・正規化別名の
ショップ指定は、そのショップでの共通指定を上書きする。他メーカーとの表記衝突は
引き続き未確定候補になり、ショップ指定だけで別メーカーを強制確定しない。

`admin_alias_control` による無効化は組み込みの別名にも適用する。従来の未採用提案を
意味する `rejected` は、組み込み辞書を無効化しない。ショップ別のコンパイル結果は
バッチ内で再利用し、商品ごとに辞書を問い合わせない。辞書の変更は対象商品の明示的な
再処理で反映するため、この保存形式の追加だけでは全商品のルール版を更新しない。

### メーカー辞書の確認・適用と再判定

Access 配下の `POST /api/admin/manufacturer-registry` は、正式名称、日本語・英語表記と
共通／ショップ固有の別名を確認・適用する。正式表記の追加・変更時にはその表記も別名へ
登録する。既存の正式表記を変更しない操作では、以前の無効化を勝手に解除しない。
プレビューには保存値・現在の抽出・変更後・手動補正を保持した値と、他メーカーとの
表記衝突を表示する。商品カードのカタログ照合は再判定時に実施する。

確認画面は主キー順の最大200件を調べ、最大20件の候補を返す。対象範囲、確認済み件数、
続きのカーソルと集計日時を表示し、候補のサンプル数を全商品の影響件数と見なさない。
辞書は最大1000行、メーカー詳細は最大500別名に限定し、超過時には部分的な辞書を使わず
停止する。履歴は対象メーカーの最新25操作を索引から読む。画面を開く操作で全商品の
集計・走査は行わない。

確認後の変更は辞書の世代番号と入力ダイジェストで検出する。一度別の値に変わってから
元に戻った場合も再確認が必要。操作ID、変更前の内容、適用内容、対象範囲をD1へ同時に
保存し、応答を失った場合は同じ操作IDで再送する。適用済みの再送はD1を書き換えない。

適用時点の最大商品IDまでをメーカー再判定ジョブで確認する。1回のアラームでは最大25件の
候補窓から最大5商品を再判定し、カーソルを永続化する。ショップ指定は
`idx_products_admin_shop_cursor(shop_key,is_active,id)` 索引から稼働中・保持中の両方を読む。
分類項目がIDより前にある品質集計用索引では、商品ID順に並べるためショップ全体を読むので
代用しない。カーソル索引は新規商品・ショップ/稼働状態の変更時に1エントリー増分となる。
辞書はジョブ実行中に
メモリーで再利用し、世代が変わった場合だけ再読込する。再判定は実行時の最新辞書と
手動補正を使う。処理一覧から一時停止・再開でき、失敗時は保存した続きで止まる。

辞書の保存とジョブ受付は別サービスなので、受付に失敗した場合も「辞書は保存済み」と
表示し、同じ操作IDで受付を再試行する。未完了ジョブの上限に達している場合は、処理一覧で
既存ジョブを完了または中止してから再送する。

`#manufacturers` のメーカー・別名画面は、メーカーを選択して開いたときだけ詳細を取得する。
新規メーカーはIDを指定して開き、正式名称を入力する。保存済みの別名はキーを固定して
有効／無効を変更する。表記やショップ範囲を変更する場合は旧別名を無効化して保存し、
「新しい別名を追加」から登録する。影響の確認後に内容を編集すると、確認結果を破棄して
再確認を求める。確定した入力拒否・競合時も再確認に戻る。適用応答が不明な間は入力を
固定し、同じ操作IDの再送だけを行う。
受付失敗はその場、または再訪時の履歴から再試行できる。抽出テストから選択中メーカーの
管理画面へ移動できる。

### 優先度付き品質点検

Access 配下の `POST /api/admin/quality` は保存済みの品質集計、未対応報告のグループ、
未検証カタログ候補の優先順位を返す。登録済みショップごとに最新の `data_quality_runs`
を索引から1行だけ読み、メーカー未確定・未分類・照合の拒否・照合候補を重症度と件数で
並べる。集計日時・対象商品数は問題が0件のショップでも返す。未集計は不明として区別する。
画面表示のために品質スナップショットの再集計や全在庫のカウントを実行しない。

誤り報告は対象商品・報告理由ごとの保存カウンターを使い、補正済み報告の後に届いた
再報告数、未対応数、更新日時の順に25グループずつ返す。「再報告」は誤りの再発が
確認されたことを意味しない。過去の保持報告に対する初回移行後は、報告の追加・状態変更・
保持期限による削除に伴う小さな増分更新だけを行う。本文・画像の複製や商品更新ごとの
品質トリガーは追加しない。関連出品数は既存の検索カードの保存値で、集計日時が未保存の
場合は不明とする。未検証候補も保存済みの優先度・関連商品数・ショップ数から25件ずつ読む。

問題の商品の確認は明示操作で、指定ショップの稼働中商品をID順に最大200件調べ、該当する
最大20件と続きのカーソルを返す。空の窓にも続きがあり得る。品質集計時点と現在の商品状態は
異なるので、サンプル数を集計総数と同一視しない。報告IDの指定読み取りは主キー1件だけで、
元の誤り報告画面の対応操作へ引き継ぐ。

`#quality` の品質点検画面は初回表示と明示的な再読み込みだけで情報を取得する。
ショップと重症度／影響商品数の切り替えは保存済みの一覧内で行う。各欄は独立して取得し、
一部取得に失敗した場合は前回の取得日時付き表示とエラーを残す。24時間以上前の品質集計を
表示上で区別し、問題が0件のショップにも集計日時、未集計ショップには品質不明を示す。
課題の商品サンプルから判定理由・抽出テストへ、報告から `?reportId=…#reports` の
1件表示へ、未検証候補からメーカー・型番で絞った確認画面へ移動できる。
