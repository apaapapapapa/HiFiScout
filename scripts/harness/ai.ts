import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  aiSnapshotFingerprint,
  buildAiRequest,
  validateAiSelection,
  parseAiSnapshot,
} from "../../src/ai-suggestions/contract.js";
import { evaluateAiResponses } from "../../src/ai-suggestions/evaluation.js";
import { AI_CATALOG_POLICY, AI_CATALOG_POLICY_KEY } from "../../src/ai-suggestions/policy.js";
import { identityModelParts } from "../../src/catalog/product-identity.js";
import { isRecord } from "../../src/types.js";
import { aiCatalogEvaluationCases } from "../../test/fixtures/ai-catalog-evaluation.js";
import {
  aiCatalogHoldoutCases,
  AI_HOLDOUT_VERSION,
} from "../../test/fixtures/ai-catalog-holdout.js";
import { readCheckout } from "./checkpoint.js";
import { repositoryArtifact } from "./artifacts.js";
import { assessHarnessReport, requireSha, requireText, requireTimestamp } from "./report.js";

export const aiResponseDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const aiHoldoutDigest = () =>
  aiResponseDigest({ version: AI_HOLDOUT_VERSION, cases: aiCatalogHoldoutCases });
const abstain = { decision: "no_suggestion", catalogProductId: null, evidence: [] };

export function assertHoldoutIsolation() {
  const keys = (snapshot: (typeof aiCatalogHoldoutCases)[number]["snapshot"]) =>
    [
      snapshot.target.model,
      ...snapshot.target.rawModels,
      ...snapshot.candidates.map((item) => item.model),
    ].map((model) => `${snapshot.target.manufacturerId}/${identityModelParts(model).modelStem}`);
  const development = new Set(aiCatalogEvaluationCases.flatMap((item) => keys(item.snapshot)));
  if (aiCatalogHoldoutCases.some((item) => keys(item.snapshot).some((key) => development.has(key))))
    throw new Error("holdout_overlaps_development_family");
  if (new Set(aiCatalogHoldoutCases.map((item) => item.id)).size !== aiCatalogHoldoutCases.length)
    throw new Error("duplicate_holdout_case");
}

function admission(snapshot: (typeof aiCatalogHoldoutCases)[number]["snapshot"]) {
  if (!parseAiSnapshot(snapshot)) throw new Error("invalid_holdout_snapshot");
  try {
    return { request: buildAiRequest(snapshot), reason: null };
  } catch (error) {
    return { request: null, reason: error instanceof Error ? error.message : "admission_failed" };
  }
}

export async function aiRecordingTemplate() {
  assertHoldoutIsolation();
  return {
    schemaVersion: 1,
    corpusVersion: AI_HOLDOUT_VERSION,
    corpusDigest: aiHoldoutDigest(),
    policyKey: AI_CATALOG_POLICY_KEY,
    sourceSha: readCheckout().sourceSha,
    provenance: "fixture",
    groundTruthReview: null,
    cases: await Promise.all(
      aiCatalogHoldoutCases.map(async (item) => ({
        id: item.id,
        fingerprint: await aiSnapshotFingerprint(item.snapshot),
        ...admission(item.snapshot),
        attempts: [],
        review: null,
      })),
    ),
  };
}

function nullableMeasurement(value: unknown, label: string, integer = false): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(`invalid_${label}`);
  return value;
}

