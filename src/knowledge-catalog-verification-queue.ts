import { createKnowledgeSourceVerifier } from "./catalog/knowledge-verification/verifier.js";
import { createRobotsRespectingFetch } from "./crawler/robots-respecting-fetch.js";
import {
  activeProductClassificationStats,
  finishKnowledgeCatalogReviewRunFailure,
  finishKnowledgeCatalogReviewRunSuccess,
  knowledgeCatalogCandidateStats,
  knowledgeCatalogStats,
  markKnowledgeCatalogProductsDue,
  refreshKnowledgeCatalogCandidates,
  startKnowledgeCatalogReviewRun,
} from "./db/knowledge-catalog-review-repository.js";
import { reclassifyProductsFromKnowledgeCatalog } from "./db/knowledge-catalog-repository.js";
import {
  acquireKnowledgeCatalogVerificationDomainLease,
  claimKnowledgeCatalogVerificationJob,
  completeKnowledgeCatalogVerificationJob,
  createKnowledgeCatalogVerificationJobs,
  deadLetterKnowledgeCatalogVerificationJob,
  incrementKnowledgeCatalogVerificationSourceAttempt,
  knowledgeCatalogReviewRunQueueBaseline,
  knowledgeCatalogVerificationRunStats,
  releaseKnowledgeCatalogVerificationDomainLease,
  retryKnowledgeCatalogVerificationJob,
  setKnowledgeCatalogReviewRunQueueBaseline,
} from "./db/knowledge-catalog-verification-queue-repository.js";
import {
  listDueKnowledgeCatalogProducts,
  listPendingKnowledgeCatalogCandidates,
  promoteVerifiedKnowledgeCatalogCandidate,
  recordKnowledgeCatalogCandidateVerification,
  recordKnowledgeCatalogProductRecheckFailure,
  recordKnowledgeCatalogProductRecheckSuccess,
} from "./db/knowledge-catalog-verification-repository.js";
import {
  finishKnowledgeCatalogVerifierVersionFailure,
  finishKnowledgeCatalogVerifierVersionSuccess,
} from "./db/knowledge-catalog-verifier-state-repository.js";
import type {
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceStatus,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
} from "./catalog/types.js";
import type {
  CrawlerEnv,
  KnowledgeCatalogDispatchMode,
  KnowledgeCatalogQueueMessage,
} from "./crawler/types.js";
import type {
  DueKnowledgeCatalogProduct,
  KnowledgeCatalogJobType,
  KnowledgeCatalogVerificationJob,
  KnowledgeCatalogVerificationJobSpec,
  PendingKnowledgeCatalogCandidate,
  ProductClassificationStats,
  QueryableDatabase,
} from "./db/types.js";
import { errorMessage } from "./types.js";

export const KNOWLEDGE_CATALOG_VERIFICATION_QUEUE = "hifiscout-knowledge-verification";
export const KNOWLEDGE_CATALOG_VERIFICATION_DLQ = "hifiscout-knowledge-verification-dlq";

const QUEUE_SEND_BATCH_SIZE = 100;
const DEFAULT_JOB_LEASE_SECONDS = 900;
const DEFAULT_DOMAIN_LEASE_SECONDS = 900;
const DEFAULT_DOMAIN_RETRY_SECONDS = 60;
const DEFAULT_TRANSIENT_MAX_ATTEMPTS = 4;
const DEFAULT_TRANSIENT_RETRY_SECONDS = 300;
const DEFAULT_FINALIZE_RETRY_SECONDS = 300;

interface KnowledgeCatalogQueueEnv extends CrawlerEnv {
  DB: QueryableDatabase;
  KNOWLEDGE_CATALOG_QUEUE: Pick<Queue<KnowledgeCatalogQueueMessage>, "send" | "sendBatch">;
}

interface DispatchOptions {
  now?: Date;
  preferRetries?: boolean;
  verifierVersion?: number;
}

interface DispatchRunOptions extends DispatchOptions {
  mode: KnowledgeCatalogDispatchMode;
}

