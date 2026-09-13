---
name: hifiscout-catalog-maintenance
description: "HiFiScoutの製品調査・カタログCSV、メーカー/型番/カテゴリ・誤結合の修正、保存済み商品の再判定に使う。"
---

# HiFiScout catalog maintenance

Identify the target: catalog master, seller listings, classification/identity rules, search projection
or an editable CSV. Catalog creation adds no seller inventory; preparing a CSV applies no database update.

| Requested outcome | Read |
| --- | --- |
| Product research, catalog additions or CSV import | [research and import](references/research-and-import.md) |
| Correct classification/grouping or reprocess stored data | [resolution and replay](references/resolution-and-replay.md) |
| Understand the shared evidence model | Relevant sections of [data quality](../../../docs/data-quality.md) |

Keep product specifications separate from listing price, condition, warranty, included items, sale
units and stock. Preserve raw seller facts and explicit manual corrections; unknown evidence stays
unknown. Compatibility text alone does not establish the sale object's brand. Use current taxonomy,
manufacturer registry and shared resolvers. Reproduce bad extraction before calling a row error a
crawler defect; avoid row-by-row patches or duplicated regex rules for a shared problem.

Import/replay only within requested or existing authorization. Validate the concrete diff and use
current admin/job paths; CSV-only or review-only work does not authorize production listing changes.
Account for documented dependent projections when a catalog edit affects the requested operation.

Completion evidence follows the operation: researched scope/sources and gaps, preview/applied/skipped/
failed counts, conflicts and saved job/projection state as applicable. Separate a code fix from retained
data convergence. Exhaustive coverage needs an enumerated source inventory and accounted-for gaps.
