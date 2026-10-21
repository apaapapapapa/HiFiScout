import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { test } from "vite-plus/test";
import {
  claimNextKnowledgeCatalogVerificationJobForRun,
  knowledgeCatalogVerificationRunNextAvailableAt,
  knowledgeCatalogVerificationRunOutstandingJobs,
  knowledgeCatalogVerificationRunWakeState,
} from "../src/db/knowledge-catalog-verification-queue-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { database } from "./helpers/d1-write-budget.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/**
 * The run claim and wake state read a short per-domain candidate list instead of every live job.
 * That is only a cost change if it can never choose differently, so the selectors are checked
 * against the statements they replaced, kept here verbatim as the oracle, on random run states
 * built to reach every branch: free, paced, expired and self-held domains; holders from another
 * run or from no job at all; processing jobs with lapsed or missing leases; retries not yet due;
 * queued jobs available only later or without an availability; the empty hostname; and a
 * finalizer both gated behind live targets and released by their completion.
 */

/** The claim selector at 243fcc4. Binds: run, now, now, now. */
const ORIGINAL_CLAIM = `
        SELECT job.id
        FROM knowledge_catalog_verification_jobs job
        WHERE job.run_id = ?
          AND job.status IN ('queued', 'processing', 'retrying')
          AND (
            (job.status IN ('queued', 'retrying')
              AND (job.available_at IS NULL OR job.available_at <= ?))
            OR (job.status = 'processing'
              AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= ?))
          )
          AND (
            job.job_type <> 'finalize'
            OR NOT EXISTS (
              SELECT 1
              FROM knowledge_catalog_verification_jobs target
              WHERE target.run_id = job.run_id
                AND target.job_type IN ('candidate', 'product_recheck')
                AND target.status IN ('queued', 'processing', 'retrying')
            )
          )
          AND (
            job.hostname = ''
            OR NOT EXISTS (
              SELECT 1
              FROM knowledge_catalog_verification_domain_leases domain_lease
              WHERE domain_lease.hostname = job.hostname
                AND domain_lease.leased_until > ?
                AND domain_lease.job_id <> job.id
            )
          )
        ORDER BY CASE WHEN job.job_type = 'finalize' THEN 1 ELSE 0 END,
                 COALESCE(job.available_at, job.enqueued_at),
                 job.id
        LIMIT 1`;

/** The wake-state read at 243fcc4. Binds: run, run, run, now, now, now, now. */
const ORIGINAL_WAKE = `
      WITH target_state AS (
        SELECT COUNT(*) AS live_targets
        FROM knowledge_catalog_verification_jobs
        WHERE run_id = ?
          AND job_type IN ('candidate', 'product_recheck')
          AND status IN ('queued', 'processing', 'retrying')
      ), eligible_jobs AS (
        SELECT job.*, domain_lease.leased_until AS domain_leased_until,
               domain_lease.job_id AS domain_job_id
        FROM knowledge_catalog_verification_jobs job
        LEFT JOIN knowledge_catalog_verification_domain_leases domain_lease
          ON domain_lease.hostname = job.hostname
        CROSS JOIN target_state
        WHERE job.run_id = ?
          AND job.status IN ('queued', 'processing', 'retrying')
          AND (job.job_type <> 'finalize' OR target_state.live_targets = 0)
      )
      SELECT
        (
          SELECT COUNT(*)
          FROM knowledge_catalog_verification_jobs
          WHERE run_id = ? AND status IN ('queued', 'processing', 'retrying')
        ) AS outstanding_jobs,
        MIN(
          CASE
            WHEN status = 'processing' THEN COALESCE(lease_expires_at, ?)
            WHEN status = 'retrying' AND available_at > ? THEN available_at
            WHEN hostname <> ''
              AND domain_leased_until > ?
              AND domain_job_id <> id THEN domain_leased_until
            ELSE ?
          END
        ) AS next_available_at
      FROM eligible_jobs`;

/**
 * The original wake state's eligible jobs, each with the value its `MIN` took over -- not part of
 * the oracle, only a way to tell which branch decided a trial. Binds: run, run, now x4.
 */