interface VerificationTargetResult {
  outcome: KnowledgeSourceStatus;
  promoted: number;
  rechecked: number;
  verification: KnowledgeSourceVerification;
}

interface RetryableVerificationInput {
  status?: string;
  message?: string;
  httpStatus?: number | null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function candidateLimit(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES ??
      env.KNOWLEDGE_CATALOG_VERIFY_MAX_CANDIDATES,
    200,
    1,
    2000,
  );
}

function dueProductLimit(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_VERIFY_MAX_DUE_PRODUCTS, 25, 1, 2000);
}

function reviewIntervalDays(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(env.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS, 30, 1, 3650);
}

function jobLeaseSeconds(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_JOB_LEASE_SECONDS,
    DEFAULT_JOB_LEASE_SECONDS,
    60,
    1800,
  );
}

function domainLeaseSeconds(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_DOMAIN_LEASE_SECONDS,
    DEFAULT_DOMAIN_LEASE_SECONDS,
    60,
    1800,
  );
}

function domainRetrySeconds(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_DOMAIN_RETRY_SECONDS,
    DEFAULT_DOMAIN_RETRY_SECONDS,
    10,
    900,
  );
}

function transientMaxAttempts(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_TRANSIENT_MAX_ATTEMPTS,
    DEFAULT_TRANSIENT_MAX_ATTEMPTS,
    1,
    10,
  );
}

function finalizeRetrySeconds(env: KnowledgeCatalogQueueEnv): number {
  return boundedInteger(
    env.KNOWLEDGE_CATALOG_QUEUE_FINALIZE_RETRY_SECONDS,
    DEFAULT_FINALIZE_RETRY_SECONDS,
    30,
    1800,
  );
}

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function knowledgeCatalogRetryDelaySeconds(
  attempt: number,
  baseSeconds = DEFAULT_TRANSIENT_RETRY_SECONDS,
  maxSeconds = 3600,
): number {
  const safeAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(maxSeconds, baseSeconds * 2 ** (safeAttempt - 1));
}

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

function sourceFetcher(
  env: KnowledgeCatalogQueueEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return createRobotsRespectingFetch(fetchImpl, {
    userAgent: env.CRAWLER_USER_AGENT || "HiFiScoutBot/0.1",
    minimumDelayMs: Number(env.KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS) || 500,
  });
}

function createVerifier(
  env: KnowledgeCatalogQueueEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): KnowledgeSourceVerifier {
  return createKnowledgeSourceVerifier(env, {
    fetchImpl: sourceFetcher(env, fetchImpl),
    fallbackEnabled: true,
  });
}

function sourceHostname(
  verifier: KnowledgeSourceVerifier,
  manufacturerId: string,
  sourceUrl = "",
): string {
  if (sourceUrl) {
    try {
      return new URL(sourceUrl).hostname.toLowerCase();
    } catch {}
  }
  const definitions = verifier?.definitions?.get(String(manufacturerId || "").toLowerCase()) || [];
  for (const definition of definitions) {
    try {
      const hostname = new URL(definition.baseUrl).hostname.toLowerCase();
      if (hostname) return hostname;
    } catch {}
  }
  return `manufacturer-${String(manufacturerId || "unknown").toLowerCase()}`;
}

function validPromotion(verification: KnowledgeSourceVerification): boolean {
  if (verification.status !== "verified") return false;
  const categoryIds = [...new Set(verification.categoryIds)].filter(Boolean);
  return (
    Boolean(verification.sourceUrl) &&
    Boolean(verification.canonicalModel) &&
    Boolean(verification.primaryCategoryId) &&
    categoryIds.includes(verification.primaryCategoryId)
  );
}

function normalizeOutcome(status: unknown): KnowledgeSourceStatus {
  if (
    status === "verified" ||
    status === "not_found" ||
    status === "ambiguous" ||
    status === "unsupported" ||
    status === "error"
  )
    return status;
  return "error";
}

