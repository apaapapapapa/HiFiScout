# Catalog research and import

## Establish the researched identities

Define the requested manufacturer/product/time scope and compare catalog identities with listing-derived
gaps. Use official current/discontinued indexes, manuals and product pages; record URLs, access dates
and what each proves. Seller listings nominate products but do not alone verify canonical identity.
Do not infer finishes, dates, specifications or lifecycle state from a neighboring model.

Use the shared manufacturer registry, identity normalization and taxonomy. Preserve suffixes/revisions;
distinguish product name, model identity and finish. Keep conflicts/unfamiliar brands as review candidates
instead of inventing verified IDs. An exhaustive request needs an enumerated source inventory,
deduplication and explicit gaps; a large sample is still partial.

## Prepare an editable CSV when requested

Use the CSV sections of [listing admin](../../../../docs/listing-admin.md), the current
[CSV contract](../../../../src/admin/knowledge-catalog-csv.ts) and, for additions, the
[creation path](../../../../src/db/admin-csv-catalog-create.ts). They own columns and batch/byte limits.

Use a current **編集用CSV** export. Preserve IDs, original columns and `csv_original`; change supported
`edit_*` fields only. Additions use the contract's blank ID/original fields and required editable values.
Full-information ZIP/table CSVs use a different encoding and are audit data, not importable edit files.
Preserve UTF-8, reversible escaping, leading zeros, punctuation and original snapshots. Check duplicates
across the whole file and current catalog. Never force a stale before-image through a conflict or invent
color/specification columns because another editor supports them.

## Apply and account for results within authorization

Use the read-only preview to inspect additions/changes/no-ops, before/after values, invalid rows and
identity/concurrency conflicts. If applying is authorized, reuse operation IDs and durable jobs/receipts
for retries. Imports create manually verified entries; retain the research evidence because successful
import alone is not official-page verification.

Each row is atomic; the file is not. Keep successful rows, report failed/conflicting rows and resume
pending work only. Check saved results and dependent listing/search projection completion; unchanged
resubmissions should not add writes. Refresh exports before editing changed catalog-derived listings.
Keep catalog research separate from ingestion defects: an import exposing a listing error does not
expand CSV-only scope or override a user's exclusion of listing updates.