const ORIGINAL_WAKE_PER_JOB = `${ORIGINAL_WAKE.slice(0, ORIGINAL_WAKE.indexOf("      SELECT\n        ("))}
      SELECT id, job_type, status, hostname, available_at, lease_expires_at, domain_leased_until,
             domain_job_id,
          CASE
            WHEN status = 'processing' THEN COALESCE(lease_expires_at, ?)
            WHEN status = 'retrying' AND available_at > ? THEN available_at
            WHEN hostname <> ''
              AND domain_leased_until > ?
              AND domain_job_id <> id THEN domain_leased_until
            ELSE ?
          END AS at
      FROM eligible_jobs`;

const RUN = 2;
const OTHER_RUN = 3;
const T0 = "2026-09-06T00:00:00.000Z";
const NOW = "2026-09-06T00:00:10.000Z";
// Both sides of every comparison, and `NOW` itself for the inclusive and exclusive boundaries.
const TIMES = [
  T0,
  "2026-09-06T00:00:05.000Z",
  NOW,
  "2026-09-06T00:00:15.000Z",
  "2026-09-06T00:01:00.000Z",
];
const LATER = TIMES.slice(3);
// Case variants: hostnames compare BINARY, so "A.test" is a different domain from "a.test".
const HOSTS = ["", "a.test", "A.test", "b.test", "c.test"];
const MODES = ["random", "drained", "self-held", "paced", "stale", "crowded", "backoff"] as const;
type Mode = (typeof MODES)[number];

interface JobSpec {
  runId: number;
  jobType: "candidate" | "product_recheck" | "finalize";
  hostname: string;
  status: "queued" | "processing" | "retrying" | "completed" | "dead_letter";
  enqueuedAt: string;
  availableAt: string | null;
  leaseExpiresAt: string | null;
}

interface LeaseSpec {
  hostname: string;
  /** A job index into the state's jobs, or a literal holder id. */
  holder: { job: number } | { id: number };
  leasedUntil: string;
}

interface RunState {
  mode: Mode;
  jobs: JobSpec[];
  leases: LeaseSpec[];
}

function generator(seed: number) {
  let state = (seed * 2654435761) >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  return { random, pick };
}

