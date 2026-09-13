import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  aiRecordingTemplate,
  evaluateAiHoldout,
  aiResponseDigest,
  assertHoldoutIsolation,
} from "../scripts/harness/ai.js";
import { aiCatalogHoldoutCases } from "./fixtures/ai-catalog-holdout.js";
import { AI_CATALOG_POLICY } from "../src/ai-suggestions/policy.js";

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
