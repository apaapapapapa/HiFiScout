---
name: hifiscout-catalog-maintenance
description: "HiFiScoutの製品カタログ追加、CSV監査、メーカー・型番・カテゴリ修正、誤結合/検索混入、既存商品の再判定を扱う。Use for catalog research/import and identity/classification quality; visual-only search UI work belongs to the UI skill."
---

# HiFiScout catalog maintenance

## Choose the operation

Identify the requested target: catalog master records, seller listings, classification/identity
rules, search projections or a prepared CSV. Inspect current schema/contracts and a bounded set
of representative records before deciding what needs changing. Catalog creation does not create
seller inventory, and editing a CSV is not an applied database update.

- For manufacturer/product research, catalog additions or editable CSVs, read
  [research and import](references/research-and-import.md).
- For incorrect names/categories/grouping, resolver changes or existing-data reprocessing, read
  [resolution and replay](references/resolution-and-replay.md).
- For the common model, consult [data quality](../../../docs/data-quality.md) and
  [data-platform architecture](../../../docs/data-platform-architecture.md). Read relevant sections,
  not the entire catalog or all historical incident reports.

## Preserve the evidence model

Keep catalog product specifications separate from listing-specific price, condition, warranty,
included items, sale units and stock. Preserve raw seller facts and explicit manual corrections;
missing evidence remains unknown. Do not overwrite seller evidence to make canonical values look
clean. Retain revision, accessory/bundle and presentation-color distinctions under the current
identity rules. A familiar manufacturer's name in compatibility text is not the sale object's brand.

Use current taxonomy leaves, facets and capability definitions from the code. Treat `unclassified`
as unresolved, not a category to select manually; do not create new canonical legacy `other` values.
Prefer shared resolvers and shop evidence contracts over product-by-product cleanup or new regex
copies. A corrected row alone does not prove a crawler defect: reproduce the bad extraction first.

An import/replay is a mutation only when requested or already authorized. Prepare and validate its
concrete diff first, and continue within that authorization without asking again. Review-only or
CSV-only scope does not authorize changing production inventory. Reuse current admin/import/job
paths; inspect bounded results and conflicts before continuing rather than blindly retrying a batch.

## Completion evidence

Record the source/export interval and scope, official references, proposed/applied/skipped/failed
counts, unresolved cases and affected projection/replay job state. Separate a completed code fix
from convergence of retained data. Do not claim every manufacturer/model/finish is covered without
an enumerated source inventory and accounted-for gaps. For implementation, finish with delivery;
for incomplete quality evidence, retain that limitation in the related issue.
