import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { compactSupersededAutomaticRemediationJobs } from "../src/db/data-quality-remediation-compaction.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

interface ReplayStatusRow {
  active_listings: number;
  stale_manufacturer: number;
  stale_model: number;
  stale_category: number;
  stale_identity: number;
  projection_dirty: number;
}

interface QueueStatusRow {
  pending: number;
  processing: number;
  resolved: number;
  failed: number;
}

interface ReplayStatus {
  versions: typeof RESOLUTION_VERSIONS;
  activeListings: number;
  stale: {
    manufacturer: number;
    model: number;
    category: number;
    identity: number;
    projection: number;
    total: number;
  };
  queue: {
    pending: number;
    processing: number;
    resolved: number;
    failed: number;
  };
}

interface DrainResult {
  compacted: number;
  complete: boolean;
  remaining: number;
  initial: ReplayStatus;
  final: ReplayStatus;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function replayStatus(db: QueryableDatabase): Promise<ReplayStatus> {
  const versions = RESOLUTION_VERSIONS;
  const [stale, queue] = await Promise.all([
    db
      .prepare(`
        SELECT
          COUNT(*) AS active_listings,
          SUM(CASE WHEN p.manufacturer_resolver_version < ? THEN 1 ELSE 0 END) AS stale_manufacturer,
          SUM(CASE WHEN p.model_resolver_version < ? THEN 1 ELSE 0 END) AS stale_model,
          SUM(CASE
            WHEN COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0) < ?
            THEN 1 ELSE 0 END) AS stale_category,
          SUM(CASE WHEN COALESCE(r.identity_resolver_version, 0) < ? THEN 1 ELSE 0 END) AS stale_identity,
          SUM(CASE WHEN p.remediation_projection_required = 1 THEN 1 ELSE 0 END) AS projection_dirty
        FROM products p
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
        WHERE p.is_active = 1
      `)
      .bind(versions.manufacturer, versions.model, versions.category, versions.identity)
      .first<ReplayStatusRow>(),
    db
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM data_quality_remediation_queue
      `)
      .first<QueueStatusRow>(),
  ]);

  const safeStale = stale || {
    active_listings: 0,
    stale_manufacturer: 0,
    stale_model: 0,
    stale_category: 0,
    stale_identity: 0,
    projection_dirty: 0,
  };
  const safeQueue = queue || { pending: 0, processing: 0, resolved: 0, failed: 0 };
  const staleTotal =
    Number(safeStale.stale_manufacturer || 0) +
    Number(safeStale.stale_model || 0) +
    Number(safeStale.stale_category || 0) +
    Number(safeStale.stale_identity || 0) +
    Number(safeStale.projection_dirty || 0);

  return {
    versions,
    activeListings: Number(safeStale.active_listings || 0),
    stale: {
      manufacturer: Number(safeStale.stale_manufacturer || 0),
      model: Number(safeStale.stale_model || 0),
      category: Number(safeStale.stale_category || 0),
      identity: Number(safeStale.stale_identity || 0),
      projection: Number(safeStale.projection_dirty || 0),
      total: staleTotal,
    },
    queue: {
      pending: Number(safeQueue.pending || 0),
      processing: Number(safeQueue.processing || 0),
      resolved: Number(safeQueue.resolved || 0),
      failed: Number(safeQueue.failed || 0),
    },
  };
}

function isAutomaticSeedSelector(sql: string): boolean {
  return (
    sql.includes("WITH candidates AS") &&
    sql.includes("FROM keyed k") &&
    sql.includes("data_quality_remediation_queue q") &&
    sql.includes("'auto:")
  );
}

function emptyRowsStatement(): D1PreparedStatement {
  const emptyResult = () =>
    ({ success: true, results: [], meta: { changes: 0 } }) as unknown as D1Result<unknown>;
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => emptyResult(),
    run: async () => emptyResult(),
    raw: async () => [],
  };
  return statement as unknown as D1PreparedStatement;
}

/**
 * The production backlog already has durable queue rows. Re-running all five stale selectors before
 * every one-listing claim wastes REST calls and can hit the Cloudflare API rate limit. This wrapper
 * suppresses only those selector reads. If no claim is available while stale signals remain, the
 * drain performs one sweep against the unwrapped database to top the queue up normally.
 */
function existingQueueOnlyDatabase(db: QueryableDatabase): QueryableDatabase {
  return {
    prepare(sql: string) {
      return isAutomaticSeedSelector(sql) ? emptyRowsStatement() : db.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      return db.batch(statements);
    },
  } as QueryableDatabase;
}

async function writeResult(path: string, result: DrainResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const maxSweeps = positiveInteger(argument("--max-sweeps", "24"), "--max-sweeps");
  const output = argument("--output", ".generated/remediation-drain-result.json");
  const database = createD1RestDatabase({
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnv("D1_DATABASE_ID"),
    apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  });
  const queueOnlyDatabase = existingQueueOnlyDatabase(database);

  const compacted = await compactSupersededAutomaticRemediationJobs(database);
  console.log(`Resolved ${compacted} superseded automatic queue jobs before this drain batch.`);

  const initial = await replayStatus(database);
  const initialFailed = initial.queue.failed;
  console.log("Initial replay status after compaction:");
  console.log(JSON.stringify(initial, null, 2));

  let current = initial;
  for (let iteration = 1; iteration <= maxSweeps && current.stale.total > 0; iteration += 1) {
    let sweep = await runDataQualityRemediationSweep(queueOnlyDatabase, {
      seedLimit: 1,
      claimLimit: 1,
      leaseSeconds: 900,
    });

    // Existing durable work can be exhausted before every current stale signal has a queue row.
    // Seed once through the real database only at that boundary, while retaining one-listing claims.
    if (sweep.claimed === 0) {
      sweep = await runDataQualityRemediationSweep(database, {
        seedLimit: 250,
        claimLimit: 1,
        leaseSeconds: 900,
      });
    }

    current = await replayStatus(database);
    console.log(
      `iteration=${iteration} claimed=${sweep.claimed} resolved=${sweep.resolved} retried=${sweep.retried} stale=${current.stale.total}`,
    );

    if (current.queue.failed > initialFailed) {
      throw new Error(
        `A remediation job moved to failed while draining: initial=${initialFailed} current=${current.queue.failed}`,
      );
    }
    if (sweep.claimed === 0 && current.stale.total > 0) {
      throw new Error(
        `No remediation job is claimable while ${current.stale.total} stale signals remain after queue top-up`,
      );
    }
  }

  const final = current.stale.total === 0 ? current : await replayStatus(database);
  if (final.queue.failed > initialFailed) {
    throw new Error(
      `Resolver replay introduced failed queue jobs: initial=${initialFailed} final=${final.queue.failed}`,
    );
  }

  const result: DrainResult = {
    compacted,
    complete: final.stale.total === 0,
    remaining: final.stale.total,
    initial,
    final,
  };
  await writeResult(output, result);
  console.log("Final replay status for this batch:");
  console.log(JSON.stringify(final, null, 2));
}

await main();