async function verifyCandidateTarget(
  env: KnowledgeCatalogQueueEnv,
  candidate: PendingKnowledgeCatalogCandidate,
  verifier: KnowledgeSourceVerifier,
  attemptedAt: string,
): Promise<VerificationTargetResult> {
  const verification = await verifier.verifyCandidate(candidate);
  if (verification.status !== "verified") {
    await recordKnowledgeCatalogCandidateVerification(env.DB, candidate, verification, attemptedAt);
    return {
      outcome: normalizeOutcome(verification.status),
      promoted: 0,
      rechecked: 0,
      verification,
    };
  }

  if (!validPromotion(verification)) {
    const result: FailedKnowledgeSource = {
      ...verification,
      status: "ambiguous",
      message: "verified_result_missing_required_identity_or_primary_category",
    };
    await recordKnowledgeCatalogCandidateVerification(env.DB, candidate, result, attemptedAt);
    return { outcome: "ambiguous", promoted: 0, rechecked: 0, verification: result };
  }

  const promotion = await promoteVerifiedKnowledgeCatalogCandidate(
    env.DB,
    candidate,
    verification,
    attemptedAt,
  );
  if (promotion.promoted || promotion.reason === "already_exists") {
    return {
      outcome: "verified",
      promoted: promotion.promoted ? 1 : 0,
      rechecked: 0,
      verification,
    };
  }
  const outcome = ["identity_changed", "rejected_catalog_identity"].includes(promotion.reason)
    ? "ambiguous"
    : "error";
  return {
    outcome,
    promoted: 0,
    rechecked: 0,
    verification: {
      ...verification,
      status: outcome,
      message: promotion.reason || "catalog_promotion_failed",
    },
  };
}

function sameCategorySet(left: readonly string[] = [], right: readonly string[] = []): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function verifyProductRecheckTarget(
  env: KnowledgeCatalogQueueEnv,
  product: DueKnowledgeCatalogProduct,
  verifier: KnowledgeSourceVerifier,
  attemptedAt: string,
): Promise<VerificationTargetResult> {
  const verification = await verifier.verifyStoredSource(product);
  const categoriesStillMatch =
    verification.status === "verified" &&
    verification.primaryCategoryId === product.primaryCategoryId &&
    sameCategorySet(verification.categoryIds, product.categoryIds);
  if (categoriesStillMatch) {
    await recordKnowledgeCatalogProductRecheckSuccess(env.DB, product, verification, attemptedAt);
    return { outcome: "verified", promoted: 0, rechecked: 1, verification };
  }

  const result: KnowledgeSourceVerification =
    verification.status === "verified"
      ? {
          ...verification,
          status: "ambiguous",
          message: "official_category_changed_since_last_verification",
        }
      : verification;
  await recordKnowledgeCatalogProductRecheckFailure(env.DB, product, result, attemptedAt);
  return {
    outcome: normalizeOutcome(result.status),
    promoted: 0,
    rechecked: 0,
    verification: result,
  };
}

function targetJobKey(runId: number, jobType: KnowledgeCatalogJobType, targetId: number): string {
  return `knowledge-catalog:${runId}:${jobType}:${targetId}`;
}

function finalizerJobKey(runId: number): string {
  return `knowledge-catalog:${runId}:finalize`;
}

async function sendTargetMessages(
  env: KnowledgeCatalogQueueEnv,
  messages: readonly KnowledgeCatalogQueueMessage[],
): Promise<number> {
  let failed = 0;
  for (let index = 0; index < messages.length; index += QUEUE_SEND_BATCH_SIZE) {
    const chunk = messages.slice(index, index + QUEUE_SEND_BATCH_SIZE);
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.sendBatch(chunk.map((body) => ({ body })));
    } catch (error) {
      const finishedAt = new Date().toISOString();
      failed += chunk.length;
      for (const body of chunk) {
        await deadLetterKnowledgeCatalogVerificationJob(
          env.DB,
          body.jobId,
          `queue_enqueue_failed:${errorMessage(error)}`,
          finishedAt,
        );
      }
    }
  }
  return failed;
}

