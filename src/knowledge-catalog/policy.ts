/**
 * The queue's decisions, with no I/O.
 *
 * How long to wait before another attempt, whether a failure is worth retrying at all, whether a
 * verification is complete enough to promote — these are the rules a run's behavior actually turns
 * on, so they are kept where they can be read and tested without a database, a queue or a network.
 *
 * Every limit is clamped rather than trusted: these come from deployment variables, and a typo
 * must not remove a lease bound or let one manufacturer consume a whole run.
 */

import type {
  KnowledgeSourceStatus,
  KnowledgeSourceVerification,
} from "../catalog/knowledge-verification/types.js";
import type { KnowledgeCatalogJobType, ProductClassificationStats } from "../db/types.js";
import type { KnowledgeCatalogConfigEnv } from "./types.js";

const DEFAULT_JOB_LEASE_SECONDS = 900;
const DEFAULT_DOMAIN_LEASE_SECONDS = 900;
const DEFAULT_DOMAIN_RETRY_SECONDS = 60;
const DEFAULT_TRANSIENT_MAX_ATTEMPTS = 4;
const DEFAULT_TRANSIENT_RETRY_SECONDS = 300;
const DEFAULT_FINALIZE_RETRY_SECONDS = 300;
const DEFAULT_SOURCE_REQUEST_DELAY_MS = 500;
const DEFAULT_WAKE_MAX_JOBS = 8;
const DEFAULT_WAKE_WALL_BUDGET_MS = 25_000;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

/** Candidates queued by one daily run. */
export function candidateLimit(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES ??
      env.KNOWLEDGE_CATALOG_VERIFY_MAX_CANDIDATES,
    200,
    1,
    2000,
  );
}

/** Verified products re-read by one monthly run. */
export function dueProductLimit(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_VERIFY_MAX_DUE_PRODUCTS, 25, 1, 2000);
}

/** How stale a verified product may be before the monthly run marks it due. */
export function reviewIntervalDays(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS, 30, 1, 3650);
}

/** How long a claimed job stays claimed before another consumer may take it over. */
export function jobLeaseSeconds(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_JOB_LEASE_SECONDS,
    DEFAULT_JOB_LEASE_SECONDS,
    60,
    1800,
  );
}

/** How long one job may hold a manufacturer's domain to itself. */
export function domainLeaseSeconds(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_DOMAIN_LEASE_SECONDS,
    DEFAULT_DOMAIN_LEASE_SECONDS,
    60,
    1800,
  );
}

/** How long a job waits when another job already holds its domain. */
export function domainRetrySeconds(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_DOMAIN_RETRY_SECONDS,
    DEFAULT_DOMAIN_RETRY_SECONDS,
    10,
    900,
  );
}

/** How many times a transient source failure is retried before the outcome is accepted. */
export function transientMaxAttempts(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_TRANSIENT_MAX_ATTEMPTS,
    DEFAULT_TRANSIENT_MAX_ATTEMPTS,
    1,
    10,
  );
}

/** Catalog entries whose listings one finalizer replays after verification. */
export function remediationProductLimit(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_REMEDIATION_MAX_PRODUCTS, 20, 1, 100);
}

/**
 * Logical duplicate sets one finalizer converges. Bounded like every other finalizer sweep so the
 * run stays predictable; whatever is left over is found again by the next run.
 */
export function catalogIdentityConvergenceLimit(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_IDENTITY_CONVERGENCE_MAX_GROUPS, 5, 1, 25);
}

/** Listings replayed per catalog entry in one finalizer invocation. */
export function remediationListingLimit(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_REMEDIATION_MAX_LISTINGS, 100, 1, 250);
}

/** How long the finalizer waits before checking again for outstanding jobs. */
export function finalizeRetrySeconds(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_FINALIZE_RETRY_SECONDS,
    DEFAULT_FINALIZE_RETRY_SECONDS,
    30,
    1800,
  );
}

/** Minimum space between source requests, including the boundary between two durable jobs. */
export function sourceRequestDelayMs(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS,
    DEFAULT_SOURCE_REQUEST_DELAY_MS,
    0,
    60_000,
  );
}