function randomState(seed: number): RunState {
  const { random, pick } = generator(seed);
  const mode = MODES[seed % MODES.length]!;
  const jobs: JobSpec[] = [];
  const job = (runId: number, overrides: Partial<JobSpec> = {}): JobSpec => {
    const finalize = random() < 0.1;
    const status = pick(["queued", "queued", "retrying", "processing", "completed", "dead_letter"]);
    const spec: JobSpec = {
      runId,
      jobType: finalize ? "finalize" : pick(["candidate", "product_recheck"]),
      hostname: finalize && random() < 0.7 ? "" : pick(HOSTS),
      status: status as JobSpec["status"],
      enqueuedAt: pick(TIMES),
      availableAt: random() < 0.1 ? null : pick(TIMES),
      leaseExpiresAt: null,
      ...overrides,
    };
    if (spec.status === "processing" && !("leaseExpiresAt" in overrides)) {
      spec.leaseExpiresAt = random() < 0.15 ? null : pick(TIMES);
    } else if (!("leaseExpiresAt" in overrides) && random() < 0.1) {
      spec.leaseExpiresAt = pick(TIMES);
    }
    return spec;
  };
  const crowdedHosts = [pick(HOSTS.slice(1)), pick(HOSTS)];
  const targets = mode === "crowded" ? 8 + Math.floor(random() * 9) : Math.floor(random() * 13);
  for (let index = 0; index < targets; index += 1) {
    if (mode === "drained") {
      jobs.push(
        job(RUN, {
          jobType: pick(["candidate", "product_recheck"]),
          status: pick(["completed", "dead_letter"]),
        }),
      );
    } else if (mode === "crowded") {
      jobs.push(job(RUN, { hostname: pick(crowdedHosts) }));
    } else if (mode === "stale" && random() < 0.4) {
      jobs.push(
        job(RUN, {
          status: "processing",
          leaseExpiresAt: random() < 0.3 ? null : pick(TIMES.slice(0, 3)),
        }),
      );
    } else if (mode === "backoff") {
      // A run's retry tail: most targets wait out a backoff, behind which the finalizer waits too.
      jobs.push(
        random() < 0.85
          ? job(RUN, { jobType: "candidate", status: "retrying", availableAt: pick(LATER) })
          : job(RUN, { jobType: "candidate" }),
      );
    } else {
      jobs.push(job(RUN));
    }
  }
  if (mode === "drained" || mode === "backoff" || random() < 0.5) {
    const finalizers = mode === "drained" && random() < 0.2 ? 2 : 1;
    for (let index = 0; index < finalizers; index += 1) {
      jobs.push(
        job(RUN, {
          jobType: "finalize",
          hostname: random() < 0.8 ? "" : pick(HOSTS),
          ...(mode === "backoff"
            ? { status: "retrying", availableAt: pick(LATER) }
            : { status: pick(["queued", "queued", "retrying", "processing", "completed"]) }),
        }),
      );
    }
  }
  const others = Math.floor(random() * 5);
  for (let index = 0; index < others; index += 1) jobs.push(job(OTHER_RUN));

  const leases: LeaseSpec[] = [];
  const holderFor = (): LeaseSpec["holder"] => {
    const roll = random();
    const otherRun = jobs.flatMap((spec, index) => (spec.runId === OTHER_RUN ? [index] : []));
    if (roll < 0.25 || !jobs.length) return { id: 0 };
    if (roll < 0.45 && otherRun.length) return { job: pick(otherRun) };
    if (roll < 0.9) return { job: Math.floor(random() * jobs.length) };
    return { id: 9999 };
  };
  for (const hostname of HOSTS) {
    if (mode === "paced" && hostname) {
      leases.push({ hostname, holder: { id: 0 }, leasedUntil: pick(LATER) });
      continue;
    }
    if (random() < 0.45) continue;
    leases.push({ hostname, holder: holderFor(), leasedUntil: pick(TIMES) });
  }
  if (mode === "self-held") {
    // A waiting job that still holds its own domain, as a consumer dying between its retry write
    // and its lease release leaves it.
    const waiting = jobs
      .map((spec, index) => ({ spec, index }))
      .filter(
        ({ spec }) =>
          spec.runId === RUN && spec.hostname && ["queued", "retrying"].includes(spec.status),
      );
    if (waiting.length) {
      const chosen = pick(waiting);
      if (random() < 0.7) chosen.spec.availableAt = pick(TIMES.slice(0, 3));
      const lease = {
        hostname: chosen.spec.hostname,
        holder: { job: chosen.index },
        leasedUntil: pick(LATER),
      };
      const existing = leases.findIndex((entry) => entry.hostname === chosen.spec.hostname);
      if (existing >= 0) leases[existing] = lease;
      else leases.push(lease);
    }
  }
  return { mode, jobs, leases };
}

/** The minimal surface both migrated SQLite and workerd D1 offer the differential. */
interface Fixture {
  db: QueryableDatabase;
  reset(): Promise<void>;
  insertJobs(jobs: JobSpec[]): Promise<number[]>;
  insertLeases(
    rows: Array<{ hostname: string; jobId: number; leasedUntil: string }>,
  ): Promise<void>;
  all<T>(sql: string, binds: SQLInputValue[]): Promise<T[]>;
}