/** Replay recorded wire responses through the actual runtime admission and output contract. */
export async function evaluateAiHoldout(value: unknown) {
  assertHoldoutIsolation();
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.corpusVersion !== AI_HOLDOUT_VERSION ||
    value.corpusDigest !== aiHoldoutDigest() ||
    value.policyKey !== AI_CATALOG_POLICY_KEY ||
    !["fixture", "recorded-provider"].includes(String(value.provenance)) ||
    !Array.isArray(value.cases)
  )
    throw new Error("invalid_ai_policy_or_corpus");
  const sourceSha = requireSha(value.sourceSha);
  const recording = new Map<string, Record<string, unknown>>();
  for (const entry of value.cases) {
    if (!isRecord(entry) || typeof entry.id !== "string" || recording.has(entry.id))
      throw new Error("invalid_ai_recording_case");
    recording.set(entry.id, entry);
  }
  if (
    recording.size !== aiCatalogHoldoutCases.length ||
    aiCatalogHoldoutCases.some((item) => !recording.has(item.id))
  )
    throw new Error("incomplete_ai_holdout");
  let groundTruthReviewed = false;
  if (value.groundTruthReview !== null) {
    const review = value.groundTruthReview;
    if (!isRecord(review) || review.corpusDigest !== aiHoldoutDigest())
      throw new Error("stale_ground_truth_review");
    requireText(review.actor, "review_actor");
    requireTimestamp(review.reviewedAt);
    groundTruthReviewed = true;
  }
  const results = [];
  const completedCases = [],
    responses: unknown[] = [],
    modelCases = [],
    modelResponses: unknown[] = [];
  let accepted = 0,
    rejected = 0,
    pending = 0,
    falseAccepted = 0;
  let inputTokens: number | null = 0,
    outputTokens: number | null = 0,
    neurons: number | null = 0;
  let attempts = 0,
    invalidAttempts = 0,
    missingResponses = 0;
  const providerIds = new Set<string>();
  const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
  for (const item of aiCatalogHoldoutCases) {
    const entry = recording.get(item.id)!;
    const fingerprint = await aiSnapshotFingerprint(item.snapshot);
    const expected = admission(item.snapshot);
    if (
      entry.fingerprint !== fingerprint ||
      aiResponseDigest(entry.request) !== aiResponseDigest(expected.request) ||
      entry.reason !== expected.reason ||
      !Array.isArray(entry.attempts) ||
      entry.attempts.length > AI_CATALOG_POLICY.maxAttempts
    )
      throw new Error(`stale_ai_request: ${item.id}`);
    if (!expected.request && entry.attempts.length) throw new Error("inference_bypassed_admission");
    let response: unknown = abstain;
    let finalId: number | null = null,
      finalValid = true;
    const latencies: (number | null)[] = [];
    let lastWire: unknown = null;
    let lastRequestedAt: string | null = null;
    for (const attempt of entry.attempts) {
      if (
        !isRecord(attempt) ||
        attempt.model !== AI_CATALOG_POLICY.model ||
        !isRecord(attempt.usage)
      )
        throw new Error("invalid_ai_attempt");
      lastRequestedAt = requireTimestamp(attempt.requestedAt);
      if (attempt.requestId !== null) {
        const requestId = requireText(attempt.requestId, "provider_request_id");
        if (providerIds.has(requestId)) throw new Error("duplicate_provider_request_id");
        providerIds.add(requestId);
      }
      const input = nullableMeasurement(attempt.usage.inputTokens, "input_tokens", true);
      const output = nullableMeasurement(attempt.usage.outputTokens, "output_tokens", true);
      const used = nullableMeasurement(attempt.usage.neurons, "neurons");
      if (
        (input !== null && input > AI_CATALOG_POLICY.maxInputTokens) ||
        (output !== null && output > AI_CATALOG_POLICY.maxOutputTokens)
      )
        throw new Error("recorded_ai_usage_exceeds_policy");
      latencies.push(nullableMeasurement(attempt.latencyMs, "latency_ms"));
      inputTokens = sum(inputTokens, input);
      outputTokens = sum(outputTokens, output);
      neurons = sum(neurons, used);
      attempts++;
      lastWire = attempt.response;
      try {
        const validated = validateAiSelection(item.snapshot, attempt.response);
        response = validated;
        finalId = validated.catalogProductId;
        finalValid = true;
      } catch {
        response = "invalid recorded response";
        finalValid = false;
        finalId = null;
        invalidAttempts++;
      }
    }
    const complete = !expected.request || entry.attempts.length > 0;
    if (complete) {
      completedCases.push(item);
      responses.push(response);
      if (entry.attempts.length) {
        modelCases.push(item);
        modelResponses.push(response);
      }
    } else missingResponses++;
    if (entry.review === null) {
      if (complete && finalValid && finalId !== null) pending++;
    } else {
      const review = entry.review;
      if (
        !complete ||
        !isRecord(review) ||
        review.fingerprint !== fingerprint ||
        review.responseDigest !== aiResponseDigest(lastWire) ||
        !["accepted", "rejected"].includes(String(review.decision))
      )
        throw new Error("stale_or_invalid_ai_review");
      requireText(review.actor, "review_actor");
      requireText(review.reason, "review_reason");
      const reviewedAt = requireTimestamp(review.reviewedAt);
      if (lastRequestedAt && reviewedAt < lastRequestedAt)
        throw new Error("review_precedes_inference");
      if (review.decision === "accepted") {
        if (!entry.attempts.length || !finalValid || finalId === null)
          throw new Error("review_cannot_accept_missing_suggestion");
        accepted++;
        if (finalId !== item.expectedCatalogProductId) falseAccepted++;
      } else rejected++;
    }
    results.push({
      id: item.id,
      family: item.family,
      expectedCatalogProductId: item.expectedCatalogProductId,
      actualCatalogProductId: complete ? finalId : null,
      complete,
      finalValid,
      route: expected.request ? "model" : "deterministic",
      admissionReason: expected.reason,
      attempts: entry.attempts.length,
      latencyMs: latencies,
      review: entry.review,
    });
  }
  const pipeline = completedCases.length ? evaluateAiResponses(completedCases, responses) : null;
  const modelOnly = modelCases.length ? evaluateAiResponses(modelCases, modelResponses) : null;
  return {
    schemaVersion: 1,
    sourceSha,
    corpusVersion: AI_HOLDOUT_VERSION,
    corpusDigest: aiHoldoutDigest(),
    policy: AI_CATALOG_POLICY,
    provenance: value.provenance,
    inferenceExecuted: false,
    responseProvenanceVerified: false,
    reviewProvenanceVerified: false,
    activationApproved: false,
    groundTruthReviewed,
    totalCases: aiCatalogHoldoutCases.length,
    families: new Set(aiCatalogHoldoutCases.map((item) => item.family)).size,
    deterministicCases: results.filter((item) => item.route === "deterministic").length,
    modelCases: modelCases.length,
    missingResponses,
    pipeline,
    modelOnly,
    attempts,
    invalidAttempts,
    usage: { inputTokens, outputTokens, neurons },
    reviewerOutcomes: {
      accepted,
      rejected,
      pending,
      falseAccepted,
      acceptanceRate: accepted + rejected ? accepted / (accepted + rejected) : null,
    },
    status:
      falseAccepted || invalidAttempts || pipeline?.falseSuggestions
        ? ("fail" as const)
        : missingResponses
          ? ("unknown" as const)
          : pipeline?.passed
            ? ("pass" as const)
            : ("fail" as const),
    liveEvaluationStatus: "unknown",
    results,
  };
}