/** Hard cap on durable jobs claimed by one run-level Queue wake-up. */
export function wakeMaxJobs(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_QUEUE_WAKE_MAX_JOBS, DEFAULT_WAKE_MAX_JOBS, 1, 25);
}

/** Wall backstop checked between jobs; the count cap remains authoritative during one job. */
export function wakeWallBudgetMs(env: KnowledgeCatalogConfigEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_WAKE_WALL_BUDGET_MS,
    DEFAULT_WAKE_WALL_BUDGET_MS,
    1_000,
    120_000,
  );
}

export function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * Exponential backoff, capped.
 *
 * A manufacturer's site that is rate-limiting or down needs increasing space, but the cap keeps a
 * job returning within the hour so a run can still finalize the same day.
 */
export function knowledgeCatalogRetryDelaySeconds(
  attempt: number,
  baseSeconds = DEFAULT_TRANSIENT_RETRY_SECONDS,
  maxSeconds = 3600,
): number {
  const safeAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(maxSeconds, baseSeconds * 2 ** (safeAttempt - 1));
}

interface RetryableVerificationInput {
  status?: string;
  message?: string;
  httpStatus?: number | null;
}

/**
 * Whether a failure says "try later" rather than "this is the answer".
 *
 * Only `error` qualifies: `not_found` and `ambiguous` are conclusions about the page, and retrying
 * them would re-fetch the same content for the same result. "Too many subrequests" is excluded
 * because it is the Worker's own limit — the retry would hit it again.
 */
export function isRetryableKnowledgeCatalogVerification(
  verification: RetryableVerificationInput = {},
): boolean {
  if (verification.status !== "error") return false;
  const message = String(verification.message || "").toLowerCase();
  if (message.includes("too many subrequests")) return false;
  const httpStatus = Number(verification.httpStatus || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(httpStatus)) return true;
  return /timeout|timed out|network|fetch failed|connection|econn|temporary|temporarily|rate.?limit|upstream/.test(
    message,
  );
}

/** An unrecognized status is recorded as `error` rather than dropped from the run's counters. */
export function normalizeOutcome(status: unknown): KnowledgeSourceStatus {
  if (
    status === "verified" ||
    status === "not_found" ||
    status === "ambiguous" ||
    status === "unsupported" ||
    status === "error"
  ) {
    return status;
  }
  return "error";
}

/**
 * Whether a verified result carries everything the catalog needs.
 *
 * A verification missing its source, model or primary category would create a catalog row that
 * cannot be rechecked or displayed, so it is treated as ambiguous instead of promoted.
 */
export function validPromotion(verification: KnowledgeSourceVerification): boolean {
  if (verification.status !== "verified") return false;
  const categoryIds = [...new Set(verification.categoryIds)].filter(Boolean);
  return (
    Boolean(verification.sourceUrl) &&
    Boolean(verification.canonicalModel) &&
    Boolean(verification.primaryCategoryId) &&
    categoryIds.includes(verification.primaryCategoryId)
  );
}

/** Order- and duplicate-insensitive comparison, since category order is not part of the meaning. */
export function sameCategorySet(
  left: readonly string[] = [],
  right: readonly string[] = [],
): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * What the run changed, reported as reductions only.
 *
 * Crawls add listings while a review runs, so a category count can legitimately rise; reporting a
 * negative "reduction" would read as the review having made classification worse.
 */
export function classificationImpact(
  beforeClassification: ProductClassificationStats,
  afterClassification: ProductClassificationStats,
) {
  return {
    unclassifiedReduced: Math.max(
      0,
      beforeClassification.unclassifiedProducts - afterClassification.unclassifiedProducts,
    ),
    otherReduced: Math.max(
      0,
      beforeClassification.otherProducts - afterClassification.otherProducts,
    ),
  };
}

/**
 * Job keys are derived, not generated.
 *
 * The queue's insert relies on `ON CONFLICT(job_key) DO NOTHING`, so a redispatch of the same run
 * re-derives the same key and cannot double-queue a target.
 */
export function targetJobKey(
  runId: number,
  jobType: KnowledgeCatalogJobType,
  targetId: number,
): string {
  return `knowledge-catalog:${runId}:${jobType}:${targetId}`;
}

export function finalizerJobKey(runId: number): string {
  return `knowledge-catalog:${runId}:finalize`;
}
