# Catalog research and import

Read the relevant CSV sections of [listing admin](../../../../docs/listing-admin.md), the current
[catalog CSV contract](../../../../src/admin/knowledge-catalog-csv.ts) and
[creation path](../../../../src/db/admin-csv-catalog-create.ts) before preparing a file.

1. Define the requested manufacturer/product/time scope and compare existing catalog identities
   with listing-derived gaps. Check official current and discontinued product indexes, manuals
   and product pages; record source URL, access date and what each source proves. Seller listings
   can nominate missing products but do not alone verify a canonical catalog identity. Do not
   infer unlisted finishes, dates, specifications or lifecycle status from a neighboring model.
2. Use the shared manufacturer registry, identity normalization and category definitions. Preserve
   suffixes/revisions and distinguish product name, model identity and finish. For an unfamiliar
   brand or conflict, keep a review candidate instead of inventing a verified ID or force-merging.
   An exhaustive request needs an enumerated source inventory, deduplication and explicit gaps;
   label a partial result rather than calling a large sample complete.
3. Use a current **編集用CSV** export. Preserve IDs, original columns and `csv_original` for
   existing records; edit only the supported `edit_*` fields. For additions use the contract's
   blank ID/original fields and required editable fields. Full-information ZIP/table CSVs are
   audit data with a different encoding and cannot be uploaded as editable CSVs.
4. Preserve UTF-8, the export's reversible escaping, leading zeros, model punctuation and original
   snapshots. Validate duplicates across the entire file and against current catalog identities.
   Do not force a stale before-image through an optimistic-concurrency conflict. The current
   contract owns field names, required values and batch/byte limits; avoid inventing color or
   specification columns just because another admin editor supports them.
5. Run the existing read-only preview. Inspect changed/addition/no-op counts, before/after values,
   invalid rows, duplicate identities and conflicts. If applying is authorized, use the same
   operation IDs and durable job/receipt flow for retry. Catalog imports create manually verified
   entries, so preserve the external research evidence; a successful import is not an independent
   official-page verification.
6. Check saved job results and affected listing/search projection completion. Each row is atomic;
   the whole file is not. Keep successful rows applied, report failed/conflicting rows, and resume
   only pending work. Unchanged resubmissions should not create new writes. Refresh exports before
   editing listings whose original catalog-derived values have changed.

Keep catalog research and ingestion-source fixes separate in reporting. Do not apply a listing
correction merely because a requested catalog import exposed it, particularly when the user has
excluded listing updates. Catalog edits may have their documented dependent projections; explain
that scope when it materially affects the requested operation.