async function dispatchKnowledgeCatalogVerificationRun(
  env: KnowledgeCatalogQueueEnv,
  { now = new Date(), mode, preferRetries = false, verifierVersion = 0 }: DispatchRunOptions,
) {
  if (!env.KNOWLEDGE_CATALOG_QUEUE?.sendBatch || !env.KNOWLEDGE_CATALOG_QUEUE?.send) {
    throw new Error("knowledge_catalog_queue_binding_missing");
  }

  const startedAt = now.toISOString();
  const runId = await startKnowledgeCatalogReviewRun(env.DB, startedAt);
  try {
    const beforeClassification = await activeProductClassificationStats(env.DB);
    await setKnowledgeCatalogReviewRunQueueBaseline(
      env.DB,
      runId,
      beforeClassification,
      `${mode}: queue dispatch started`,
    );
    if (mode === "monthly_recheck") {
      await markKnowledgeCatalogProductsDue(env.DB, startedAt, reviewIntervalDays(env));
    }
    await refreshKnowledgeCatalogCandidates(env.DB, startedAt);

    const verifier = createVerifier(env);
    const supportedManufacturerIds = [...verifier.definitions.keys()];
    const targets =
      mode === "monthly_recheck"
        ? await listDueKnowledgeCatalogProducts(env.DB, dueProductLimit(env))
        : await listPendingKnowledgeCatalogCandidates(
            env.DB,
            candidateLimit(env),
            supportedManufacturerIds,
            { preferRetries },
          );
    const jobType: KnowledgeCatalogJobType =
      mode === "monthly_recheck" ? "product_recheck" : "candidate";
    const jobSpecs: KnowledgeCatalogVerificationJobSpec[] = targets.map((target) => ({
      jobKey: targetJobKey(runId, jobType, target.id),
      jobType,
      targetId: target.id,
      manufacturerId: target.manufacturerId,
      hostname: sourceHostname(verifier, target.manufacturerId, target.sourceUrl || ""),
    }));
    jobSpecs.push({
      jobKey: finalizerJobKey(runId),
      jobType: "finalize",
      targetId: null,
      manufacturerId: "",
      hostname: "",
    });
    const jobs = await createKnowledgeCatalogVerificationJobs(env.DB, runId, jobSpecs, startedAt);
    const byKey = new Map(jobs.map((job) => [job.jobKey, job]));
    const targetMessages = targets.map((target) => {
      const job = byKey.get(targetJobKey(runId, jobType, target.id));
      if (!job) throw new Error(`knowledge_catalog_job_missing:${target.id}`);
      return {
        jobId: job.id,
        runId,
        jobType,
        mode,
        preferRetries,
        verifierVersion,
        hostname: job.hostname,
        target,
      };
    });
    const enqueueFailures = await sendTargetMessages(env, targetMessages);
    const finalizer = byKey.get(finalizerJobKey(runId));
    if (!finalizer) throw new Error("knowledge_catalog_finalizer_job_missing");
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.send(
        {
          jobId: finalizer.id,
          runId,
          jobType: "finalize",
          mode,
          preferRetries,
          verifierVersion,
        },
        { delaySeconds: 60 },
      );
    } catch (error) {
      const finishedAt = new Date().toISOString();
      await deadLetterKnowledgeCatalogVerificationJob(
        env.DB,
        finalizer.id,
        `finalizer_enqueue_failed:${errorMessage(error)}`,
        finishedAt,
      );
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        runId,
        finishedAt,
        "knowledge_catalog_finalizer_enqueue_failed",
      );
      if (verifierVersion > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          verifierVersion,
          finishedAt,
          "knowledge_catalog_finalizer_enqueue_failed",
        );
      }
      throw error;
    }

    const result = {
      status: "queued",
      mode,
      runId,
      queuedTargets: targetMessages.length - enqueueFailures,
      enqueueFailures,
      candidateTargets: jobType === "candidate" ? targets.length : 0,
      productRecheckTargets: jobType === "product_recheck" ? targets.length : 0,
      verifierVersion,
    };
    console.log(JSON.stringify({ event: "knowledge_catalog_queue_dispatched", ...result }));
    return result;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const row = await env.DB.prepare(
      "SELECT status FROM knowledge_catalog_review_runs WHERE id = ?",
    )
      .bind(runId)
      .first();
    if (row?.status === "running") {
      await finishKnowledgeCatalogReviewRunFailure(env.DB, runId, finishedAt, errorMessage(error));
    }
    if (verifierVersion > 0) {
      await finishKnowledgeCatalogVerifierVersionFailure(
        env.DB,
        verifierVersion,
        finishedAt,
        errorMessage(error),
      );
    }
    throw error;
  }
}