export async function runAiHoldout(recordingPath: string, directory: string) {
  const startedAt = new Date().toISOString(),
    checkout = readCheckout();
  const recording: unknown = JSON.parse(await readFile(recordingPath, "utf8"));
  const result = await evaluateAiHoldout(recording);
  const current = readCheckout();
  const stable =
    result.sourceSha === checkout.sourceSha &&
    !checkout.dirty &&
    !current.dirty &&
    checkout.sourceSha === current.sourceSha;
  const output = resolve(directory);
  const artifactUri = repositoryArtifact(resolve(output, "evaluation.json"));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(resolve(output, "recording.json"), `${JSON.stringify(recording, null, 2)}\n`);
  await writeFile(resolve(output, "evaluation.json"), `${JSON.stringify(result, null, 2)}\n`);
  const report = assessHarnessReport({
    schemaVersion: 1,
    runId: `ai-holdout-${checkout.sourceSha}`,
    sourceSha: checkout.sourceSha,
    baselineSha: null,
    deploymentSha: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: "ai/offline-holdout",
        required: true,
        scope: "source",
        status: stable ? result.status : "unknown",
        reason: stable
          ? "offline admission/response replay; provider provenance and activation are not approved"
          : "recording_or_checkout_sha_mismatch_or_dirty",
        evidence: [{ uri: artifactUri, sourceSha: result.sourceSha }],
      },
    ],
  });
  await writeFile(resolve(output, "ai-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