const INSERT_JOB = `INSERT INTO knowledge_catalog_verification_jobs
  (run_id, job_key, job_type, hostname, status, enqueued_at, available_at, lease_expires_at,
   created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_LEASE = `INSERT INTO knowledge_catalog_verification_domain_leases
  (hostname, job_id, leased_until, updated_at) VALUES (?, ?, ?, ?)`;
const jobBinds = (spec: JobSpec, key: string): SQLInputValue[] => [
  spec.runId,
  key,
  spec.jobType,
  spec.hostname,
  spec.status,
  spec.enqueuedAt,
  spec.availableAt,
  spec.leaseExpiresAt,
  T0,
  T0,
];

function sqliteFixture(): Fixture {
  const { sqlite, db } = migratedSqlite();
  sqlite.exec(`INSERT INTO knowledge_catalog_review_runs(id, started_at, status)
    VALUES (${RUN}, '${T0}', 'running'), (${OTHER_RUN}, '${T0}', 'running')`);
  const insertJob = sqlite.prepare(INSERT_JOB);
  const insertLease = sqlite.prepare(INSERT_LEASE);
  let key = 0;
  return {
    db,
    async reset() {
      sqlite.exec("DELETE FROM knowledge_catalog_verification_jobs");
      sqlite.exec("DELETE FROM knowledge_catalog_verification_domain_leases");
    },
    async insertJobs(jobs) {
      return jobs.map((spec) =>
        Number(insertJob.run(...jobBinds(spec, `k${(key += 1)}`)).lastInsertRowid),
      );
    },
    async insertLeases(rows) {
      for (const row of rows) insertLease.run(row.hostname, row.jobId, row.leasedUntil, T0);
    },
    async all<T>(sql: string, binds: SQLInputValue[]) {
      return sqlite.prepare(sql).all(...binds) as T[];
    },
  };
}

async function workerdFixture(): Promise<Fixture & { dispose(): Promise<void> }> {
  const { db, dispose } = await database();
  await db
    .prepare(`INSERT INTO knowledge_catalog_review_runs(id, started_at, status)
      VALUES (?, ?, 'running'), (?, ?, 'running')`)
    .bind(RUN, T0, OTHER_RUN, T0)
    .run();
  let key = 0;
  return {
    db,
    dispose,
    async reset() {
      await db.batch([
        db.prepare("DELETE FROM knowledge_catalog_verification_jobs"),
        db.prepare("DELETE FROM knowledge_catalog_verification_domain_leases"),
      ]);
    },
    async insertJobs(jobs) {
      if (!jobs.length) return [];
      const results: D1Result[] = await db.batch(
        jobs.map((spec) => db.prepare(INSERT_JOB).bind(...jobBinds(spec, `k${(key += 1)}`))),
      );
      return results.map((result) => Number(result.meta.last_row_id));
    },
    async insertLeases(rows) {
      if (!rows.length) return;
      await db.batch(
        rows.map((row) =>
          db.prepare(INSERT_LEASE).bind(row.hostname, row.jobId, row.leasedUntil, T0),
        ),
      );
    },
    async all<T>(sql: string, binds: SQLInputValue[]) {
      const result = await db
        .prepare(sql)
        .bind(...binds)
        .all<T>();
      return result.results || [];
    },
  };
}

interface StoredJob {
  id: number;
  run_id: number;
  job_type: string;
  hostname: string;
  status: string;
  available_at: string | null;
  enqueued_at: string;
  lease_expires_at: string | null;
}

interface StoredLease {
  hostname: string;
  job_id: number;
  leased_until: string;
}

interface WakeRow {
  id: number;
  job_type: string;
  status: string;
  hostname: string;
  available_at: string | null;
  lease_expires_at: string | null;
  domain_leased_until: string | null;
  domain_job_id: number | null;
  at: string;
}

/** Which branch of the original claim decided the trial. */
function claimBranches(winner: StoredJob | undefined, jobs: StoredJob[], leases: StoredLease[]) {
  const activeLease = (hostname: string) =>
    hostname
      ? leases.find((lease) => lease.hostname === hostname && lease.leased_until > NOW)
      : undefined;
  const heldByOther = (job: StoredJob) => {
    const lease = activeLease(job.hostname);
    return lease !== undefined && lease.job_id !== job.id;
  };
  const dueWaiting = jobs.filter(
    (job) =>
      job.run_id === RUN &&
      ["queued", "retrying"].includes(job.status) &&
      job.job_type !== "finalize" &&
      job.available_at !== null &&
      job.available_at <= NOW,
  );
  const branches: string[] = [];
  if (dueWaiting.some(heldByOther)) branches.push("claim:due-job-on-held-domain");
  if (dueWaiting.some((job) => heldByOther(job) && activeLease(job.hostname)?.job_id === 0))
    branches.push("claim:paced-domain");
  if (
    dueWaiting.some((job) => {
      const holder = activeLease(job.hostname)?.job_id;
      return (
        heldByOther(job) && jobs.some((other) => other.id === holder && other.run_id === OTHER_RUN)
      );
    })
  )
    branches.push("claim:held-by-other-run");
  if (!winner) return [...branches, "claim:none"];
  const lease = leases.find((entry) => entry.hostname === winner.hostname);
  if (winner.job_type === "finalize") branches.push("claim:finalizer");
  if (winner.status === "processing")
    branches.push(
      winner.lease_expires_at === null ? "claim:processing-unleased" : "claim:processing-lapsed",
    );
  else if (winner.available_at === null) branches.push("claim:unscheduled");
  else if (!winner.hostname) branches.push("claim:empty-hostname");
  else if (lease && lease.leased_until > NOW && lease.job_id === winner.id)
    branches.push("claim:own-lease");
  else if (lease) branches.push("claim:expired-lease");
  else branches.push("claim:free-domain");
  return branches;
}

/** Which per-job branch of the original wake state supplied the minimum. */
function wakeBranches(rows: WakeRow[], jobs: StoredJob[]) {
  const branches: string[] = [];
  const liveFinalizer = jobs.some(
    (job) =>
      job.run_id === RUN &&
      job.job_type === "finalize" &&
      ["queued", "processing", "retrying"].includes(job.status),
  );
  if (liveFinalizer)
    branches.push(
      rows.some((row) => row.job_type === "finalize")
        ? "wake:finalizer-eligible"
        : "wake:finalizer-gated",
    );
  if (!rows.length) return [...branches, "wake:terminal"];
  const min = rows.reduce((least, row) => (row.at < least ? row.at : least), rows[0]!.at);
  const gatedFinalizerFirst = jobs.some(
    (job) =>
      job.run_id === RUN &&
      job.job_type === "finalize" &&
      job.status === "retrying" &&
      job.available_at !== null &&
      job.available_at > NOW &&
      job.available_at < min &&
      !rows.some((row) => row.id === job.id),
  );
  if (gatedFinalizerFirst) branches.push("wake:gated-finalizer-due-first");
  for (const row of rows.filter((entry) => entry.at === min)) {
    if (row.status === "processing")
      branches.push(
        row.lease_expires_at === null ? "wake:processing-unleased" : "wake:processing-lease",
      );
    else if (row.status === "retrying" && row.available_at !== null && row.available_at > NOW)
      branches.push("wake:retry-later");
    else if (
      row.hostname &&
      row.domain_leased_until !== null &&
      row.domain_leased_until > NOW &&
      row.domain_job_id !== row.id
    )
      branches.push("wake:held-domain");
    else if (row.hostname && row.domain_leased_until !== null && row.domain_leased_until > NOW)
      branches.push("wake:own-lease");
    else if (row.available_at === null) branches.push("wake:unscheduled");
    else if (row.available_at > NOW) branches.push("wake:queued-later");
    else branches.push("wake:due");
  }
  return branches;
}

async function differential(fixture: Fixture, trials: number, firstSeed: number) {
  const counts: Record<string, number> = {};
  for (let trial = 0; trial < trials; trial += 1) {
    const seed = firstSeed + trial;
    const state = randomState(seed);
    await fixture.reset();
    const ids = await fixture.insertJobs(state.jobs);
    await fixture.insertLeases(
      state.leases.map((lease) => ({
        hostname: lease.hostname,
        jobId: "job" in lease.holder ? ids[lease.holder.job]! : lease.holder.id,
        leasedUntil: lease.leasedUntil,
      })),
    );
    const jobs = await fixture.all<StoredJob>(
      "SELECT * FROM knowledge_catalog_verification_jobs ORDER BY id",
      [],
    );
    const leases = await fixture.all<StoredLease>(
      "SELECT * FROM knowledge_catalog_verification_domain_leases ORDER BY hostname",
      [],
    );
    const context = () => JSON.stringify({ seed, mode: state.mode, jobs, leases });

    const [originalWake] = await fixture.all<{
      outstanding_jobs: number;
      next_available_at: string | null;
    }>(ORIGINAL_WAKE, [RUN, RUN, RUN, NOW, NOW, NOW, NOW]);
    const expectedWake = {
      outstandingJobs: Number(originalWake?.outstanding_jobs || 0),
      nextAvailableAt: originalWake?.next_available_at || null,
    };
    assert.deepEqual(
      await knowledgeCatalogVerificationRunWakeState(fixture.db, RUN, NOW),
      expectedWake,
      `wake state differs: ${context()}`,
    );
    assert.equal(
      await knowledgeCatalogVerificationRunNextAvailableAt(fixture.db, RUN, NOW),
      expectedWake.nextAvailableAt,
      `next availability differs: ${context()}`,
    );
    assert.equal(
      await knowledgeCatalogVerificationRunOutstandingJobs(fixture.db, RUN),
      expectedWake.outstandingJobs,
      `outstanding count differs: ${context()}`,
    );
    const [originalClaim] = await fixture.all<{ id: number }>(ORIGINAL_CLAIM, [RUN, NOW, NOW, NOW]);
    // Claiming writes, so it runs last; every trial rebuilds the state.
    const claimed = await claimNextKnowledgeCatalogVerificationJobForRun(fixture.db, RUN, NOW, 60);
    assert.equal(claimed?.id ?? null, originalClaim?.id ?? null, `claim differs: ${context()}`);

    const perJob = await fixture.all<WakeRow>(ORIGINAL_WAKE_PER_JOB, [
      RUN,
      RUN,
      NOW,
      NOW,
      NOW,
      NOW,
    ]);
    const winner = jobs.find((job) => job.id === originalClaim?.id);
    for (const branch of [
      `mode:${state.mode}`,
      ...claimBranches(winner, jobs, leases),
      ...wakeBranches(perJob, jobs),
    ]) {
      counts[branch] = (counts[branch] || 0) + 1;
    }
  }
  return counts;
}

const CLAIM_BRANCHES = [
  "claim:none",
  "claim:finalizer",
  "claim:processing-unleased",
  "claim:processing-lapsed",
  "claim:unscheduled",
  "claim:empty-hostname",
  "claim:own-lease",
  "claim:expired-lease",
  "claim:free-domain",
  "claim:due-job-on-held-domain",
  "claim:paced-domain",
  "claim:held-by-other-run",
];
const WAKE_BRANCHES = [
  "wake:terminal",
  "wake:finalizer-eligible",
  "wake:finalizer-gated",
  "wake:gated-finalizer-due-first",
  "wake:processing-unleased",
  "wake:processing-lease",
  "wake:retry-later",
  "wake:held-domain",
  "wake:own-lease",
  "wake:unscheduled",
  "wake:queued-later",
  "wake:due",
];

test("run claims and wake states match the original selectors on random run states", async () => {
  const trials = Number(process.env.KNOWLEDGE_CATALOG_CLAIM_EQUIVALENCE_TRIALS || 2400);
  const counts = await differential(sqliteFixture(), trials, 1);
  // Every branch must actually decide trials, or the agreement above proves nothing about it.
  for (const branch of [
    ...MODES.map((mode) => `mode:${mode}`),
    ...CLAIM_BRANCHES,
    ...WAKE_BRANCHES,
  ]) {
    assert.ok(
      (counts[branch] || 0) >= 15,
      `${branch} decided only ${counts[branch] || 0} trials: ${JSON.stringify(counts)}`,
    );
  }
}, 120_000);

test("the selectors run under D1 and agree with the original there too", async () => {
  const fixture = await workerdFixture();
  try {
    // Fewer states than the SQLite run: this proves D1 accepts the statements (numbered
    // parameters, the recursive CTE, compound term limits) and evaluates them identically.
    const counts = await differential(fixture, 60, 100_001);
    for (const branch of [
      ...MODES.map((mode) => `mode:${mode}`),
      "claim:none",
      "claim:free-domain",
      "claim:own-lease",
      "wake:terminal",
      "wake:held-domain",
    ]) {
      assert.ok(
        (counts[branch] || 0) > 0,
        `${branch} never decided a workerd trial: ${JSON.stringify(counts)}`,
      );
    }
  } finally {
    await fixture.dispose();
  }
}, 120_000);
