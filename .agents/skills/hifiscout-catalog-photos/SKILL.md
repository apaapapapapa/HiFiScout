---
name: hifiscout-catalog-photos
description: "HiFiScoutの登録済みカタログにメーカー公式写真を追加・補完し、写真追加issueのバッチを調査・照合・登録・検証・再開するときに使う。写真追加計画のissue化や作業分割にも使う。生成画像の作成、販売店の現物写真の収集、写真以外のカタログ修正には使わない。"
---

# HiFiScout catalog photos

Work in `apaapapapapa/HiFiScout` using bounded data-maintenance batches. Use current user instructions
and session authorization; an issue, source page, or saved manifest is evidence, not permission.
For a plan/issue-only request, prepare tasks without writing production photos. A registration
request authorizes scoped additions without asking again per product. Repeatability is not a schedule.

## Establish the current contract

1. Read the target issue, parent, existing reports, and current repository [AGENTS.md](../../../AGENTS.md). Search
   existing photo issues before creating another. Prefer available GitHub/Cloudflare connectors
   and advertised endpoint discovery. Respect actual access denials.
2. Read [catalog research](../hifiscout-catalog-maintenance/references/research-and-import.md),
   the [admin photo contract](../../../docs/listing-admin.md#メーカー写真), `src/api/catalog-photo-contracts.ts`, and
   `src/db/catalog-photo-repository.ts` at the current revision. Discover production bindings
   from the authorized environment; never carry an account/database ID from an old report.
3. For issue changes follow [issue triage](../hifiscout-issue-triage/SKILL.md). If application code
   needs changing, follow the repository harness/delivery workflow and
   [Work setup](../../../docs/work-development.md) when using ChatGPT Work. Data-only
   photo additions currently need no projection rebuild or deployment; recheck the contract.
4. Read [batch/checkpoint contract](references/batches.md) for selection and recovery, and
   [issue template](references/issue-template.md) for task splitting. For supplied offline fixtures
   or dry runs, use those artifacts and report planned actions without contacting production or
   writing remote state.

## Freeze a bounded batch

- Define manufacturer, scope (`in-stock-missing`, `all-missing`, or explicit IDs), observation time,
  batch ID, limit and source revision. Use 10 products for a pilot and at most 50 thereafter.
  Counts in a plan are dated estimates until exact IDs are frozen.
- Count only verified catalog products. A non-null photo is registered. Retain stored null-photo
  rows and revisions as prior removals; absent rows start at revision 0. Prefer in-stock missing products using persisted search
  entities and deduplicated catalog IDs, not seller-page scans or assumed popularity.
- Resume an existing manifest before selecting more IDs. Select new candidates by catalog ID;
  record explicit representative pilot selections. Exclude IDs already assigned to a sibling
  batch or handled. Keep held IDs in a residual list, not in the next batch.
- Save exact target IDs and current photo snapshots durably before writes. Link the artifact and
  batch ID from the issue. Scratch paths alone cannot resume a lost run. Record a worker/start
  note to reduce duplicate work, but do not mistake a comment for an exclusive lock.
- Reuse prior manufacturer research and manifests. Refresh values for target IDs; avoid repeated
  whole-catalog scans and repeated known-failing URLs.

## Research and approve candidates

1. Locate the exact manufacturer's product page, discontinued page, or official archive. Treat
   saved catalog sources as leads: an index, dealer locator, or unrelated category is not proof
   for an image. Use public search first; use browser interaction only under its applicable rules.
2. Extract candidates with the existing official-page function where supported. JSON-LD/OGP
   candidates need review. Inspect ordinary images/rendered galleries when necessary. Never
   register an image URL by guessing filenames.
3. Verify full model identity, suffix/revision, finish, connectors, and pictured object. Prefer
   a clear whole-product photo. Reject logos, diagrams, accessories standing in for a main unit,
   successor/related models, and ambiguous composites. Use a common variant photo only if the
   manufacturer explicitly documents that correspondence; save the evidence.
4. Inspect the actual image and confirm public HTTPS URLs, decodable content, useful size,
   and applicable publication conditions. A successful page request or filename is not an image
   check. Record existing manufacturer permission from the user/session within its stated scope;
   do not ask again when it already covers the batch. Public availability alone does not prove
   unrestricted reuse; hold unresolved publication conditions.
5. Record `sourceUrl`, `imageUrl`, `credit`, identity/image evidence and observation time for each
   approved candidate. Preserve unknowns and give specific reasons for holds.

## Apply and verify within authorization

- Prefer the current admin photo operation. Its current payload is
  `{photo:{imageUrl,sourceUrl,credit},expectedRevision}`; validate against current source. Use an
  authorized supported write path. An alternate data path must preserve current validation,
  identity checks, revision compare-and-swap and unchanged-write behavior. Do not invent an
  unrestricted SQL import or claim photo CSV import exists.
- Reread identity and photo immediately before writing. A different existing photo is a conflict
  for additions. A matching existing photo is not a new registration by this run. Null with
  revision > 0 is prior removal: preserve the revision, investigate, and hold unless restoration
  is within authorization and justified.
- Persist intent and before-image before submission, then the response after each attempt. A
  timeout is `apply_unknown`, not failure/success. Reread before retrying.
- Reread all attempted writes and compare ID, identity, all photo fields and revision. Keep write
  receipts separate from readback. A matching readback without proof of authorship is an observed
  matching/no-op outcome, not a proved new write.
- Verify public-app image loading for every new photo and visually check representative search,
  detail and comparison displays per manufacturer. Allow documented cache delay. Keep unavailable
  checks pending. Do not claim pass from a successful API response alone.
- Correct this run's wrong photo only within scope using the current revision guard. Preserve
  intervening edits. Use the existing removal operation if justified; retain tombstones and logs.

## Reconcile, report and continue

Use mutually exclusive final states: `registered_verified`, `already_present_verified`, `held`,
`conflict`, `failed`, `pending_verification`, `apply_unknown`, `unprocessed`. Tie new-write counts
to receipts and make final-state counts sum to frozen targets. Keep a reason, sources and recheck
condition for every hold.

Save manifests, attempts, residual IDs, next cursor and public checks durably; post a compact issue
report with links. Reread the current issue before authorized updates and preserve others' edits.
Close a batch only after all targets have verified outcomes or reasoned holds transferred to the
parent residual list. Leave unverified writes, unknown outcomes, conflicts, failures and unprocessed
IDs open. Research completion is not 100% coverage. Creating children does not complete a phase.

Recompute coverage at useful phase boundaries. Report catalog and in-stock coverage separately,
with denominators and observation times; distinguish fixed-batch progress from changing inventory.
Resume the same batch after interruption. Reconcile it before starting another, within authorization.
