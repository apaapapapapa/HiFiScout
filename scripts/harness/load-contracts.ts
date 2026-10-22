import type { CostMetrics } from "./cost.js";

export interface LoadContract {
  id: string;
  /** Exact files or explicit trailing-* families. New unrelated repositories need a contract. */
  sources: string[];
  suites: string[];
  samples: Record<string, { environment: string; limits: CostMetrics }>;
  reason: string;
}

const d1 = (rowsRead: number, rowsWritten: number, sqlStatements: number) => ({
  environment: "local-workerd",
  limits: { rowsRead, rowsWritten, sqlStatements },
});

/** Reviewed ceilings, not observations or estimates of account-wide production consumption. */
export const LOAD_CONTRACTS: LoadContract[] = [
  {
    id: "saved-search-notifications",
    sources: [
      "src/notifications/*",
      "src/db/notification-candidates.ts",
      "src/db/specification-search.ts",
      "src/http/notifications.ts",
    ],
    suites: [
      "test/notification-query.test.ts",
      "test/notification-runtime.test.ts",
      "test/notification-policy.test.ts",
      "test/notification-crypto.test.ts",
    ],
    samples: {
      "notification-candidates": d1(50, 0, 1),
      "notification-matches": d1(1000, 0, 1),
      "notification-outbox-replay": d1(10, 0, 5),
    },
    reason:
      "Twenty indexed listing changes and same-offer matching among 10,000 unrelated rows write no D1 data. Durable SQLite outbox replays write zero rows. Daily persisted budgets and limited retries bound the independent scheduler; offline observations do not certify production capacity.",
  },
  {
    id: "hifido-parser",
    sources: ["src/crawler/shops/hifido.ts"],
    suites: [
      "test/hifido.test.ts",
      "test/parser.test.ts",
      "test/product-data-audit-parser-regressions.test.ts",
      "test/html-raw-text.test.ts",
    ],
    // CPU samples and ceilings belong to the mandatory paired gate, not a single-session budget.
    samples: {},
    reason:
      "Hifido extraction preserves factual fields and hidden-text boundaries. Required cpu-hifido-parse and cpu-hifido-normalize samples retain their existing same-runner paired CPU ceilings and regression checks.",
  },
  {
    id: "auction-storage",
    sources: ["src/auctions/*", "src/crawler/types.ts"],
    suites: ["test/auction-runtime.test.ts"],
    samples: {
      "auction-replay": d1(5, 0, 1),
      "auction-price-change": d1(20, 20, 2),
    },
    reason:
      "SQLite-backed auction DO replay writes zero rows; price updates preserve static attributes and FTS. Real workerd SQL rows are separate from production billing.",
  },
  {
    id: "auction-catalog",
    sources: ["src/auctions/catalog.ts", "src/db/auction-catalog-repository.ts"],
    suites: ["test/auction-catalog.test.ts", "test/auction-catalog-runtime.test.ts"],
    samples: {
      "auction-catalog-shared": d1(40, 0, 8),
      "auction-catalog-replay": d1(10, 0, 3),
    },
    reason:
      "Bounded shared D1 candidate lookup is independent of duplicate auction count. Price-only updates reuse the SQLite candidate snapshot with zero writes and no D1 lookup.",
  },
  {
    id: "auction-search",
    sources: [
      "src/auctions/search.ts",
      "src/api/auction-query.ts",
      "src/http/auctions.ts",
      "src/http/router.ts",
    ],
    suites: ["test/auction-search.test.ts", "test/auction-http.test.ts"],
    samples: { "auction-search-page": d1(6100, 0, 2), "auction-search-filtered": d1(15000, 0, 2) },
    reason:
      "A bounded 25-offer SQLite DO page among 2,000 retained listings uses one lookahead, reads the runtime coverage, and performs no D1, seller or data writes. Admission reservations are separate from SQL observations.",
  },
  {
    id: "auction-admin",
    sources: [
      "src/auctions/admin.ts",
      "src/auctions/status.ts",
      "src/api/admin-auction-contracts.ts",
      "src/admin/entry.ts",
      "src/worker.ts",
    ],
    suites: ["test/auction-admin-runtime.test.ts"],
    samples: { "auction-admin-status": d1(10100, 0, 6) },
    reason:
      "SQLite DO administrative counts stay bounded by retained items/tasks/candidate keys and remain distinct from unknown production billing. Alarm operations are observed separately.",
  },
  {
    id: "crawl-checkpoints",
    sources: ["src/db/crawl-fetch-*", "src/crawler/collection-progress.ts"],
    suites: ["test/d1-crawl-checkpoint-budget.test.ts", "test/d1-crawl-collection-budget.test.ts"],
    samples: {
      "crawl-checkpoint-inline": d1(240, 200, 70),
      "crawl-checkpoint-split": d1(350, 300, 110),
    },
    reason:
      "Complete 20-page collection checkpoints; duplicate delivery must preserve progress and write zero rows.",
  },
  {
    id: "crawl-recovery",
    sources: [
      "src/crawler/crawl-scheduler*",
      "src/crawler/crawl-continuation.ts",
      "src/crawler/direct-pacing.ts",
      "src/crawler/resumable-*",
    ],
    suites: ["test/crawl-do-collection-progress.test.ts", "test/crawl-do-inventory-batch.test.ts"],
    samples: {
      "crawl-do-retry": { environment: "local-mock", limits: { doAlarms: 3, doStorageWrites: 2 } },
    },
    reason:
      "Interrupted DO commit and duplicate Alarm preserve the seller receipt without another fetch.",
  },
  {
    id: "queue-redelivery",
    sources: [
      "src/worker.ts",
      "src/product-audit-export/*",
      "src/knowledge-catalog-export/*",
      "src/db/product-audit-export-job-repository.ts",
      "src/db/knowledge-catalog-export-job-repository.ts",
      "src/db/data-export-job-lifecycle.ts",
      "src/export/complete-csv.ts",
    ],
    suites: [
      "test/queue-routing.test.ts",
      "test/product-audit-export-job.test.ts",
      "test/knowledge-catalog-export-core.test.ts",
      "test/complete-data-export.test.ts",
      "test/export-chunk-recovery.test.ts",
    ],
    samples: {
      "queue-export-redelivery": {
        environment: "local-mock",
        limits: { queueSends: 0, queueRetries: 0 },
      },
    },
    reason:
      "Duplicate export delivery does not amplify Queue messages; absent jobs are acknowledged.",
  },
  {
    id: "search-and-projection",
    sources: [
      "src/db/product-search-*",
      "src/db/product-write-*",
      "src/crawler/category-enricher.ts",
      "src/db/product-metadata-*",
      "src/db/product-identity-*",
      "src/db/public-meta-*",
      "src/crawler/run.ts",
      "src/crawler/crawl-stages.ts",
    ],
    suites: [
      "test/observed-sql-read-budget.test.ts",
      "test/filtered-search-read-budget.test.ts",
      "test/scoped-search-sort-budget.test.ts",
      "test/d1-write-budget.test.ts",
      "test/public-meta-incremental.test.ts",
      "test/product-search-catalog-offer-budget.test.ts",
      "test/crawl-deactivation-budget.test.ts",
      "test/category-detail-cache-identity.test.ts",
      "test/stale-listing-expiry.test.ts",
      "test/crawl-stale-expiry.test.ts",
    ],
    samples: {
      "category-prune": d1(300, 0, 1),
      "search-new-total": d1(250, 0, 8),
      "search-price-drop-total": d1(250, 0, 8),
      // All five projection stages issue 34 statements; omitted stages are not a cheaper replay.
      "projection-unchanged": d1(200, 0, 34),
      // One 29-listing chunk: lookups, one projection batch and one refresh batch.
      "search-sync-catalog-offers-100": d1(4000, 0, 51),
      "search-sync-catalog-offers-1000": d1(4000, 0, 51),
      "search-sync-catalog-offers-10000": d1(4000, 0, 51),
      // 50 missing listings: their rows, indexes and deactivation triggers, never the shop's rest.
      "crawl-deactivate-missing-100": d1(1000, 700, 1),
      "crawl-deactivate-missing-1000": d1(1000, 700, 1),
      "crawl-deactivate-missing-10000": d1(1000, 700, 1),
      // 50 long-unseen listings deactivated and 50 aging ones downgraded: two index seeks, the
      // deactivation's triggers and one chunked update, never the shop's recently seen rest.
      "crawl-expire-stale-100": d1(2000, 1000, 4),
      "crawl-expire-stale-1000": d1(2000, 1000, 4),
      "crawl-expire-stale-10000": d1(2000, 1000, 4),
    },
    reason:
      "Selective counts and 40-entity pruning among 10,000 unrelated rows; unchanged listing/metadata/projection replay writes zero including indexes, triggers and sequences. A scoped entity sync reads the same rows whether 100 or 10,000 other listings hold catalog matches. Deactivating a crawl's missing listings costs the same with 100 or 10,000 other active listings in the shop. Expiring a partial-coverage shop's long-unseen listings seeks the active last-seen index from its oldest entry and costs the same with 100 or 10,000 recently seen listings in the shop. A detail-classified listing is fetched and rewritten once, not again on every crawl, whatever its manufacturer resolution.",
  },
  {
    id: "category-change-replay",
    sources: [
      "src/catalog/category-change.ts",
      "src/catalog/category-classifier.ts",
      "src/db/knowledge-catalog-repository.ts",
      "src/db/product-write-repository.ts",
      "src/db/product-metadata-repository.ts",
    ],
    suites: [
      "test/category-repeat-write-budget.test.ts",
      "test/product-write-repository.test.ts",
      "test/product-metadata.test.ts",
      "test/knowledge-catalog-reclassification.test.ts",
      "test/category-enrichment-determinism.test.ts",
    ],
    samples: Object.fromEntries(
      [100, 1000, 10000].flatMap((size) => [
        [`category-override-unchanged-${size}`, d1(size * 8, 0, Math.ceil(size / 20))],
        [`category-override-few-price-${size}`, d1(size * 9, size * 0.15, Math.ceil(size * 0.07))],
        [`category-override-many-price-${size}`, d1(size * 40, size * 12, Math.ceil(size * 2.1))],
      ]),
    ),
    reason:
      "Manual category authority participates in the crawl diff: identical observations write zero; a 1% or near-total price change updates only those listings and history immediately. Shared classification evidence is order invariant. Catalog reclassification uses the same evidence decision, compares the full category result and atomically fences dependent writes; stale snapshots do no work and failed projections resume from their durable token.",
  },
  {
    id: "data-quality-snapshot",
    sources: ["src/db/data-quality-repository.ts"],
    suites: [
      "test/data-quality-snapshot-budget.test.ts",
      "test/data-quality-snapshot-coverage.test.ts",
    ],
    samples: Object.fromEntries([
      ...[1000, 5000].map((size) => [`dq-snapshot-unchanged-${size}`, d1(40, 6, 3)]),
      ...[1000, 5000].map((size) => [`dq-snapshot-changed-${size}`, d1(size * 2 + 40, 6, 4)]),
    ]),
    reason:
      "Re-evaluating a shop whose trigger-maintained quality revision and aggregate definition still match its newest snapshot reuses those counts through one indexed probe, whatever the shop's active, inactive or other-shop inventory. A moved input re-aggregates at about one index entry and one Identity probe per active listing, with no per-listing category IN-list probes.",
  },
  {
    id: "catalog-photos",
    sources: [
      "src/db/catalog-photo-repository.ts",
      "src/db/catalog-product-detail-repository.ts",
      "src/db/knowledge-catalog-admin-operations.ts",
      "src/http/product-permalink.ts",
    ],
    suites: ["test/catalog-photo.test.ts", "test/catalog-photo-budget.test.ts"],
    samples: {
      "catalog-photo-search-100": d1(200, 0, 8),
      "catalog-photo-search-10000": d1(200, 0, 8),
      "catalog-photo-replay": d1(20, 0, 1),
      "catalog-photo-update": d1(20, 1, 3),
    },
    reason:
      "Manufacturer photos use primary-key lookups in the existing page query. Unrelated photo growth stays bounded; identical edits write zero; revision guards and atomic merges preserve concurrent work.",
  },
  {
    id: "catalog-hydration",
    sources: ["src/db/catalog-lookup-*"],
    suites: ["test/catalog-row-loader-budget.test.ts"],
    samples: Object.fromEntries(
      [100, 1000, 10000].map((size) => [`catalog-rows-${size}`, d1(200, 0, 2)]),
    ),
    reason:
      "40 requested IDs remain bounded with 100, 1,000 and 10,000 unrelated verified products; duplicate IDs and result semantics are preserved.",
  },
  {
    id: "catalog-remediation",
    sources: ["src/db/knowledge-catalog-remediation-repository.ts"],
    suites: [
      "test/knowledge-catalog-remediation.test.ts",
      "test/maintenance-read-budget.test.ts",
      "test/remediation-query-plans.test.ts",
      "test/catalog-remediation-backlog-budget.test.ts",
      "test/knowledge-catalog-remediation-limit.test.ts",
    ],
    samples: Object.fromEntries([
      ...[100, 1000, 10000].map((size) => [`catalog-remediation-${size}`, d1(60, 0, 1)]),
      ...[100, 1000, 10000].map((size) => [`catalog-remediation-backlog-${size}`, d1(60, 10, 18)]),
    ]),
    reason:
      "Verified catalog replay seeks complete exact-identity index prefixes and merges page-bounded streams. Matching and unrelated identity growth retain constant read cost, cursor order and zero writes. The finalizer's backlog selector and count walk a partial index of owed entries, so replayed-entry growth adds no reads.",
  },
  {
    id: "catalog-duplicates",
    sources: ["src/db/knowledge-catalog-duplicate-repository.ts"],
    suites: [
      "test/knowledge-catalog-duplicates.test.ts",
      "test/knowledge-catalog-duplicates-budget.test.ts",
      "test/knowledge-catalog-identity-dedup.test.ts",
    ],
    samples: Object.fromEntries(
      [100, 1000, 10000].map((size) => [`catalog-duplicates-${size}`, d1(60, 0, 1)]),
    ),
    reason:
      "Duplicate pages for the admin screen and the finalizer's convergence pass read the trigger-maintained bucket projection; unrelated verified singletons add no reads and the page writes nothing.",
  },
  {
    id: "catalog-candidate-publication",
    sources: [
      "src/db/knowledge-catalog-candidate-refresh.ts",
      "src/db/knowledge-catalog-review-repository.ts",
    ],
    suites: [
      "test/knowledge-catalog-candidate-write-budget.test.ts",
      "test/knowledge-catalog-accumulator-diff.test.ts",
      "test/knowledge-catalog-candidate-diff.test.ts",
      "test/knowledge-catalog-candidate-refresh.test.ts",
    ],
    samples: Object.fromEntries(
      [100, 1000, 10000].flatMap((size) => [
        [`candidate-publication-unchanged-${size}`, d1(5 * size, 0, (2 * size) / 100)],
        [`candidate-publication-timestamps-${size}`, d1(7 * size, 3 * size, (2 * size) / 100)],
        [`candidate-publication-few-changes-${size}`, d1(5 * size, 0.08 * size, (2 * size) / 100)],
        [`candidate-publication-many-changes-${size}`, d1(11 * size, 5 * size, (2 * size) / 100)],
      ]),
    ),
    reason:
      "Unchanged candidate publication and equal accumulator replay write zero. Observation-only updates retain exact timestamps through a narrow UPDATE instead of rewriting every status/category index; two statements per 100 candidates share the existing batch roundtrip. Attribute changes, manual ignore, linked verified identities and generation fencing remain guarded. Extra unchanged reads are bounded explicitly, and no temporary membership table or new queue is introduced.",
  },
  {
    id: "catalog-verification-queue",
    sources: [
      "src/db/knowledge-catalog-verification-queue-repository.ts",
      "src/knowledge-catalog/consumer.ts",
      "src/knowledge-catalog/dispatch.ts",
      "src/knowledge-catalog/types.ts",
      "src/db/knowledge-catalog-candidate-refresh.ts",
      "src/db/knowledge-catalog-review-repository.ts",
      "src/db/knowledge-catalog-verification-repository.ts",
    ],
    suites: [
      "test/knowledge-catalog-verification-claim-budget.test.ts",
      "test/knowledge-catalog-verification-claim-equivalence.test.ts",
      "test/knowledge-catalog-verification-queue-behavior.test.ts",
      "test/knowledge-catalog-run-wakeup.test.ts",
      "test/knowledge-catalog-candidate-refresh.test.ts",
      "test/knowledge-catalog-verification-dispatch.test.ts",
      "test/knowledge-catalog-candidate-selection.test.ts",
      "test/knowledge-catalog-stranded-review-run.test.ts",
      "test/control-plane-query-plans.test.ts",
    ],
    samples: Object.fromEntries([
      ...[100, 1000, 10000].map((size) => [`catalog-verification-claim-${size}`, d1(100, 10, 4)]),
      ...(
        [
          ["interleaved", d1(340, 10, 5)],
          ["dominant", d1(130, 10, 5)],
          ["backoff", d1(300, 10, 5)],
        ] as const
      ).flatMap(([shape, limits]) =>
        [50, 200, 800].map((size) => [`catalog-verification-live-claim-${shape}-${size}`, limits]),
      ),
      ["catalog-verification-live-claim-spread-20", d1(420, 10, 5)],
      ["catalog-verification-live-claim-spread-60", d1(1170, 10, 5)],
    ]),
    reason:
      "A run-scoped claim and wake-state read seek live job statuses and target job types, so finished jobs in the run and older runs add no reads to each claim. Claims and the wait after an empty claim enumerate the run's waiting domains through a partial index and read each free domain's earliest due job, so their reads follow the run's domains: further live jobs on an enumerated domain, paced or waiting out a retry, add none, while each waiting domain costs a few index reads per claim and wait even when it holds a single job, which suits daily runs drawn from the registered manufacturer domains. Both choose exactly what the former per-job selectors chose. Only the once-per-invocation outstanding count reads one index entry per live job.",
  },
  {
    id: "inventory-recheck",
    sources: [
      "src/db/inventory-recheck-repository.ts",
      "src/db/types.ts",
      "src/crawler/inventory-recheck.ts",
      "src/crawler/shops/*-inventory.ts",
    ],
    suites: [
      "test/inventory-recheck-candidate-budget.test.ts",
      "test/inventory-recheck-repository.test.ts",
      "test/inventory-recheck.test.ts",
      "test/shop-inventory-classifiers.test.ts",
    ],
    samples: Object.fromEntries(
      [1000, 5000].flatMap((size) =>
        ["confirmation", "never-attempted", "oldest-attempt"].map((scenario) => [
          `inventory-recheck-${scenario}-${size}`,
          d1(20, 0, 1),
        ]),
      ),
    ),
    reason:
      "Each recheck's PREPARE and FETCH pick one candidate: first a due confirmation of an earlier unavailable result through a partial index holding only listings with a failure, then, through the active-listing attempt index, never-attempted stale listings by last_seen_at and the oldest attempt within the retry window. Unavailable listings rechecked within the retry interval add no reads. Recently seen never-attempted listings and listings checked within the retry interval add no reads; a listing seen again after an older check costs one index entry until it is stale again. The selection order is unchanged and the read writes nothing.",
  },
  {
    id: "manufacturer-alias-evidence",
    sources: ["src/db/manufacturer-repository.ts"],
    suites: [
      "test/manufacturer-alias-snapshot.test.ts",
      "test/manufacturer-alias-cache.test.ts",
      "test/manufacturer-alias-scope.test.ts",
      "test/manufacturer-repository.test.ts",
    ],
    samples: {
      "manufacturer-alias-fresh-isolate-100": d1(5, 0, 1),
      "manufacturer-alias-fresh-isolate-1000": d1(5, 0, 1),
      // 1,136 stored aliases: the revision with its absent snapshot, the full scan, one write.
      "manufacturer-alias-rebuild-1000": d1(3700, 1, 3),
    },
    reason:
      "A fresh isolate reads resolver-visible alias evidence from one persisted snapshot row keyed by the trigger-maintained registry clock and the query definition, so its cost does not grow with the alias tables. Only while no snapshot of the current revision and query is stored does a load scan every alias, its table row and its manufacturer; the first conditional write stores it, in no more round trips than the former load.",
  },
  {
    id: "retention-and-schema",
    sources: ["src/maintenance.ts", "migrations/*"],
    suites: [
      "test/retention-crawl-run-read-budget.test.ts",
      "test/d1-write-budget.test.ts",
      "test/maintenance-read-budget.test.ts",
      "test/observed-sql-read-budget.test.ts",
    ],
    samples: Object.fromEntries(
      [100, 1000, 10000].map((size) => [`retention-history-${size}`, d1(3000, 500, 12)]),
    ),
    reason:
      "500 parent deletions must not scan unrelated foreign-key history; all migrations, index writes and trigger effects participate in real local D1 tests.",
  },
  {
    id: "schedule-and-continuation",
    sources: [
      "src/scheduled.ts",
      "src/config.ts",
      "src/db/invocation-budget.ts",
      "src/db/scheduled-maintenance-*",
      "src/crawler/schedule.ts",
      "src/crawler/crawl-window.ts",
      "src/crawler/shops/index.ts",
      "wrangler*.jsonc",
    ],
    suites: [
      "test/load-schedule-budget.test.ts",
      "test/scheduled-invocation-budget.test.ts",
      "test/scheduled-catalog-dispatch-budget.test.ts",
      "test/crawl-daily-schedule.test.ts",
    ],
    samples: {
      "maintenance-continuation": {
        environment: "local-mock",
        limits: { d1Calls: 72, sqlStatements: 72 },
      },
      "daily-schedule": {
        environment: "local-mock",
        limits: { scheduledInvocations: 391, crawlDispatches: 61, plannedPages: 1800 },
      },
    },
    reason:
      "A complete day of configured Cron slots, per-shop page ceilings, plus six bounded recovery ticks with durable progress and no starvation. Planned pages are a scenario bound, not observed HTTP traffic.",
  },
];

export const LOAD_SAMPLE_BUDGETS = Object.fromEntries(
  LOAD_CONTRACTS.flatMap((contract) => Object.entries(contract.samples)),
);

export const LOAD_CAPTURE_SUITES = [
  ...new Set(LOAD_CONTRACTS.flatMap((contract) => contract.suites)),
];
