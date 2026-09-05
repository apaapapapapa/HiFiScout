# R2 Evidence Archive safety limits

This policy covers selected diagnostic/verification HTML evidence in R2. Normal successful crawl HTML is not archived. CSV exports also use the bucket, with separate job limits, prefixes, and lifecycle rules described in [Data platform architecture](./data-platform-architecture.md#asynchronous-admin-csv-generation).

The application applies safety controls before every R2 write. These controls are intentionally configurable and do not hard-code Cloudflare's current free-tier limits, which may change independently of the application.

Successful DO listing collection stores parsed products, and new detail plans store extracted
category evidence, without retaining full HTML. A failed listing parser can archive its actual
input as one bounded `parser_failure` sample before the run is marked failed. Staged publication
has no original seller HTML and never archives its synthetic transport wrapper. Unresolved
classification and inventory-count diagnostics at that boundary use structured products and logs;
they do not manufacture an HTML snapshot. Direct crawls with real seller HTML and Knowledge
Catalog verification retain their existing reason-specific evidence policies.

Keeping a smaller JSON payload reduces storage/serialization, but D1's row allowance depends on
written rows, not bytes. The combined listing checkpoint also removes the intermediate page and
session updates. `test/d1-write-budget.test.ts` compares both paths with real workerd D1 accounting,
including index writes; this is a regression gate, not a substitute for production usage metrics.

## Default controls

| Setting | Default | Behavior |
| --- | ---: | --- |
| `EVIDENCE_MAX_BYTES` | 1,500,000 bytes | Maximum size of one archived object after sanitization |
| `EVIDENCE_DAILY_MAX_OBJECTS` | 500 | Hard cap on archived objects across all shops per UTC day |
| `EVIDENCE_DAILY_MAX_BYTES` | 200,000,000 bytes | Hard cap on archived bytes across all shops per UTC day |
| `EVIDENCE_SHOP_DAILY_MAX_OBJECTS` | 100 | Hard cap per shop per UTC day |
| `EVIDENCE_BURST_WINDOW_MINUTES` | 15 | Window used to detect repeated same-shop/same-reason evidence |
| `EVIDENCE_BURST_MAX_OBJECTS` | 20 | Number of same-shop/same-reason objects allowed in the burst window before sampling |
| `EVIDENCE_BURST_SAMPLE_RATE` | 10 | After the burst threshold, deterministically keep roughly one in this many distinct payloads |
| `EVIDENCE_STORAGE_WARNING_BYTES` | 8,000,000,000 bytes | Emit a structured warning when estimated unexpired archived bytes reach this threshold |

Hard caps suppress only Evidence Archive writes. They never fail the crawler or product database update path.

## Evaluation order

For an archiveable event:

1. sanitize and apply the per-object size limit;
2. hash the content and skip an existing non-expired duplicate;
3. read bounded usage counters from D1 metadata;
4. enforce global daily object/byte caps and the per-shop daily object cap;
5. after a repeated-event burst threshold, apply deterministic hash-based sampling;
6. emit a storage warning if the configured warning threshold is reached;
7. write the object to R2 and persist `content_bytes` in D1 metadata.

This ordering avoids spending R2 Class A operations on duplicate or suppressed objects.

## Observability

Structured logs use:

- `evidence_archive_suppressed` with `suppressionReason` for hard-cap and sampling decisions;
- `evidence_storage_warning` when the configured estimated storage threshold is reached;
- existing `evidence_archived` and `evidence_archive_failure` events for successful and failed writes.

The data-platform status repository calculates `evidenceEstimatedBytes` from non-expired Evidence Archive metadata. The old public `/api/admin/data-platform/status` route is retired; use maintained operational scripts and Cloudflare observability. Cloudflare-native R2 storage and operation metrics remain the source of truth for billing/actual platform usage; the D1 value is an application-side estimate used for operational safety.

## Operational policy

The defaults are intended as runaway protection rather than a promise that billing can never occur. If Cloudflare pricing/free-tier limits change, adjust the configured thresholds after reviewing current platform usage rather than changing domain logic.
