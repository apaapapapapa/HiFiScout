# Repeatable photo issue template

Use a parent for scope, ordering, coverage, child links and residuals. Use one execution issue per
batch (pilot 10, thereafter <=50). For future large phases, create a queue-planning issue that
enumerates bounded execution children before registration. Reuse the same manufacturer/wave/batch
issue. Never reset checked boxes for another run; create a new numbered batch for genuinely new scope.

```markdown
## Purpose and scope

Parent: #<parent>
Batch key: <wave>/<manufacturer>/<sequence>
Manufacturer: <canonical ID and name>
Scope: <in-stock-missing / all-missing / exact IDs>
Planned maximum: <10 or <=50>; planning baseline: <timestamp>.
Dependencies: <prior issues and reconciliation required>.
Exclude: IDs in <prior manifests>; preserve prior removals and existing photos.

## Start or resume

Use $hifiscout-catalog-photos from the current repository. Without native skill discovery, read
`.agents/skills/hifiscout-catalog-photos/SKILL.md` directly.
Read this issue and reports. Resume its saved manifest first. Initially freeze eligible target IDs
from current data, save durably, and post the link. Record actual size when estimates change.
Do not replace frozen scope on resume.

## Tasks

- [ ] Freeze IDs, before-images/revisions, source revision and batch ID; save manifest.
- [ ] Confirm exact official page, model/variant, actual image, publication conditions and credit.
- [ ] Save approved payloads and reasoned holds before registration.
- [ ] Apply within authorization with expectedRevision; record attempts/receipts.
- [ ] Read back all attempts; reconcile unknown outcomes/conflicts before retrying.
- [ ] Verify public image loading and representative search/detail/comparison displays.
- [ ] Save final states/residual reasons; reconcile counts; update parent and next batch.

## Completion report

Observation time:
Manifest URL / version:
Frozen count:
registered_verified / already_present_verified / held / conflict / failed /
pending_verification / apply_unknown / unprocessed:
Confirmed new-write receipts:
Readback and public checks:
Rows read/written (unknown stays unknown):
Residual-list link and recheck conditions:
Next batch / last enumerated ID:

Close only when every target has a verified outcome or a reasoned hold transferred to the parent.
Unresolved processing/verification remains open. Research completion is not 100% photo coverage.
```

Parent closure requires all accepted scope accounted for by completed child work and residuals.
Planning children/installing a skill does not complete data work. Reread before updates, preserve
others' edits and dated baselines, and report current coverage separately.