export function dispatchKnowledgeCatalogDailyVerification(
  env: KnowledgeCatalogQueueEnv,
  options: DispatchOptions = {},
) {
  return dispatchKnowledgeCatalogVerificationRun(env, { ...options, mode: "daily_candidates" });
}

export function dispatchKnowledgeCatalogMonthlyRecheck(
  env: KnowledgeCatalogQueueEnv,
  options: DispatchOptions = {},
) {
  return dispatchKnowledgeCatalogVerificationRun(env, { ...options, mode: "monthly_recheck" });
}

function classificationImpact(
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

async function finalizeKnowledgeCatalogVerificationRun(
  env: KnowledgeCatalogQueueEnv,
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
) {
  const now = new Date();
  const stats = await knowledgeCatalogVerificationRunStats(env.DB, body.runId);
  if (stats.outstanding > 0) {
    const delaySeconds = finalizeRetrySeconds(env);
    await retryKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      addSeconds(now, delaySeconds),
      `waiting_for_${stats.outstanding}_verification_jobs`,
      now.toISOString(),
    );
    message.retry({ delaySeconds });
    return { status: "retrying", reason: "verification_jobs_outstanding", ...stats };
  }

  const beforeClassification = await knowledgeCatalogReviewRunQueueBaseline(env.DB, body.runId);
  const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(env.DB);
  const [candidateResult, catalogResult, afterClassification] = await Promise.all([
    knowledgeCatalogCandidateStats(env.DB),
    knowledgeCatalogStats(env.DB),
    activeProductClassificationStats(env.DB),
  ]);
  const impact = classificationImpact(beforeClassification, afterClassification);
  const finishedAt = new Date().toISOString();
  const verificationFailures =
    stats.outcomes.notFound + stats.outcomes.ambiguous + stats.outcomes.error;
  const result = {
    status: "success",
    mode: body.mode || "daily_candidates",
    finishedAt,
    ...catalogResult,
    ...candidateResult,
    verificationAttempts: stats.sourceAttempts,
    verifiedPromotions: stats.promoted,
    verifiedRechecks: stats.rechecked,
    verificationFailures,
    unsupportedCandidates: stats.outcomes.unsupported,
    verificationOutcomes: stats.outcomes,
    dueProductsChecked: stats.productRecheckJobs,
    candidatesChecked: stats.candidateJobs,
    retryFirst: Boolean(body.preferRetries),
    beforeClassification,
    afterClassification,
    ...impact,
    reclassifiedProducts,
    message: `${body.mode || "daily_candidates"}: ${stats.promoted} catalog promotions, ${stats.rechecked} source rechecks, ${candidateResult.pendingCandidates} pending candidates, ${impact.unclassifiedReduced} unclassified and ${impact.otherReduced} other listings reduced via queue`,
  };
  await finishKnowledgeCatalogReviewRunSuccess(env.DB, body.runId, result);
  if (Number(body.verifierVersion || 0) > 0) {
    await finishKnowledgeCatalogVerifierVersionSuccess(
      env.DB,
      Number(body.verifierVersion),
      finishedAt,
      result.message,
    );
  }
  await completeKnowledgeCatalogVerificationJob(
    env.DB,
    job.id,
    { outcome: "skipped", message: "queue_run_finalized" },
    finishedAt,
  );
  message.ack();
  console.log(
    JSON.stringify({ event: "knowledge_catalog_queue_finalized", runId: body.runId, ...result }),
  );
  return result;
}

