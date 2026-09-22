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
    sources: ["src/auctions/search.ts", "src/api/auction-query.ts", "src/http/auctions.ts"],
    suites: ["test/auction-search.test.ts"],
    samples: { "auction-search-page": d1(6100, 0, 2), "auction-search-filtered": d1(15000, 0, 2) },
    reason:
      "A bounded 25-offer SQLite DO page among 2,000 retained listings uses one lookahead, reads the runtime coverage, and performs no D1, seller or data writes. Admission reservations are separate from SQL observations.",
  },
  {
    id: "auction-admin",
    sources: ["src/auctions/admin.ts", "src/auctions/status.ts"],
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
      "src/crawler/resumable-*",
    ],
    suites: ["test/crawl-do-collection-progress.test.ts"],
    samples: {
      "crawl-do-retry": { environment: "local-mock", limits: { doAlarms: 3, doStorageWrites: 2 } },
    },
    reason:
      "Interrupted DO commit and duplicate Alarm preserve the seller receipt without another fetch.",
  },
  {
    id: "queue-redelivery",
    sources: ["src/worker.ts", "src/product-audit-export/*", "src/knowledge-catalog-export/*"],
    suites: ["test/queue-routing.test.ts"],
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
      "src/db/product-metadata-*",
      "src/db/product-identity-*",
      "src/db/public-meta-*",
    ],
    suites: [
      "test/observed-sql-read-budget.test.ts",
      "test/filtered-search-read-budget.test.ts",
      "test/d1-write-budget.test.ts",
      "test/public-meta-incremental.test.ts",
    ],
    samples: {
      "category-prune": d1(300, 0, 1),
      "search-new-total": d1(250, 0, 8),
      "search-price-drop-total": d1(250, 0, 8),
      // All five projection stages issue 34 statements; omitted stages are not a cheaper replay.
      "projection-unchanged": d1(200, 0, 34),
    },
    reason:
      "Selective counts and 40-entity pruning among 10,000 unrelated rows; unchanged listing/metadata/projection replay writes zero including indexes, triggers and sequences.",
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
