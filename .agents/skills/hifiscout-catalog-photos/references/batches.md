# Batch and checkpoint contract

## Read-only selection

Verify names/indexes against current source. Use bound parameters and the actual authorized
production binding. This query proposes an in-stock additions page; it does not freeze a batch,
prove image eligibility, exclude sibling manifests, or authorize writes.

```sql
SELECT p.id, p.manufacturer_id, p.canonical_model,
       f.photo_json, COALESCE(f.revision, 0) AS revision
FROM knowledge_catalog_products p
LEFT JOIN catalog_product_photos f ON f.catalog_product_id = p.id
WHERE p.verification_status = 'verified'
  AND p.manufacturer_id = ? AND p.id > ?
  AND f.photo_json IS NULL
  AND EXISTS (
    SELECT 1 FROM product_search_entities e
    WHERE e.catalog_product_id = p.id AND e.in_stock_offer_count > 0
  )
ORDER BY p.id
LIMIT ?;
```

Bind manufacturer ID, last enumerated ID and limit <=50. For an authorized all-missing scope omit
only the stock EXISTS predicate. Filter assigned IDs using durable sibling manifests. Save cursor
progress even when a page contains only handled IDs; never advance beyond unrecorded candidates.
Save explicit representative pilot IDs; later batches exclude them regardless of ID order.

Null-photo rows with positive revision need prior-removal review; absent rows have revision 0.
Fetch sources/readback for selected IDs in bounded requests, not full scans for each row.

## Durable manifest

Keep one manifest per batch and preserve identity/version on updates. JSON is suitable; tabular
exports are review artifacts, not photo-import CSVs. Save through an available durable artifact
mechanism and link it from the issue. If persistence fails, begin no new writes; reconcile any
already-attempted outcomes and report the failure.

| Level | Fields |
| --- | --- |
| Batch | schemaVersion, batchId, issueUrl, parentIssueUrl, manufacturerId, scope, sourceRevision, observedAt, targetIds, limit, lastEnumeratedId, priorBatchIds, artifactVersion |
| Row identity | catalogProductId, manufacturerId, canonicalModel, verificationStatus |
| Before image | photo, revision, observedAt |
| Candidate | imageUrl, sourceUrl, credit, identityEvidence, imageEvidence, publicationConditionEvidence, checkedAt |
| Attempt | intendedPayload, expectedRevision, startedAt, response/receipt, outcomeKnown, rowsRead/rowsWritten when observed |
| Final outcome | state, reason, readback, readbackAt, publicImageCheck, UI sample references, nextAction |

Key rows by catalog ID. Preserve manifest versions and attempt history. Keep secrets, credentials,
signed admin URLs and personal account identifiers out of public issues/artifacts.

## Recovery decisions

| Observation | Action |
| --- | --- |
| Approved, no attempt, unchanged snapshot | Apply once with recorded expectedRevision within authorization |
| Timeout; current photo equals intent | Record observed convergence; prove a new write only with receipt; verify display |
| Timeout; original snapshot/revision unchanged | Record reread and retry same intent once through supported operation |
| Timeout; identity or snapshot changed differently | Mark conflict, preserve current state, investigate |
| Confirmed write; public checks incomplete | Resume verification, not registration |
| Matching existing photo from another run | Verify and count already_present_verified, not a new write |
| Different existing photo | Conflict for additions; never auto-replace |
| Null photo with revision > 0 | Review removal; hold without restoration evidence/authority |
| Held; no new evidence | Carry reason forward; do not repeat the same failed retrievals |
| Manifest missing after interruption | Recover linked durable version/receipts; never select a replacement batch |

If a retry again has an unknown response, reconcile and leave open rather than looping. A matching
photo does not prove authorship. HTTP 200 alone proves neither an image body nor public browser loading.

## Accounting and completion

For N frozen targets require:

`N = registered_verified + already_present_verified + held + conflict + failed + pending_verification + apply_unknown + unprocessed`.

Final row states are exclusive; attempt history is not. Reason codes can include
`official_photo_unconfirmed`, `identity_or_variant_ambiguous`, `unavailable_image`, `access_restricted`,
`diagram_only`, `publication_conditions_unconfirmed`, `prior_removal`, `catalog_identity_review`.
Unconfirmed does not mean nonexistent.

Closure requires conflict/failed/pending_verification/apply_unknown/unprocessed all zero, with every
hold in a durable residual list linked from the parent. Dated issue counts are estimates; frozen IDs
are actual scope. Document smaller eligible remainders instead of filling with unrelated products.
An unexpectedly larger remainder becomes a new linked batch.