async function retrySourceJob(
  env: KnowledgeCatalogQueueEnv,
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
  result: VerificationTargetResult,
): Promise<boolean> {
  const sourceAttempts = job.sourceAttempts;
  if (
    !isRetryableKnowledgeCatalogVerification(result.verification) ||
    sourceAttempts >= transientMaxAttempts(env)
  ) {
    return false;
  }
  const delaySeconds = knowledgeCatalogRetryDelaySeconds(sourceAttempts);
  const now = new Date();
  await retryKnowledgeCatalogVerificationJob(
    env.DB,
    job.id,
    addSeconds(now, delaySeconds),
    result.verification.message || `transient_${result.outcome}`,
    now.toISOString(),
  );
  message.retry({ delaySeconds });
  console.warn(
    JSON.stringify({
      event: "knowledge_catalog_queue_source_retry",
      runId: body.runId,
      jobId: job.id,
      targetId: body.target?.id || null,
      sourceAttempts,
      delaySeconds,
      message: result.verification.message || "",
    }),
  );
  return true;
}

function isPendingCandidate(
  target: KnowledgeSourceCandidate | undefined,
): target is PendingKnowledgeCatalogCandidate {
  return Boolean(
    target &&
    typeof target.id === "number" &&
    target.manufacturerId &&
    target.normalizedModel &&
    target.observedManufacturer !== undefined &&
    target.observedModel !== undefined,
  );
}

function isDueProduct(
  target: KnowledgeSourceCandidate | undefined,
): target is DueKnowledgeCatalogProduct {
  return Boolean(
    target &&
    typeof target.id === "number" &&
    target.manufacturerId &&
    target.normalizedModel &&
    target.canonicalModel &&
    target.canonicalName &&
    typeof target.sourceId === "number" &&
    target.sourceType &&
    target.sourceUrl &&
    Array.isArray(target.categoryIds),
  );
}

async function consumeSourceJob(
  env: KnowledgeCatalogQueueEnv,
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
) {
  const now = new Date();
  const hostname = body.hostname || job.hostname;
  const acquired = await acquireKnowledgeCatalogVerificationDomainLease(
    env.DB,
    hostname,
    job.id,
    now.toISOString(),
    domainLeaseSeconds(env),
  );
  if (!acquired) {
    const delaySeconds = domainRetrySeconds(env);
    await retryKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      addSeconds(now, delaySeconds),
      `domain_busy:${hostname}`,
      now.toISOString(),
    );
    message.retry({ delaySeconds });
    return { status: "retrying", reason: "domain_busy", hostname };
  }

  try {
    const sourceAttempts = await incrementKnowledgeCatalogVerificationSourceAttempt(
      env.DB,
      job.id,
      now.toISOString(),
    );
    job.sourceAttempts = sourceAttempts;
    const verifier = createVerifier(env);
    let result: VerificationTargetResult;
    if (body.jobType === "product_recheck") {
      if (!isDueProduct(body.target)) throw new Error("invalid_product_recheck_target");
      result = await verifyProductRecheckTarget(env, body.target, verifier, now.toISOString());
    } else {
      if (!isPendingCandidate(body.target)) throw new Error("invalid_candidate_target");
      result = await verifyCandidateTarget(env, body.target, verifier, now.toISOString());
    }
    if (await retrySourceJob(env, body, message, job, result)) return { status: "retrying" };

    const finishedAt = new Date().toISOString();
    await completeKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      {
        outcome: result.outcome,
        promoted: result.promoted,
        rechecked: result.rechecked,
        message: result.verification.message || "",
      },
      finishedAt,
    );
    message.ack();
    console.log(
      JSON.stringify({
        event: "knowledge_catalog_queue_job_completed",
        runId: body.runId,
        jobId: job.id,
        jobType: body.jobType,
        targetId: body.target?.id || null,
        manufacturerId: body.target?.manufacturerId || "",
        outcome: result.outcome,
        sourceAttempts,
      }),
    );
    return { status: "completed", outcome: result.outcome };
  } finally {
    await releaseKnowledgeCatalogVerificationDomainLease(env.DB, hostname, job.id);
  }
}

