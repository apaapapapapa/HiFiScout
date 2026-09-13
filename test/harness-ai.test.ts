import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import {
  aiRecordingTemplate,
  evaluateAiHoldout,
  aiResponseDigest,
  assertHoldoutIsolation,
  aiHoldoutDigest,
} from "../scripts/harness/ai.js";
import {
  aiCatalogHoldoutCases,
  AI_HOLDOUT_LABEL_REVIEW,
  AI_HOLDOUT_VERSION,
} from "./fixtures/ai-catalog-holdout.js";
import { aiSnapshotFingerprint } from "../src/ai-suggestions/contract.js";
import { AI_CATALOG_POLICY } from "../src/ai-suggestions/policy.js";

test("frozen source review binds every label to the exact holdout snapshot", async () => {
  const review = JSON.parse(
    readFileSync(new URL(`../${AI_HOLDOUT_LABEL_REVIEW}`, import.meta.url), "utf8"),
  );
  assert.equal(review.corpusVersion, AI_HOLDOUT_VERSION);
  assert.equal(review.corpusDigest, aiHoldoutDigest());
  assert.deepEqual(
    review.cases.map((item: { id: string; expectedCatalogProductId: number | null }) => [
      item.id,
      item.expectedCatalogProductId,
    ]),
    aiCatalogHoldoutCases.map((item) => [item.id, item.expectedCatalogProductId]),
  );
  for (const [index, item] of aiCatalogHoldoutCases.entries()) {
    assert.equal(review.cases[index].fingerprint, await aiSnapshotFingerprint(item.snapshot));
  }
});

async function recording() {
  const template = await aiRecordingTemplate();
  return {
    ...template,
    cases: template.cases.map((entry) => {
      const item = aiCatalogHoldoutCases.find((item) => item.id === entry.id)!;
      return {
        ...entry,
        review: null as unknown,
        attempts: entry.request
          ? [
              {
                model: AI_CATALOG_POLICY.model,
                requestId: entry.id,
                requestedAt: "2026-09-13T00:00:00Z",
                response: {
                  catalogProductId: item.expectedCatalogProductId,
                  evidenceIndex: item.expectedCatalogProductId === null ? null : 0,
                },
                usage: { inputTokens: 10 as number | null, outputTokens: 10, neurons: 0.1 },
                latencyMs: 100,
              },
            ]
          : [],
      };
    }),
  };
}

test("holdout replays separate families and separates deterministic vetoes from model measurements", async () => {
  assertHoldoutIsolation();
  const missing = await evaluateAiHoldout(await aiRecordingTemplate());
  assert.equal(missing.status, "unknown");
  const report = await evaluateAiHoldout(await recording());
  assert.equal(report.totalCases, 20);
  assert.equal(report.families, 10);
  assert.equal(report.status, "pass");
  assert.ok(report.deterministicCases > 0 && report.modelCases > 0);
  assert.equal(report.modelOnly?.total, report.modelCases);
  assert.equal(report.attempts, report.modelCases);
  assert.equal(report.pipeline?.total, 20);
  assert.equal(report.inferenceExecuted, false);
  assert.equal(report.responseProvenanceVerified, false);
  assert.equal(report.activationApproved, false);
  assert.equal(report.groundTruthReviewed, false);
});

test("AI evaluation rejects stale fingerprints, policy/request drift, duplicate provider IDs and unsafe wire output", async () => {
  const value = await recording();
  await assert.rejects(
    evaluateAiHoldout({ ...value, policyKey: "changed" }),
    /invalid_ai_policy_or_corpus/u,
  );
  const stale = structuredClone(value);
  stale.cases[0].fingerprint = "old";
  await assert.rejects(evaluateAiHoldout(stale), /stale_ai_request/u);
  const called = value.cases.filter((entry) => entry.attempts.length);
  called[0].attempts[0].usage.inputTokens = null;
  assert.equal((await evaluateAiHoldout(value)).usage.inputTokens, null);
  called[1].attempts[0].requestId = called[0].attempts[0].requestId;
  await assert.rejects(evaluateAiHoldout(value), /duplicate_provider_request_id/u);
  called[1].attempts[0].requestId = called[1].id;
  called[0].attempts[0].response.catalogProductId = 9999;
  const failed = await evaluateAiHoldout(value);
  assert.equal(failed.status, "fail");
  assert.equal(failed.invalidAttempts, 1);
});

test("review outcomes are bound to the actual response and remain distinct from model correctness", async () => {
  const value = await recording();
  const entry = value.cases.find(
    (entry) => entry.attempts[0]?.response.catalogProductId !== null && entry.attempts.length,
  )!;
  entry.review = {
    decision: "accepted",
    actor: "fixture-reviewer",
    reason: "same fixture identity",
    reviewedAt: "2026-09-13T00:01:00Z",
    fingerprint: entry.fingerprint,
    responseDigest: aiResponseDigest(entry.attempts[0].response),
  };
  const report = await evaluateAiHoldout(value);
  assert.equal(report.reviewerOutcomes.accepted, 1);
  assert.equal(report.reviewerOutcomes.acceptanceRate, 1);
  entry.attempts[0].response.evidenceIndex = 1;
  await assert.rejects(evaluateAiHoldout(value), /stale_or_invalid_ai_review/u);
});

test("retry order cannot make an older response final or move the review cutoff backwards", async () => {
  const value = await recording();
  const entry = value.cases.find((item) => item.attempts.length)!;
  entry.attempts[0].requestedAt = "2026-09-13T00:02:00Z";
  entry.attempts.push({
    ...structuredClone(entry.attempts[0]),
    requestId: `${entry.id}-retry`,
    requestedAt: "2026-09-13T00:01:00Z",
  });
  entry.review = {
    decision: "accepted",
    actor: "fixture-reviewer",
    reason: "older response",
    reviewedAt: "2026-09-13T00:01:30Z",
    fingerprint: entry.fingerprint,
    responseDigest: aiResponseDigest(entry.attempts[1].response),
  };
  await assert.rejects(evaluateAiHoldout(value), /ai_attempts_not_chronological/u);
  entry.attempts[1].requestedAt = entry.attempts[0].requestedAt;
  await assert.rejects(evaluateAiHoldout(value), /ai_attempts_not_chronological/u);
  entry.attempts[1].requestedAt = "2026-09-13T00:03:00Z";
  await assert.rejects(evaluateAiHoldout(value), /review_precedes_inference/u);
});