export async function consumeKnowledgeCatalogVerificationMessage(
  env: KnowledgeCatalogQueueEnv,
  message: Message<KnowledgeCatalogQueueMessage>,
) {
  const body = message.body;
  const jobId = Number(body.jobId || 0);
  const runId = Number(body.runId || 0);
  if (!jobId || !runId || !["candidate", "product_recheck", "finalize"].includes(body.jobType)) {
    console.error(JSON.stringify({ event: "knowledge_catalog_queue_invalid_message", body }));
    message.ack();
    return { status: "ignored", reason: "invalid_message" };
  }

  const now = new Date();
  const job = await claimKnowledgeCatalogVerificationJob(
    env.DB,
    jobId,
    now.toISOString(),
    jobLeaseSeconds(env),
  );
  if (!job) {
    message.ack();
    return { status: "ignored", reason: "job_not_claimable" };
  }

  try {
    if (body.jobType === "finalize") {
      return await finalizeKnowledgeCatalogVerificationRun(env, body, message, job);
    }
    return await consumeSourceJob(env, body, message, job);
  } catch (error) {
    const delaySeconds = knowledgeCatalogRetryDelaySeconds(
      Math.min(job.deliveryAttempts, transientMaxAttempts(env)),
    );
    const retryableDelivery = job.deliveryAttempts < transientMaxAttempts(env) * 2;
    if (retryableDelivery) {
      const retryAt = new Date();
      await retryKnowledgeCatalogVerificationJob(
        env.DB,
        job.id,
        addSeconds(retryAt, delaySeconds),
        `consumer_error:${errorMessage(error)}`,
        retryAt.toISOString(),
      );
      message.retry({ delaySeconds });
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_queue_consumer_retry",
          runId,
          jobId,
          delaySeconds,
          message: errorMessage(error),
        }),
      );
      return { status: "retrying", reason: "consumer_error" };
    }

    const finishedAt = new Date().toISOString();
    await deadLetterKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      `consumer_error_exhausted:${errorMessage(error)}`,
      finishedAt,
    );
    if (body.jobType === "finalize") {
      await finishKnowledgeCatalogReviewRunFailure(env.DB, runId, finishedAt, errorMessage(error));
      if (Number(body.verifierVersion || 0) > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          Number(body.verifierVersion),
          finishedAt,
          errorMessage(error),
        );
      }
    }
    message.ack();
    return { status: "dead_letter", reason: "consumer_error_exhausted" };
  }
}

export async function consumeKnowledgeCatalogVerificationBatch(
  env: KnowledgeCatalogQueueEnv,
  batch: MessageBatch<KnowledgeCatalogQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    await consumeKnowledgeCatalogVerificationMessage(env, message);
  }
}

export async function consumeKnowledgeCatalogVerificationDeadLetterBatch(
  env: KnowledgeCatalogQueueEnv,
  batch: MessageBatch<KnowledgeCatalogQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const jobId = Number(body.jobId || 0);
    const runId = Number(body.runId || 0);
    const finishedAt = new Date().toISOString();
    if (jobId) {
      await deadLetterKnowledgeCatalogVerificationJob(
        env.DB,
        jobId,
        "queue_delivery_exhausted",
        finishedAt,
      );
    }
    if (body.jobType === "finalize" && runId) {
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        runId,
        finishedAt,
        "knowledge_catalog_finalizer_delivery_exhausted",
      );
      if (Number(body.verifierVersion || 0) > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          Number(body.verifierVersion),
          finishedAt,
          "knowledge_catalog_finalizer_delivery_exhausted",
        );
      }
    }
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_queue_dead_letter",
        runId: runId || null,
        jobId: jobId || null,
        jobType: body.jobType || "unknown",
      }),
    );
    message.ack();
  }
}
